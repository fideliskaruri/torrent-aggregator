using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public static class StorageCapacity
{
    public static long CommittedBytes(string rootId, IEnumerable<DownloadRow> downloads,
        IEnumerable<DownloadFileRow> bindings)
    {
        var ids = downloads.Where(d => d.RootId == rootId).Select(d => d.Id).ToHashSet(StringComparer.Ordinal);
        return bindings.Where(f => ids.Contains(f.DownloadId) && f.Selected && !f.Filed)
            .Sum(f => Math.Max(0, f.ExpectedBytes -
                (f.PartialPath is { } path ? PhysicalFiles.AllocatedBytes(path) : 0)));
    }

    public static long EffectiveReserve(StorageRootRow root, long? totalBytes)
    {
        if (root.ReserveBytes > 0) return root.ReserveBytes;
        if (totalBytes is not { } capacity || capacity < 0)
        {
            try { capacity = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(root.Path))!).TotalSize; }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            { capacity = 0; }
        }
        return Math.Min(50_000_000_000L, capacity / 10);
    }
}
