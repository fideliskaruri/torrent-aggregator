using System.Collections.Concurrent;
using TorrentFlow.Core.Contracts.Engine;

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
    /// <summary>Size of the chosen release only (or the default reserve when unknown).</summary>
    public long IncomingBytes { get; init; }
    public bool IncomingEstimated { get; init; }
    /// <summary>Queued downloads' promised bytes counted on top of this release — never folded into IncomingBytes.</summary>
    public long ReservedQueuedBytes { get; init; }

    /// <summary>cap and reserve are the owner's own guardrails; wont-fit, setup and inventory are hard stops.</summary>
    public bool Overridable => Limit is "cap" or "reserve";
}

/// <summary>Port of lib/library/disk-space assertStorageBudget, plus the queued-bytes reservation from storage-gate.</summary>
public sealed class StorageBudget(TimeProvider time)
{
    public const long MinFreeBytes = 500L * 1024 * 1024;
    public const long DefaultIncomingReserveBytes = StorageEstimate.DefaultIncomingReserveBytes;
    public static readonly TimeSpan DirSizeTtl = TimeSpan.FromSeconds(30);
    public const string SetupRequiredMessage =
        "Downloads need setup first. Choose a download folder and set a storage cap in Settings → Downloads.";

    private readonly ConcurrentDictionary<string, (DateTimeOffset At, long Bytes, bool Complete)> _sizes = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Test seam for the volume's free bytes.</summary>
    public Func<string, long?> FreeBytesProvider { get; set; } = DefaultFreeBytes;

    public void ResetDirectorySizeCache() => _sizes.Clear();

    /// <param name="stagingOutsideRoot">Stage folders on other volumes (StagePaths.OutsideRoot): counted once on top of the
    /// download root, which already holds its own <c>.staging</c> folder.</param>
    public StorageCheck Check(string? root, long? maxStorageBytes, long? incomingBytes, long reservedQueuedBytes, bool overrideCap = false,
        IReadOnlyList<string>? stagingOutsideRoot = null)
    {
        if (string.IsNullOrWhiteSpace(root) || maxStorageBytes is not > 0)
            return new StorageCheck { Ok = false, Limit = "setup", Message = SetupRequiredMessage, MaxStorageBytes = maxStorageBytes };

        var (used, complete) = DirectorySize(root);
        foreach (var staging in stagingOutsideRoot ?? [])
        {
            var (bytes, read) = DirectorySize(staging);
            used += bytes;
            complete &= read;
        }
        if (!complete)
            return new StorageCheck
            {
                Ok = false, Limit = "inventory", UsedBytes = used, MaxStorageBytes = maxStorageBytes,
                Message = "The download folder could not be fully measured, so the storage cap cannot be checked. Try again in a moment.",
            };

        // Estimate from the chosen release only. Queued rows are a separate term.
        var estimated = StorageEstimate.IsEstimated(incomingBytes);
        var requested = StorageEstimate.FromRelease(incomingBytes);
        var reserved = Math.Max(0, reservedQueuedBytes);
        // Queued downloads have claimed space but written none of it, so the folder measurement cannot see them.
        var budgetClaim = requested + reserved;
        var free = FreeBytesProvider(root);
        var remaining = Math.Max(0, maxStorageBytes.Value - used);
        StorageCheck Fail(string limit, string message) => new()
        {
            Ok = false, Limit = limit, Message = message, UsedBytes = used, FreeBytes = free, MaxStorageBytes = maxStorageBytes,
            RemainingBudgetBytes = remaining, IncomingBytes = requested, IncomingEstimated = estimated, ReservedQueuedBytes = reserved,
        };

        if (free is { } f && budgetClaim > f)
            return Fail("wont-fit", StorageEstimate.WontFitMessage(requested, estimated, reserved, f));
        if (!overrideCap)
        {
            if (used + budgetClaim > maxStorageBytes.Value)
                return Fail("cap", CapMessage(used, maxStorageBytes.Value, requested, estimated, reserved));
            if (free is { } f2 && f2 - budgetClaim < MinFreeBytes)
                return Fail("reserve", StorageEstimate.ReserveMessage(MinFreeBytes));
        }
        return new StorageCheck
        {
            Ok = true, UsedBytes = used, FreeBytes = free, MaxStorageBytes = maxStorageBytes, RemainingBudgetBytes = remaining,
            IncomingBytes = requested, IncomingEstimated = estimated, ReservedQueuedBytes = reserved,
        };
    }

    public static string CapMessage(long used, long cap, long thisDownload, bool estimated, long reservedQueued = 0) =>
        StorageEstimate.CapMessage(used, cap, thisDownload, estimated, reservedQueued);

    public static string FormatBytes(long n) => StorageEstimate.FormatBytes(n);

    /// <summary>Recursive byte count under the download root (its hidden <c>.staging</c> folder included), cached for 30 seconds.</summary>
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
