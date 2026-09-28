using System.Globalization;

namespace TorrentFlow.Core.Contracts.Engine;

/// <summary>
/// One place for "how big is this download?" and the storage-refusal wording every entry point shares
/// (title page, requests, automation, direct send, release swap).
/// </summary>
public static class StorageEstimate
{
    /// <summary>When a release does not report a size, reserve this much against the cap.</summary>
    public const long DefaultIncomingReserveBytes = 2L * 1024 * 1024 * 1024;

    /// <summary>Bytes claimed by the chosen release alone — never other candidates, never the queue.</summary>
    public static long FromRelease(long? sizeBytes) =>
        sizeBytes is > 0 ? sizeBytes.Value : DefaultIncomingReserveBytes;

    public static bool IsEstimated(long? sizeBytes) => sizeBytes is not > 0;

    public static string FormatBytes(long n)
    {
        var c = CultureInfo.InvariantCulture;
        if (n < 0) return "?";
        if (n >= 1_000_000_000_000) return (n / 1e12).ToString("0.0", c) + " TB";
        if (n >= 1_000_000_000) return (n / 1e9).ToString("0.0", c) + " GB";
        if (n >= 1_000_000) return (n / 1e6).ToString("0", c) + " MB";
        return n.ToString(c) + " B";
    }

    /// <summary>
    /// Cap refusal copy. Keeps "this download" and "already queued" as separate figures so a 1 GB release
    /// never reads as a 45 GB need just because other rows are waiting.
    /// </summary>
    public static string CapMessage(long used, long cap, long thisDownload, bool estimated, long reservedQueued = 0)
    {
        var free = FormatBytes(Math.Max(0, cap - used));
        const string advice = "Raise the cap in Settings → Downloads, or free space there with \"Delete reclaimable stream-only files\".";
        var thisPart = estimated
            ? $"This download: {FormatBytes(thisDownload)} (size unknown)."
            : $"This download: {FormatBytes(thisDownload)}.";
        var queuedPart = reservedQueued > 0 ? $" Already queued: {FormatBytes(reservedQueued)}." : "";
        return $"{thisPart}{queuedPart} Only {free} is available under your cap ({FormatBytes(used)} already in use). {advice}";
    }

    /// <summary>Physical free-space refusal; still names this download apart from queued reservations.</summary>
    public static string WontFitMessage(long thisDownload, bool estimated, long reservedQueued, long freeBytes)
    {
        var thisPart = estimated
            ? $"This download: {FormatBytes(thisDownload)} (size unknown)."
            : $"This download: {FormatBytes(thisDownload)}.";
        var queuedPart = reservedQueued > 0 ? $" Already queued: {FormatBytes(reservedQueued)}." : "";
        var total = thisDownload + Math.Max(0, reservedQueued);
        return $"{thisPart}{queuedPart} Together that needs about {FormatBytes(total)}, but the drive only has {FormatBytes(freeBytes)} free.";
    }

    public static string ReserveMessage(long minFreeBytes) =>
        $"This download fits, but would leave less than {FormatBytes(minFreeBytes)} free on the drive.";
}
