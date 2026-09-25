using System.Collections.Concurrent;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Media.Ffmpeg;
using TorrentFlow.Media.Tools;

namespace TorrentFlow.Media.Probing;

/// <summary>Port of src/lib/media/probe.ts + the MediaProbe cache + warm-probe single-flight.</summary>
public sealed class MediaProber(
    FfmpegLocator binaries,
    IProcessRunner runner,
    IDbContextFactory<TorrentFlowDbContext> dbFactory,
    ILogger<MediaProber> logger)
{
    public const int DefaultTimeoutMs = 30_000;
    public const int ProbeCacheVersion = 1;
    private readonly ConcurrentDictionary<string, Task<ProbeOutcome>> _warm = new(StringComparer.Ordinal);

    public Task<ProbeOutcome> ProbeUrlAsync(string url, CancellationToken ct = default, int timeoutMs = DefaultTimeoutMs) => ProbeAsync(url, true, timeoutMs, ct);

    public Task<ProbeOutcome> ProbeFileAsync(string path, CancellationToken ct = default, int timeoutMs = DefaultTimeoutMs) => ProbeAsync(path, false, timeoutMs, ct);

    private async Task<ProbeOutcome> ProbeAsync(string input, bool network, int timeoutMs, CancellationToken ct)
    {
        string ffprobe;
        try { ffprobe = binaries.ResolveFfprobe(); }
        catch (FfmpegBinaryMissingException ex) { return ProbeOutcome.Fail("probe_failed", ex.Message); }
        var args = ProbeShape.BuildProbeArgs(input, network, timeoutMs);
        var run = await ProcessRuns.RunAsync(runner, ffprobe, args, TimeSpan.FromMilliseconds(timeoutMs + 2000), 4 * 1024 * 1024, ct);
        if (run.Failure is "timeout" or "aborted") return ProbeOutcome.Fail("timeout", $"ffprobe timed out after {timeoutMs}ms");
        if (run.Failure is "spawn") return ProbeOutcome.Fail("probe_failed", run.Stderr);
        if (run.ExitCode != 0 && run.Stdout.Length == 0)
            return ProbeOutcome.Fail("probe_failed", $"Command failed: ffprobe exited with code {run.ExitCode}{(run.Stderr.Length > 0 ? " " + run.Stderr.Trim() : "")}");
        return ProbeShape.Parse(Encoding.UTF8.GetString(run.Stdout));
    }

    public async Task<ProbeResult?> CachedAsync(string infoHash, string filePath, CancellationToken ct = default)
    {
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var row = await db.MediaProbes.AsNoTracking().FirstOrDefaultAsync(p => p.InfoHash == infoHash && p.FilePath == filePath, ct);
            return FromCacheRow(row);
        }
        catch (Exception ex) when (ex is DbUpdateException or InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            logger.LogWarning("[playback] PLAYBACK_CACHE_FAILED read: {Message}", ex.Message);
            return null;
        }
    }

    public async Task<List<ProbeStream>?> CachedStreamsAsync(string infoHash, string filePath, CancellationToken ct = default)
    {
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var json = await db.MediaProbes.AsNoTracking().Where(p => p.InfoHash == infoHash && p.FilePath == filePath).Select(p => p.StreamsJson).FirstOrDefaultAsync(ct);
            return ProbeShape.DeserializeStreams(json);
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException) { return null; }
    }

    internal static ProbeResult? FromCacheRow(MediaProbe? row)
    {
        if (row is null || string.IsNullOrEmpty(row.StreamsJson) || row.ProbeVersion < ProbeCacheVersion) return null;
        var streams = ProbeShape.DeserializeStreams(row.StreamsJson);
        return streams is null ? null : new ProbeResult(row.Container ?? "unknown", row.DurationSec, streams, ProbeShape.ParseBitrate(row.BitRateBps));
    }

    public async Task<bool> StoreAsync(string infoHash, string filePath, ProbeResult result, CancellationToken ct = default)
    {
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var row = await db.MediaProbes.FirstOrDefaultAsync(p => p.InfoHash == infoHash && p.FilePath == filePath, ct);
            var now = DateTime.UtcNow;
            if (row is null)
            {
                row = new MediaProbe { Id = Ids.New(), InfoHash = infoHash, FilePath = filePath, ProbedAt = now };
                db.MediaProbes.Add(row);
            }
            var video = result.Video;
            var audio = result.Audio.FirstOrDefault();
            row.Container = result.Container;
            row.DurationSec = result.Duration;
            row.VideoCodec = video?.Codec;
            row.VideoProfile = video?.Profile;
            row.Width = video?.Width;
            row.Height = video?.Height;
            row.ColorTransfer = video?.ColorTransfer;
            row.AudioCodec = audio?.Codec;
            row.AudioChannels = audio?.Channels;
            row.AudioLayout = audio?.ChannelLayout;
            row.BitRateBps = ProbeShape.BitrateBps(result) is { } b ? (int)Math.Min(int.MaxValue, b) : null;
            row.ProbeVersion = ProbeCacheVersion;
            row.StreamsJson = ProbeShape.SerializeStreams(result.Streams);
            row.UpdatedAt = now;
            await db.SaveChangesAsync(ct);
            return true;
        }
        catch (Exception ex) when (ex is DbUpdateException or InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            logger.LogWarning("[playback] PLAYBACK_CACHE_FAILED write: {Message}", ex.Message);
            return false;
        }
    }

    /// <summary>Probe (cache first) and store; concurrent callers for the same file share one ffprobe.</summary>
    public Task<ProbeOutcome> WarmAsync(string infoHash, string filePath, string sourceUrl, CancellationToken ct = default)
    {
        var key = $"{infoHash.ToLowerInvariant()}|{filePath}";
        return RunSingleFlight(key, async () =>
        {
            var cached = await CachedAsync(infoHash, filePath, CancellationToken.None);
            if (cached is not null) return ProbeOutcome.Success(cached);
            var outcome = await ProbeUrlAsync(sourceUrl, CancellationToken.None);
            if (outcome.Result is { } r) await StoreAsync(infoHash, filePath, r, CancellationToken.None);
            return outcome;
        }).WaitAsync(ct);
    }

    public int WarmProbesInFlight => _warm.Count;

    internal Task<ProbeOutcome> RunSingleFlight(string key, Func<Task<ProbeOutcome>> task)
    {
        var tcs = new TaskCompletionSource<ProbeOutcome>(TaskCreationOptions.RunContinuationsAsynchronously);
        var existing = _warm.GetOrAdd(key, tcs.Task);
        if (existing != tcs.Task) return existing;
        _ = Task.Run(async () =>
        {
            try { tcs.TrySetResult(await task()); }
            catch (Exception ex) { tcs.TrySetResult(ProbeOutcome.Fail("probe_failed", ex.Message)); }
            finally { _warm.TryRemove(new KeyValuePair<string, Task<ProbeOutcome>>(key, tcs.Task)); }
        });
        return tcs.Task;
    }
}
