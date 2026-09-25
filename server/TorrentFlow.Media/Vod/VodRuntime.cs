using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Ffmpeg;
using TorrentFlow.Media.Playback;

namespace TorrentFlow.Media.Vod;

public sealed class VodEntry
{
    public required string Id { get; init; }
    public required string Strategy { get; init; }
    public required string InfoHash { get; init; }
    public required string FilePath { get; init; }
    public required string SourcePath { get; set; }
    public required double Duration { get; set; }
    public required PlaybackPlan Plan { get; set; }
    public required string Dir { get; init; }
    /// <summary>preparing | ready | error</summary>
    public string Status { get; set; } = "preparing";
    public string? Error { get; set; }
    public int Attempts { get; set; }
    public long? SourceSize { get; set; }
    public long? SourceMtimeMs { get; set; }
    public long? LastUsedAt { get; set; }
    internal bool Terminal { get; set; }
    internal List<VodSegment>? Segments { get; set; }
}

public sealed record VodFileResult(int Status, string? Message, string? Path)
{
    public bool Ok => Path is not null;
    public static VodFileResult Found(string path) => new(200, null, path);
    public static VodFileResult Fail(int status, string message) => new(status, message, null);
}

/// <summary>
/// Port of src/lib/media/vod-runtime.ts: a disk cache under <c>.sessions/vod/&lt;id&gt;</c> holding either one
/// whole-file HLS conversion (video copy) or an on-demand fMP4 segment set produced from a keyframe-aligned VOD
/// playlist (video re-encode).
/// </summary>
public sealed partial class VodRuntime(
    MediaPaths paths,
    FfBinaries binaries,
    IProcessRunner runner,
    TimeProvider clock,
    ILogger<VodRuntime> logger)
{
    public const long CacheBudgetBytes = 40L * 1024 * 1024 * 1024;
    public const int MaxConcurrentSegments = 3;
    public const int MaxWholeFileAttempts = 3;
    public static readonly TimeSpan SegmentTimeout = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan KeyframeProbeTimeout = TimeSpan.FromSeconds(180);
    private const string NoPlayableOutput = "conversion produced no playable output";

    private static readonly JsonSerializerOptions MetaJson = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly ConcurrentDictionary<string, VodEntry> _entries = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Task<VodFileResult>> _segmentJobs = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Task> _prepareJobs = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _conversions = new(1, 1);
    private readonly SemaphoreSlim _segments = new(MaxConcurrentSegments, MaxConcurrentSegments);
    private readonly ConcurrentDictionary<int, IRunningProcess> _running = new();
    private long Now => clock.GetUtcNow().ToUnixTimeMilliseconds();

    public static string VodId(string infoHash, string filePath, int? audioStreamIndex, PlaybackPlan plan)
    {
        var audio = plan.SelectedAudio;
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            w.WriteStartObject();
            w.WriteNumber("version", 2);
            w.WriteString("infoHash", infoHash);
            w.WriteString("filePath", filePath);
            if (audioStreamIndex is { } a) w.WriteNumber("audioStreamIndex", a); else w.WriteNull("audioStreamIndex");
            w.WriteString("rung", plan.Rung);
            if (plan.Video is { } v)
            {
                w.WriteStartObject("video");
                w.WriteNumber("streamIndex", v.StreamIndex);
                w.WriteString("codec", v.Codec);
                w.WriteString("action", v.Action);
                w.WriteString("targetCodec", v.TargetCodec);
                w.WriteString("hwAccel", v.HwAccel);
                w.WriteEndObject();
            }
            else w.WriteNull("video");
            if (audio is not null)
            {
                w.WriteStartObject("audio");
                w.WriteNumber("streamIndex", audio.StreamIndex);
                w.WriteString("codec", audio.Codec);
                w.WriteString("action", audio.Action);
                w.WriteString("targetCodec", audio.TargetCodec);
                w.WriteNumber("channels", audio.Channels);
                w.WriteEndObject();
            }
            else w.WriteNull("audio");
            w.WriteEndObject();
        }
        return Convert.ToHexStringLower(SHA1.HashData(ms.ToArray()))[..20];
    }

    public string EntryDir(string id) => Path.Combine(paths.VodDir, id);
    public static string PlaylistPath(VodEntry entry) => Path.Combine(entry.Dir, VodPlanning.WholeFilePlaylist);

    public static bool IsRetryable(VodEntry entry) => entry.Status == "error" && !entry.Terminal;

    /// <summary>Returns the cache entry for this (file, track, plan), starting conversion/timeline work if needed.</summary>
    public VodEntry Prepare(string strategy, string infoHash, string filePath, int? audioStreamIndex, string sourcePath, double duration, PlaybackPlan plan)
    {
        var id = VodId(infoHash, filePath, audioStreamIndex, plan);
        var entry = _entries.GetOrAdd(id, _ => Load(id) ?? new VodEntry
        {
            Id = id, Strategy = strategy, InfoHash = infoHash, FilePath = filePath, SourcePath = sourcePath,
            Duration = duration, Plan = plan, Dir = EntryDir(id),
        });
        lock (entry)
        {
            entry.SourcePath = sourcePath;
            entry.Duration = duration;
            entry.Plan = plan;
            entry.LastUsedAt = Now;
            var (size, mtime) = Fingerprint(sourcePath);
            if (entry.SourceSize is not null && entry.SourceMtimeMs is not null && size is not null && (entry.SourceSize != size || entry.SourceMtimeMs != mtime))
                ResetForNewSource(entry);
            entry.SourceSize = size ?? entry.SourceSize;
            entry.SourceMtimeMs = mtime ?? entry.SourceMtimeMs;
            Directory.CreateDirectory(entry.Dir);
            SaveMeta(entry);
            if (entry.Status == "ready" || (entry.Status == "error" && entry.Terminal)) return entry;
            if (_prepareJobs.ContainsKey(id)) return entry;
            if (entry.Status == "error") { entry.Status = "preparing"; }
            var job = strategy == "whole-file" ? Task.Run(() => ConvertWholeFileAsync(entry)) : Task.Run(() => PrepareTimelineAsync(entry));
            _prepareJobs[id] = job;
            _ = job.ContinueWith(_ => _prepareJobs.TryRemove(id, out Task? _), TaskScheduler.Default);
        }
        _ = Task.Run(EnforceBudget);
        return entry;
    }

    public VodEntry? Get(string id)
    {
        if (!VodIdRe().IsMatch(id)) return null;
        if (_entries.TryGetValue(id, out var e)) { e.LastUsedAt = Now; return e; }
        var loaded = Load(id);
        return loaded is null ? null : _entries.GetOrAdd(id, loaded);
    }

    private VodEntry? Load(string id)
    {
        var dir = EntryDir(id);
        var metaPath = Path.Combine(dir, "meta.json");
        if (!File.Exists(metaPath)) return null;
        try
        {
            var meta = JsonSerializer.Deserialize<VodMeta>(File.ReadAllText(metaPath), MetaJson);
            if (meta is null) return null;
            var entry = new VodEntry
            {
                Id = id, Strategy = meta.Strategy, InfoHash = meta.InfoHash, FilePath = meta.FilePath, SourcePath = meta.SourcePath,
                Duration = meta.Duration, Plan = meta.Plan, Dir = dir, Attempts = meta.Attempts, Error = meta.Error,
                SourceSize = meta.SourceSize, SourceMtimeMs = meta.SourceMtimeMs, LastUsedAt = meta.LastUsedAt, Terminal = meta.Terminal,
            };
            entry.Status = IsReadyOnDisk(dir) ? "ready" : meta.Error is not null ? "error" : "preparing";
            return entry;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException) { return null; }
    }

    private static bool IsReadyOnDisk(string dir)
    {
        try
        {
            var playlist = Path.Combine(dir, VodPlanning.WholeFilePlaylist);
            return File.Exists(Path.Combine(dir, "ready.json")) && File.Exists(playlist) && File.ReadAllText(playlist).Contains("#EXT-X-ENDLIST", StringComparison.Ordinal);
        }
        catch (IOException) { return false; }
    }

    private void SaveMeta(VodEntry e)
    {
        try
        {
            var meta = new VodMeta(e.Strategy, e.InfoHash, e.FilePath, e.SourcePath, e.Duration, e.Plan, e.Attempts, e.Error, e.SourceSize, e.SourceMtimeMs, e.LastUsedAt, e.Terminal);
            WriteAtomic(Path.Combine(e.Dir, "meta.json"), Encoding.UTF8.GetBytes(JsonSerializer.Serialize(meta, MetaJson)));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { logger.LogWarning("[vod] meta write failed for {Id}: {Error}", e.Id, ex.Message); }
    }

    private static void WriteAtomic(string path, byte[] data)
    {
        var part = path + "." + Guid.NewGuid().ToString("N")[..8] + ".part";
        File.WriteAllBytes(part, data);
        File.Move(part, path, true);
    }

    private static (long? Size, long? MtimeMs) Fingerprint(string path)
    {
        try
        {
            var info = new FileInfo(path);
            return info.Exists ? (info.Length, new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds()) : (null, null);
        }
        catch (IOException) { return (null, null); }
    }

    internal static void ResetForNewSource(VodEntry entry)
    {
        entry.Attempts = 0;
        entry.Error = null;
        entry.Terminal = false;
        entry.Status = "preparing";
        entry.Segments = null;
        if (!Directory.Exists(entry.Dir)) return;
        foreach (var name in new[] { "ready.json", VodPlanning.WholeFilePlaylist, VodPlanning.WholeFileData, VodPlanning.InitName, "keyframes.json" })
            TryDelete(Path.Combine(entry.Dir, name));
        foreach (var file in Directory.EnumerateFiles(entry.Dir))
        {
            var name = Path.GetFileName(file);
            if (VodPlanning.ParseSegmentIndex(name) is not null || name.EndsWith(".part", StringComparison.Ordinal)) TryDelete(file);
        }
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private void MarkReady(VodEntry entry)
    {
        WriteAtomic(Path.Combine(entry.Dir, "ready.json"), Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { readyAt = Now })));
        lock (entry)
        {
            entry.Status = "ready";
            entry.Error = null;
            entry.Terminal = false;
            SaveMeta(entry);
        }
    }

    internal static string WholeFileFailureMessage(int attempt, string message, bool environment) =>
        environment ? $"whole-file conversion unavailable: {message}"
        : attempt >= MaxWholeFileAttempts ? $"whole-file conversion failed after {attempt} attempts: {message}"
        : $"whole-file conversion attempt {attempt} failed: {message}";

    private void FailWholeFile(VodEntry entry, string message, bool environment)
    {
        lock (entry)
        {
            if (!environment) entry.Attempts += 1;
            entry.Status = "error";
            entry.Error = WholeFileFailureMessage(entry.Attempts, message, environment);
            entry.Terminal = !environment && entry.Attempts >= MaxWholeFileAttempts;
            SaveMeta(entry);
        }
        logger.LogWarning("[vod] {Id}: {Error}", entry.Id, entry.Error);
    }

    private async Task ConvertWholeFileAsync(VodEntry entry)
    {
        await _conversions.WaitAsync();
        try
        {
            if (IsReadyOnDisk(entry.Dir)) { MarkReady(entry); return; }
            string ffmpeg;
            try { ffmpeg = binaries.ResolveFfmpeg(); }
            catch (FfBinaryMissingException ex) { FailWholeFile(entry, ex.Message, environment: true); return; }
            TryDelete(Path.Combine(entry.Dir, VodPlanning.WholeFilePlaylist));
            TryDelete(Path.Combine(entry.Dir, VodPlanning.WholeFileData));
            IRunningProcess proc;
            try { proc = runner.Start(ffmpeg, VodPlanning.BuildWholeFileHlsArgs(entry.Plan, entry.SourcePath), entry.Dir); }
            catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
            {
                FailWholeFile(entry, ex.Message, environment: true);
                return;
            }
            _running[proc.Id] = proc;
            int code;
            try
            {
                logger.LogInformation("[vod] {Id}: whole-file conversion started (pid {Pid})", entry.Id, proc.Id);
                code = await proc.Exited;
            }
            finally
            {
                _running.TryRemove(proc.Id, out _);
                proc.Dispose();
            }
            var playlist = Path.Combine(entry.Dir, VodPlanning.WholeFilePlaylist);
            var ok = code == 0 && File.Exists(Path.Combine(entry.Dir, VodPlanning.WholeFileData)) && File.Exists(playlist)
                && (await File.ReadAllTextAsync(playlist)).Contains("#EXT-X-ENDLIST", StringComparison.Ordinal);
            if (ok) { MarkReady(entry); logger.LogInformation("[vod] {Id}: whole-file conversion ready", entry.Id); return; }
            var stderr = proc.StderrTail.Trim();
            FailWholeFile(entry, code != 0 && stderr.Length > 0 ? $"ffmpeg exited {code}: {Tail(stderr, 300)}" : NoPlayableOutput, environment: false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { FailWholeFile(entry, ex.Message, environment: false); }
        finally { _conversions.Release(); }
    }

    private async Task PrepareTimelineAsync(VodEntry entry)
    {
        try
        {
            var keys = ReadKeyframes(entry.Dir);
            if (keys is null)
            {
                keys = await ProbeKeyframesAsync(entry.SourcePath);
                if (keys is not null) WriteAtomic(Path.Combine(entry.Dir, "keyframes.json"), Encoding.UTF8.GetBytes(JsonSerializer.Serialize(keys)));
            }
            var segments = VodPlanning.KeyframeAlignedSegments(keys, entry.Duration);
            if (segments.Count == 0) throw new IOException("source duration produced no segments");
            entry.Segments = segments;
            WriteAtomic(PlaylistPath(entry), Encoding.UTF8.GetBytes(VodPlanning.BuildVodPlaylist(segments)));
            MarkReady(entry);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            lock (entry)
            {
                entry.Status = "error";
                entry.Error = ex.Message;
                SaveMeta(entry);
            }
        }
    }

    internal static List<double>? ReadKeyframes(string dir)
    {
        try
        {
            var path = Path.Combine(dir, "keyframes.json");
            if (!File.Exists(path)) return null;
            var list = JsonSerializer.Deserialize<List<double>>(File.ReadAllText(path));
            return list is { Count: > 0 } ? list : null;
        }
        catch (Exception ex) when (ex is IOException or JsonException) { return null; }
    }

    private async Task<List<double>?> ProbeKeyframesAsync(string source)
    {
        var ffprobe = binaries.TryResolveFfprobe();
        if (ffprobe is null) return null;
        var result = await ProcessRuns.RunAsync(runner, ffprobe, VodPlanning.BuildKeyframeProbeArgs(source), KeyframeProbeTimeout, 256L * 1024 * 1024, CancellationToken.None);
        if (!result.Ok) return null;
        var keys = VodPlanning.ParseKeyframeTimes(Encoding.UTF8.GetString(result.Stdout));
        return keys.Count > 0 ? keys : null;
    }

    private List<VodSegment> SegmentsOf(VodEntry entry) =>
        entry.Segments ??= VodPlanning.KeyframeAlignedSegments(ReadKeyframes(entry.Dir), entry.Duration);

    public async Task<VodFileResult> EnsureInitAsync(VodEntry entry, CancellationToken ct)
    {
        var init = Path.Combine(entry.Dir, VodPlanning.InitName);
        if (File.Exists(init)) return VodFileResult.Found(init);
        var first = await EnsureSegmentAsync(entry, 0, ct);
        if (!first.Ok) return first;
        return File.Exists(init) ? VodFileResult.Found(init) : VodFileResult.Fail(500, "segment produced no initialisation data");
    }

    public Task<VodFileResult> EnsureSegmentAsync(VodEntry entry, int index, CancellationToken ct)
    {
        var target = Path.Combine(entry.Dir, VodPlanning.SegmentName(index));
        if (File.Exists(target) && File.Exists(Path.Combine(entry.Dir, VodPlanning.InitName))) return Task.FromResult(VodFileResult.Found(target));
        var segments = SegmentsOf(entry);
        if (index < 0 || index >= segments.Count) return Task.FromResult(VodFileResult.Fail(404, $"segment {index} is not in this playlist"));
        var key = $"{entry.Id}:{index}";
        var job = _segmentJobs.GetOrAdd(key, _ => Task.Run(() => ProduceSegmentAsync(entry, segments[index], target)));
        _ = job.ContinueWith(_ => _segmentJobs.TryRemove(key, out Task<VodFileResult>? _), TaskScheduler.Default);
        return job.WaitAsync(ct);
    }

    private async Task<VodFileResult> ProduceSegmentAsync(VodEntry entry, VodSegment segment, string target)
    {
        await _segments.WaitAsync();
        try
        {
            string ffmpeg;
            try { ffmpeg = binaries.ResolveFfmpeg(); }
            catch (FfBinaryMissingException ex) { return VodFileResult.Fail(500, ex.Message); }
            var args = VodPlanning.BuildVodSegmentArgs(entry.Plan, entry.SourcePath, segment, forceSoftware: true);
            args.Add("pipe:1");
            var result = await ProcessRuns.RunAsync(runner, ffmpeg, args, SegmentTimeout, 1024L * 1024 * 1024, CancellationToken.None);
            if (result.Failure == "timeout") return VodFileResult.Fail(504, $"segment {segment.Index} timed out");
            if (result.Failure is not null && result.Failure != "oversize") return VodFileResult.Fail(500, $"ffmpeg exited {result.ExitCode}: {Tail(result.Stderr, 300)}");
            if (result.ExitCode != 0) return VodFileResult.Fail(500, $"ffmpeg exited {result.ExitCode}: {Tail(result.Stderr, 300)}");
            var split = VodPlanning.SplitFragmentedMp4(result.Stdout);
            if (split is null) return VodFileResult.Fail(500, "ffmpeg produced no fMP4 fragment");
            var init = Path.Combine(entry.Dir, VodPlanning.InitName);
            if (!File.Exists(init)) WriteAtomic(init, split.Init);
            WriteAtomic(target, split.Media);
            return VodFileResult.Found(target);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return VodFileResult.Fail(500, ex.Message); }
        finally { _segments.Release(); }
    }

    private static string Tail(string s, int n) => s.Length > n ? s[^n..] : s;

    /// <summary>LRU-evicts cache entries beyond the 40 GiB budget, never touching entries still preparing.</summary>
    public void EnforceBudget() => EnforceBudget(CacheBudgetBytes);

    internal void EnforceBudget(long budget)
    {
        try
        {
            if (!Directory.Exists(paths.VodDir)) return;
            var dirs = Directory.EnumerateDirectories(paths.VodDir).Select(d =>
            {
                var id = Path.GetFileName(d);
                _entries.TryGetValue(id, out var e);
                var size = new DirectoryInfo(d).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length);
                var used = e?.LastUsedAt ?? new DateTimeOffset(Directory.GetLastWriteTimeUtc(d)).ToUnixTimeMilliseconds();
                return (Dir: d, Id: id, Entry: e, Size: size, Used: used);
            }).OrderBy(x => x.Used).ToList();
            var total = dirs.Sum(d => d.Size);
            foreach (var d in dirs)
            {
                if (total <= budget) break;
                if (d.Entry?.Status == "preparing" || _prepareJobs.ContainsKey(d.Id)) continue;
                try
                {
                    Directory.Delete(d.Dir, true);
                    _entries.TryRemove(d.Id, out _);
                    total -= d.Size;
                    logger.LogInformation("[vod] evicted {Id} ({Size} bytes)", d.Id, d.Size);
                }
                catch (IOException) { }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { logger.LogWarning("[vod] budget sweep failed: {Error}", ex.Message); }
    }

    public void KillAll()
    {
        foreach (var p in _running.Values) p.Kill();
    }

    private sealed record VodMeta(
        string Strategy, string InfoHash, string FilePath, string SourcePath, double Duration, PlaybackPlan Plan,
        int Attempts, string? Error, long? SourceSize, long? SourceMtimeMs, long? LastUsedAt, bool Terminal);

    [GeneratedRegex("^[a-f0-9]{8,40}$")] private static partial Regex VodIdRe();
}
