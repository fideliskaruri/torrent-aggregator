using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Ffmpeg;
using TorrentFlow.Media.Playback;
using TorrentFlow.Media.Tools;

namespace TorrentFlow.Media.Hls;

public sealed class HlsSession
{
    internal HlsSession(string id, string key, string infoHash, string filePath, PlaybackPlan plan, int startSec, string sourceUrl, string outputDir, long now)
    {
        Id = id; Key = key; InfoHash = infoHash; FilePath = filePath; Plan = plan; StartSec = startSec; SourceUrl = sourceUrl;
        OutputDir = outputDir; ManifestPath = Path.Combine(outputDir, "playlist.m3u8"); CreatedAt = now; SpawnedAt = now;
        Source = HlsArgs.SourceKind(sourceUrl);
    }

    public string Id { get; }
    internal string Key { get; }
    public string InfoHash { get; }
    public string FilePath { get; }
    public PlaybackPlan Plan { get; }
    public int StartSec { get; }
    public string Source { get; }
    internal string SourceUrl { get; }
    public string OutputDir { get; }
    public string ManifestPath { get; }
    /// <summary>starting | running | stalled | error | stopped</summary>
    public string State { get; internal set; } = "starting";
    public int Refs { get; internal set; } = 1;
    public long? LastUnrefAt { get; internal set; }
    public string? Error { get; internal set; }
    public long CreatedAt { get; }
    public long SpawnedAt { get; internal set; }
    public long? TimeToFirstSegmentMs { get; internal set; }
    public bool UsedSoftwareFallback { get; internal set; }
    internal IRunningProcess? Process { get; set; }
    internal CancellationTokenSource? Watchdog { get; set; }
    internal int LastSegmentCount { get; set; }
    internal long LastProgressAt { get; set; }

    public bool IsLive => State is "starting" or "running";
}

public sealed record HlsStartResult(HlsSession? Session, string? Error)
{
    public bool Ok => Session is not null;
}

/// <summary>
/// Port of src/lib/media/session.ts: one ffmpeg per (file, audio, offset, source) writing an fMP4 EVENT playlist
/// into <c>.sessions/&lt;id&gt;</c>. Enforces the concurrency cap, the startup/output watchdogs, idle reaping, the
/// hardware→software encoder fallback and orphan cleanup via per-session pid files.
/// </summary>
public sealed partial class HlsSessionManager(
    MediaPaths paths,
    FfmpegLocator binaries,
    IProcessRunner runner,
    IOptions<MediaOptions> options,
    TimeProvider clock,
    ILogger<HlsSessionManager> logger)
{
    public const int StartupTimeoutMs = 45_000;
    public const int OutputStallTimeoutMs = 30_000;
    public const int WatchdogIntervalMs = 500;
    private static readonly HashSet<string> ReservedDirs = ["subtitles", "vod", "swarm-probe"];

    private readonly object _gate = new();
    private readonly Dictionary<string, HlsSession> _byKey = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HlsSession> _byId = new(StringComparer.Ordinal);

    internal int StartupTimeout { get; set; } = StartupTimeoutMs;
    internal int StallTimeout { get; set; } = OutputStallTimeoutMs;
    internal int[] RemoveRetryDelaysMs { get; set; } = [50, 250, 1000];

    public int MaxConcurrent => options.Value.MaxConcurrentSessions;
    public long IdleTimeoutMs => options.Value.SessionIdleTimeoutSeconds * 1000L;
    private long Now => clock.GetUtcNow().ToUnixTimeMilliseconds();

    public static string SessionKey(string infoHash, string filePath, int? audioStreamIndex, int startSec, string source) =>
        $"{infoHash}/{filePath}#a{(audioStreamIndex is { } a ? a.ToString(System.Globalization.CultureInfo.InvariantCulture) : "none")}@{startSec}~{source}";

    public HlsSession? Get(string id)
    {
        lock (_gate) return _byId.GetValueOrDefault(id);
    }

    public IReadOnlyList<HlsSession> All()
    {
        lock (_gate) return [.. _byId.Values];
    }

    public HlsStartResult GetOrCreate(string infoHash, string filePath, PlaybackPlan plan, string sourceUrl, int startSec = 0)
    {
        startSec = Math.Max(0, startSec);
        var key = SessionKey(infoHash, filePath, plan.SelectedAudioIndex, startSec, HlsArgs.SourceKind(sourceUrl));
        var toClean = new List<HlsSession>();
        HlsSession session;
        lock (_gate)
        {
            if (_byKey.TryGetValue(key, out var existing))
            {
                if (existing.State is not ("stopped" or "error" or "stalled"))
                {
                    existing.Refs += 1;
                    existing.LastUnrefAt = null;
                    return new HlsStartResult(existing, null);
                }
                Forget(existing);
                toClean.Add(existing);
            }
            foreach (var other in _byId.Values.Where(s => s.InfoHash == infoHash && s.FilePath == filePath && s.Key != key).ToList())
            {
                Forget(other);
                toClean.Add(other);
            }
            if (_byId.Values.Count(s => s.IsLive) >= MaxConcurrent)
            {
                CleanupAll(toClean);
                return new HlsStartResult(null, $"Maximum concurrent sessions ({MaxConcurrent}) reached");
            }
            string ffmpeg;
            try { ffmpeg = binaries.ResolveFfmpeg(); }
            catch (FfmpegBinaryMissingException ex)
            {
                CleanupAll(toClean);
                return new HlsStartResult(null, ex.Message);
            }
            var id = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));
            var dir = Path.Combine(paths.SessionsDir, id);
            Directory.CreateDirectory(dir);
            session = new HlsSession(id, key, infoHash, filePath, plan, startSec, sourceUrl, dir, Now);
            _byKey[key] = session;
            _byId[id] = session;
            try { Spawn(session, ffmpeg, forceSoftware: false); }
            catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
            {
                Forget(session);
                toClean.Add(session);
                CleanupAll(toClean);
                return new HlsStartResult(null, ex.Message);
            }
        }
        CleanupAll(toClean);
        return new HlsStartResult(session, null);
    }

    private void Forget(HlsSession s)
    {
        if (_byKey.TryGetValue(s.Key, out var k) && k == s) _byKey.Remove(s.Key);
        _byId.Remove(s.Id);
    }

    private void CleanupAll(IEnumerable<HlsSession> sessions)
    {
        foreach (var s in sessions) Cleanup(s);
    }

    private void Spawn(HlsSession session, string ffmpeg, bool forceSoftware)
    {
        var args = HlsArgs.Build(session.Plan, session.SourceUrl, session.StartSec, forceSoftware);
        var proc = runner.Start(ffmpeg, args, session.OutputDir);
        session.Process = proc;
        session.SpawnedAt = Now;
        session.LastSegmentCount = 0;
        session.LastProgressAt = Now;
        try
        {
            File.WriteAllText(Path.Combine(session.OutputDir, "ffmpeg.pid"), JsonSerializer.Serialize(new { pid = proc.Id, startedAt = Now }));
        }
        catch (IOException) { }
        logger.LogInformation("[playback] session {Id} started ffmpeg pid {Pid} ({Rung}, {Source}, start {Start}s{Software})",
            session.Id, proc.Id, session.Plan.Rung, session.Source, session.StartSec, forceSoftware ? ", software" : "");
        _ = proc.Exited.ContinueWith(t => OnExit(session, proc, forceSoftware, t.IsCompletedSuccessfully ? t.Result : -1, ffmpeg), TaskScheduler.Default);
        StartWatchdog(session);
    }

    private void OnExit(HlsSession session, IRunningProcess proc, bool wasSoftware, int code, string ffmpeg)
    {
        lock (_gate)
        {
            if (session.Process != proc) return;
            if (session.State == "stopped") return;
            if (session.State == "stalled") { session.Process = null; return; }
            session.Process = null;
            var stderr = proc.StderrTail;
            if (CountSegments(session.OutputDir) == 0 && !wasSoftware && session.Plan.Video is { Action: "transcode", HwAccel: not null })
            {
                session.UsedSoftwareFallback = true;
                logger.LogWarning("[playback] session {Id}: hardware encoder produced nothing; retrying with software", session.Id);
                try { Spawn(session, ffmpeg, forceSoftware: true); return; }
                catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
                {
                    session.State = "error";
                    session.Error = ex.Message;
                    return;
                }
            }
            var aborted = AbortedReadRe().IsMatch(stderr);
            if (code == 0 && !aborted) session.State = "stopped";
            else if (aborted)
            {
                session.State = "stalled";
                session.Error = "The torrent stopped sending data while preparing this stream.";
            }
            else
            {
                session.State = "error";
                session.Error = $"ffmpeg exited with code {code}: {(stderr.Length > 500 ? stderr[^500..] : stderr)}";
            }
            session.Watchdog?.Cancel();
        }
    }

    private void StartWatchdog(HlsSession session)
    {
        session.Watchdog?.Cancel();
        var cts = new CancellationTokenSource();
        session.Watchdog = cts;
        _ = Task.Run(async () =>
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(WatchdogIntervalMs), clock);
            try
            {
                while (await timer.WaitForNextTickAsync(cts.Token))
                    if (!WatchdogTick(session)) return;
            }
            catch (OperationCanceledException) { }
        });
    }

    /// <summary>One watchdog pass; false once the watchdog should stop.</summary>
    internal bool WatchdogTick(HlsSession session)
    {
        lock (_gate)
        {
            if (session.Process is null) return false;
            var count = CountSegments(session.OutputDir);
            var now = Now;
            if (count > session.LastSegmentCount)
            {
                session.LastSegmentCount = count;
                session.LastProgressAt = now;
                NoteFirstSegment(session);
                return true;
            }
            var limit = session.State == "starting" ? StartupTimeout : StallTimeout;
            if (now - session.LastProgressAt <= limit) return true;
            session.State = "stalled";
            session.Error = session.TimeToFirstSegmentMs is null
                ? "Timed out waiting for the first segment \u2014 the torrent has no data yet."
                : "The stream stopped producing data \u2014 the torrent went quiet.";
            logger.LogWarning("[playback] session {Id} stalled: {Error}", session.Id, session.Error);
            var p = session.Process;
            session.Process = null;
            p.Kill();
            return false;
        }
    }

    private void NoteFirstSegment(HlsSession session)
    {
        if (session.TimeToFirstSegmentMs is not null) return;
        session.TimeToFirstSegmentMs = Now - session.SpawnedAt;
        if (session.State == "starting") session.State = "running";
    }

    internal static int CountSegments(string dir)
    {
        try { return Directory.EnumerateFiles(dir, "*.m4s").Count(); }
        catch (IOException) { return 0; }
        catch (UnauthorizedAccessException) { return 0; }
    }

    /// <summary>Port of waitForSessionFile: polls every 100 ms until the file exists or the session dies.</summary>
    public async Task<bool> WaitForFileAsync(HlsSession session, string absolutePath, int timeoutMs, CancellationToken ct)
    {
        var deadline = Now + timeoutMs;
        while (true)
        {
            if (File.Exists(absolutePath))
            {
                if (absolutePath.EndsWith(".m4s", StringComparison.OrdinalIgnoreCase) || absolutePath.EndsWith(".ts", StringComparison.OrdinalIgnoreCase))
                    lock (_gate) NoteFirstSegment(session);
                return true;
            }
            if (session.State is "error" or "stalled" or "stopped") return File.Exists(absolutePath);
            if (Now >= deadline) return false;
            try { await Task.Delay(100, ct); }
            catch (OperationCanceledException) { return false; }
        }
    }

    public void Unref(string id)
    {
        lock (_gate)
        {
            if (!_byId.TryGetValue(id, out var s)) return;
            s.Refs = Math.Max(0, s.Refs - 1);
            if (s.Refs == 0) s.LastUnrefAt = Now;
        }
    }

    /// <summary>Reaps sessions nobody has referenced for the idle timeout. Returns how many were removed.</summary>
    public int ReapIdle()
    {
        var reaped = new List<HlsSession>();
        lock (_gate)
        {
            var now = Now;
            foreach (var s in _byId.Values.ToList())
            {
                if (s.Refs == 0 && s.LastUnrefAt is { } at && now - at > IdleTimeoutMs)
                {
                    Forget(s);
                    reaped.Add(s);
                }
            }
        }
        foreach (var s in reaped)
        {
            logger.LogInformation("[playback] reaping idle session {Id}", s.Id);
            Cleanup(s);
        }
        return reaped.Count;
    }

    public void Stop(string infoHash, string filePath)
    {
        List<HlsSession> stop;
        lock (_gate)
        {
            stop = _byId.Values.Where(s => s.InfoHash == infoHash && s.FilePath == filePath).ToList();
            foreach (var s in stop) Forget(s);
        }
        CleanupAll(stop);
    }

    public void StopAll()
    {
        List<HlsSession> all;
        lock (_gate)
        {
            all = [.. _byId.Values];
            _byId.Clear();
            _byKey.Clear();
        }
        CleanupAll(all);
    }

    private void Cleanup(HlsSession s)
    {
        IRunningProcess? p;
        lock (_gate)
        {
            s.State = "stopped";
            p = s.Process;
            s.Process = null;
            s.Watchdog?.Cancel();
        }
        if (p is not null)
        {
            p.Kill();
            try { p.Exited.Wait(TimeSpan.FromSeconds(3)); } catch (AggregateException) { }
            p.Dispose();
        }
        RemoveDir(s.Id, s.OutputDir);
    }

    private void RemoveDir(string id, string dir)
    {
        foreach (var delay in RemoveRetryDelaysMs.Prepend(0))
        {
            if (delay > 0) Thread.Sleep(delay);
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
                return;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                if (delay == RemoveRetryDelaysMs[^1]) logger.LogWarning("[playback] failed to clean session {Id}: {Error}", id, ex.Message);
            }
        }
    }

    /// <summary>Kills ffmpeg orphans recorded in pid files of dead session dirs, then removes those dirs.</summary>
    public int CleanupStaleDirs()
    {
        if (!Directory.Exists(paths.SessionsDir)) return 0;
        HashSet<string> live;
        lock (_gate) live = [.. _byId.Keys];
        var removed = 0;
        foreach (var dir in Directory.EnumerateDirectories(paths.SessionsDir))
        {
            var name = Path.GetFileName(dir);
            if (live.Contains(name) || ReservedDirs.Contains(name) || !SessionIdRe().IsMatch(name)) continue;
            try
            {
                var pidFile = Path.Combine(dir, "ffmpeg.pid");
                if (File.Exists(pidFile) && JsonDocument.Parse(File.ReadAllText(pidFile)).RootElement.TryGetProperty("pid", out var pidEl) && pidEl.TryGetInt32(out var pid))
                    KillIfFfmpeg(pid);
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException) { }
            RemoveDir(name, dir);
            removed++;
        }
        return removed;
    }

    private void KillIfFfmpeg(int pid)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            if (!p.ProcessName.Contains("ffmpeg", StringComparison.OrdinalIgnoreCase)) return;
            p.Kill(entireProcessTree: true);
            logger.LogInformation("[playback] killed orphaned ffmpeg pid {Pid}", pid);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { }
    }

    [GeneratedRegex("Error during demuxing|Error number -138|Connection timed out|Immediate exit requested", RegexOptions.IgnoreCase)]
    private static partial Regex AbortedReadRe();

    [GeneratedRegex("^[a-f0-9]{16}$")] private static partial Regex SessionIdRe();
}
