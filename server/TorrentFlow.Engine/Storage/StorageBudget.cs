using System.Collections.Concurrent;
using System.Globalization;

namespace TorrentFlow.Engine.Storage;

public sealed record StorageCheck
{
    public bool Ok { get; init; }
    /// <summary>setup | inventory | cap | reserve | wont-fit (null when ok).</summary>
    public string? Limit { get; init; }
    public string? Message { get; init; }
    public long UsedBytes { get; init; }
    public long? FreeBytes { get; init; }
    public long? MaxStorageBytes { get; init; }
    public long? RemainingBudgetBytes { get; init; }
    public long IncomingBytes { get; init; }
    public bool IncomingEstimated { get; init; }
    /// <summary>Queued downloads' promised bytes that were counted on top of the incoming release.</summary>
    public long ReservedQueuedBytes { get; init; }

    /// <summary>cap and reserve are the owner's own guardrails; wont-fit, setup and inventory are hard stops.</summary>
    public bool Overridable => Limit is "cap" or "reserve";
}

/// <summary>Port of lib/library/disk-space assertStorageBudget, plus the queued-bytes reservation from storage-gate.</summary>
public sealed class StorageBudget(TimeProvider time)
{
    public const long MinFreeBytes = 500L * 1024 * 1024;
    public const long DefaultIncomingReserveBytes = 2L * 1024 * 1024 * 1024;
    public static readonly TimeSpan DirSizeTtl = TimeSpan.FromSeconds(30);
    public const string SetupRequiredMessage =
        "Downloads need setup first — choose a download folder and set a storage cap in Settings → Downloads.";

    private readonly ConcurrentDictionary<string, (DateTimeOffset At, long Bytes, bool Complete)> _sizes = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Test seam for the volume's free bytes.</summary>
    public Func<string, long?> FreeBytesProvider { get; set; } = DefaultFreeBytes;

    public void ResetDirectorySizeCache() => _sizes.Clear();

    public StorageCheck Check(string? root, long? maxStorageBytes, long? incomingBytes, long reservedQueuedBytes, bool overrideCap = false)
    {
        if (string.IsNullOrWhiteSpace(root) || maxStorageBytes is not > 0)
            return new StorageCheck { Ok = false, Limit = "setup", Message = SetupRequiredMessage, MaxStorageBytes = maxStorageBytes };

        var (used, complete) = DirectorySize(root);
        if (!complete)
            return new StorageCheck
            {
                Ok = false, Limit = "inventory", UsedBytes = used, MaxStorageBytes = maxStorageBytes,
                Message = "The download folder could not be fully measured, so the storage cap cannot be checked. Try again in a moment.",
            };

        var estimated = incomingBytes is not > 0;
        var requested = estimated ? DefaultIncomingReserveBytes : incomingBytes!.Value;
        // Queued downloads have claimed space but written none of it, so the folder measurement cannot see them.
        var incoming = requested + Math.Max(0, reservedQueuedBytes);
        var free = FreeBytesProvider(root);
        var remaining = Math.Max(0, maxStorageBytes.Value - used);
        StorageCheck Fail(string limit, string message) => new()
        {
            Ok = false, Limit = limit, Message = message, UsedBytes = used, FreeBytes = free, MaxStorageBytes = maxStorageBytes,
            RemainingBudgetBytes = remaining, IncomingBytes = requested, IncomingEstimated = estimated, ReservedQueuedBytes = reservedQueuedBytes,
        };

        if (free is { } f && incoming > f)
            return Fail("wont-fit", $"This release needs about {FormatBytes(incoming)}, but the drive only has {FormatBytes(f)} free.");
        if (!overrideCap)
        {
            if (used + incoming > maxStorageBytes.Value)
                return Fail("cap", CapMessage(used, maxStorageBytes.Value, incoming, estimated));
            if (free is { } f2 && f2 - incoming < MinFreeBytes)
                return Fail("reserve", $"This release fits, but would leave less than {FormatBytes(MinFreeBytes)} free on the drive.");
        }
        return new StorageCheck
        {
            Ok = true, UsedBytes = used, FreeBytes = free, MaxStorageBytes = maxStorageBytes, RemainingBudgetBytes = remaining,
            IncomingBytes = requested, IncomingEstimated = estimated, ReservedQueuedBytes = reservedQueuedBytes,
        };
    }

    public static string CapMessage(long used, long cap, long incoming, bool estimated)
    {
        var free = FormatBytes(Math.Max(0, cap - used));
        const string advice = "Raise the cap in Settings → Downloads, or free space there with \"Delete reclaimable stream-only files\".";
        if (estimated)
            return $"Not enough space for this release. We're reserving {FormatBytes(incoming)} for it (size unknown), but only {free} is available ({FormatBytes(used)} already in use). {advice}";
        return $"This release needs about {FormatBytes(incoming)}, but only {free} is available ({FormatBytes(used)} already in use). {advice}";
    }

    public static string FormatBytes(long n)
    {
        var c = CultureInfo.InvariantCulture;
        if (n < 0) return "?";
        if (n >= 1_000_000_000_000) return (n / 1e12).ToString("0.0", c) + " TB";
        if (n >= 1_000_000_000) return (n / 1e9).ToString("0.0", c) + " GB";
        if (n >= 1_000_000) return (n / 1e6).ToString("0", c) + " MB";
        return n.ToString(c) + " B";
    }

    /// <summary>Recursive byte count under the download root, cached for 30 seconds.</summary>
    public (long Bytes, bool Complete) DirectorySize(string root)
    {
        var now = time.GetUtcNow();
        if (_sizes.TryGetValue(root, out var hit) && now - hit.At < DirSizeTtl) return (hit.Bytes, hit.Complete);
        long total = 0;
        var complete = true;
        if (Directory.Exists(root))
        {
            try
            {
                var opts = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint };
                foreach (var f in new DirectoryInfo(root).EnumerateFiles("*", opts)) total += f.Length;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { complete = false; }
        }
        _sizes[root] = (now, total, complete);
        return (total, complete);
    }

    private static long? DefaultFreeBytes(string root)
    {
        try
        {
            var full = Path.GetFullPath(root);
            var drive = Path.GetPathRoot(full);
            return string.IsNullOrEmpty(drive) ? null : new DriveInfo(drive).AvailableFreeSpace;
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException) { return null; }
    }
}
