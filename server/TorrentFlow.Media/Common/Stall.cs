namespace TorrentFlow.Media.Common;

/// <summary>Port of src/lib/playback/stall.ts: byte-progress stall detection, not wall-clock timeouts.</summary>
public sealed record TransferSample(long AtMs, long DownloadedBytes, double Progress, string State, int? PeerCount = null, int? ActiveRequestCount = null);

public sealed record StallVerdict(bool Stalled, string Reason, long? DeliveredBytes, long? WindowMs);

public sealed record StallOptions(long? WindowMs = null, long? MinDeliveredBytes = null, long? ColdStartGraceMs = null);

public static class Stall
{
    public const long WindowMs = 30_000;
    public const long MinDeliveredBytes = 256 * 1024;
    public const long ColdStartGraceMsDefault = 240_000;
    public const long StreamWindowMs = 12_000;
    public const long StreamColdStartGraceMs = 12_000;
    private const double CompleteProgress = 0.9999;

    public static StallOptions StreamOptions(long windowMs = StreamWindowMs) => new(windowMs, null, StreamColdStartGraceMs);

    public static StallVerdict Evaluate(IReadOnlyList<TransferSample> samples, StallOptions? options = null)
    {
        options ??= new StallOptions();
        var windowMs = options.WindowMs ?? WindowMs;
        var minBytes = options.MinDeliveredBytes ?? MinDeliveredBytes;
        var grace = options.ColdStartGraceMs ?? ColdStartGraceMsDefault;
        if (samples.Count < 2) return new(false, "insufficient-history", null, null);
        var ordered = samples.OrderBy(s => s.AtMs).ToList();
        var latest = ordered[^1];
        if (latest.Progress >= CompleteProgress) return new(false, "complete", null, null);
        if (latest.State is not ("downloading" or "stalledDL")) return new(false, "not-downloading", null, null);
        var cutoff = latest.AtMs - windowMs;
        TransferSample? baseline = null;
        for (var i = ordered.Count - 2; i >= 0; i--)
        {
            if (ordered[i].AtMs <= cutoff) { baseline = ordered[i]; break; }
        }
        if (baseline is null) return new(false, "insufficient-history", null, null);
        var window = latest.AtMs - baseline.AtMs;
        var delivered = Math.Max(0, latest.DownloadedBytes - baseline.DownloadedBytes);
        if (delivered >= minBytes) return new(false, "progressing", delivered, window);
        var active = Math.Max(0, latest.ActiveRequestCount ?? 0) > 0;
        var noBytes = ordered.All(s => s.DownloadedBytes <= 0);
        if (active && noBytes && latest.AtMs - ordered[0].AtMs <= grace) return new(false, "cold-starting", delivered, window);
        return new(true, "stalled", delivered, window);
    }
}
