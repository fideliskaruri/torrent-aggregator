using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed partial class LibraryPlacement
{
    public async Task<ImmutableArray<StorageRootRow>> RootsAsync(CancellationToken ct)
    {
        var root = (await repository.RootsAsync(ct)).Where(r => r.Enabled).OrderBy(r => r.Id).FirstOrDefault();
        return root is null ? [] : [root];
    }

    public async Task<LibraryRootResult> SetDownloadRootAsync(string path, long? maxBytes, CancellationToken ct)
    {
        try
        {
            if (!Path.IsPathFullyQualified(path) || maxBytes is <= 0)
                return RootFailure("InvalidRoot", "Choose a full download folder and a positive storage limit.");
            path = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar);
            if (path == Path.GetPathRoot(path)?.TrimEnd(Path.DirectorySeparatorChar))
                return RootFailure("InvalidRoot", "Choose a folder on the drive, not the drive itself.");
            LibraryPaths.NoLinks(path);
            var current = (await repository.RootsAsync(ct)).OrderBy(r => r.Id).FirstOrDefault();
            var now = DateTimeOffset.UtcNow;
            if (current is not null)
            {
                if (LibraryPaths.PhysicalKey(path) != current.PhysicalKey)
                {
                    var media = (await repository.MediaAsync(null, ct)).Any(m => m.RootId == current.Id);
                    var files = (await repository.BindingsAsync(ct)).Any(f =>
                        new[] { f.FinalPath, f.EnginePath, f.PartialPath }.OfType<string>()
                            .Any(p => LibraryPaths.IsInside(current.Path, p)));
                    if (media || files)
                        return RootFailure("RootInUse", "The download folder cannot change while files are tracked there.");
                }
                Directory.CreateDirectory(path);
                var updated = current with { Path = path, PhysicalKey = LibraryPaths.PhysicalKey(path),
                    LibraryFolders = LibraryPaths.DefaultFolders, VolumeSerial = "", Kinds = [.. Enum.GetValues<LibraryKind>()],
                    MaxAllocatedBytes = maxBytes ?? current.MaxAllocatedBytes, Enabled = true, Online = true,
                    ReviewRequired = false, LastError = null, LastCheckedAt = now, UpdatedAt = now,
                    Version = current.Version + 1 };
                return await repository.SaveRootAsync(updated, current.Version, ct) ? new(updated, null) :
                    RootFailure("RootConflict", "The storage settings changed. Reload them and try again.");
            }
            Directory.CreateDirectory(path);
            var root = new StorageRootRow
            {
                Id = Guid.NewGuid().ToString("N"), Path = path, PhysicalKey = LibraryPaths.PhysicalKey(path),
                Kinds = [.. Enum.GetValues<LibraryKind>()], LibraryFolders = LibraryPaths.DefaultFolders,
                VolumeSerial = "", Priority = 0, ReserveBytes = 0, MaxAllocatedBytes = maxBytes,
                Enabled = true, Online = true, ReviewRequired = false, LastCheckedAt = now, LastError = null,
                CreatedAt = now, UpdatedAt = now, Version = 1,
            };
            return await repository.SaveRootAsync(root, null, ct) ? new(root, null) :
                RootFailure("RootConflict", "The storage settings changed. Reload them and try again.");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        { return RootFailure("InvalidRoot", ex.Message); }
    }

    public Task<LibraryRootResult> AddRootAsync(LibraryRootInput input, CancellationToken ct) =>
        Task.FromResult(RootFailure("NotAvailable", "Additional storage roots are not available in v1. Use Client settings."));

    public async Task<LibraryRootResult> CheckRootAsync(string id, CancellationToken ct)
    {
        var root = (await RootsAsync(ct)).SingleOrDefault(r => r.Id == id);
        if (root is null) return RootFailure("RootNotFound", "This download folder no longer exists.");
        var online = false;
        string? error = null;
        try
        {
            LibraryPaths.NoLinks(root.Path);
            online = Directory.Exists(root.Path) && !root.ReviewRequired &&
                LibraryPaths.PhysicalKey(root.Path) == root.PhysicalKey;
            if (!online) error = "Drive is offline. Reconnect the original download folder and check it again.";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        { error = "Drive is offline. Reconnect the original download folder and check it again."; }
        var now = DateTimeOffset.UtcNow;
        var inventory = (await repository.MediaAsync(null, ct)).Where(m => m.RootId == id &&
            m.Status is FilePresence.Present or FilePresence.Offline).ToArray();
        var seen = new HashSet<string>();
        if (online)
        {
            foreach (var file in inventory)
            {
                try
                {
                    LibraryPaths.NoLinks(file.Path);
                    var info = new FileInfo(file.Path);
                    if (info.Exists && info.Length == file.Bytes) seen.Add(file.Id);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { }
            }
        }
        var vanished = inventory.Length - seen.Count;
        var massVanish = online && (vanished > 20 || inventory.Length > 0 && vanished > inventory.Length * .1);
        if (massVanish)
        {
            online = false;
            error = "Files disappeared from this download folder. Check it and confirm it before continuing.";
        }
        var updated = root with { Online = online, ReviewRequired = root.ReviewRequired || massVanish,
            LastError = error, LastCheckedAt = now, UpdatedAt = now, Version = root.Version + 1 };
        var changes = inventory.Where(m => !online && m.Status != FilePresence.Offline ||
                online && seen.Contains(m.Id) && m.Status == FilePresence.Offline)
            .Select(m => m with { Status = online ? FilePresence.Present : FilePresence.Offline,
                LastSeenAt = online ? now : m.LastSeenAt, Version = m.Version + 1 }).ToImmutableArray();
        return await repository.SaveRootCheckAsync(updated, root.Version, changes, ct) ? new(updated, null) :
            RootFailure("RootConflict", "The storage settings changed. Reload them and try again.");
    }

    public async Task<LibraryRootResult> ConfigureRootAsync(string id, LibraryRootConfiguration input, CancellationToken ct)
    {
        var root = (await RootsAsync(ct)).SingleOrDefault(r => r.Id == id);
        if (root is null) return RootFailure("RootNotFound", "This download folder no longer exists.");
        if (input.ExpectedVersion != root.Version || input.ReserveBytes < 0 || input.Kinds.IsDefaultOrEmpty ||
            input.Kinds.Any(k => !Enum.IsDefined(k)) || input.Kinds.Distinct().Count() != input.Kinds.Length ||
            input.Priority != root.Priority || input.ReserveBytes != root.ReserveBytes || !input.Enabled ||
            input.Kinds.Length != root.Kinds.Length || input.Kinds.Except(root.Kinds).Any())
            return RootFailure("NotAvailable", "Priority, multiple roots and per-root settings are not available in v1.");
        var updated = root with { MaxAllocatedBytes = input.MaxAllocatedBytes ?? root.MaxAllocatedBytes,
            UpdatedAt = DateTimeOffset.UtcNow, Version = root.Version + 1 };
        if (input.ConfirmIdentity)
        {
            try
            {
                LibraryPaths.NoLinks(root.Path);
                if (!Directory.Exists(root.Path)) return RootFailure("DriveOffline", "Reconnect the download folder first.");
                updated = updated with { Online = true, ReviewRequired = false, LastError = null, LastCheckedAt = DateTimeOffset.UtcNow };
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            { return RootFailure("InvalidRoot", ex.Message); }
        }
        return await repository.SaveRootAsync(updated, root.Version, ct) ? new(updated, null) :
            RootFailure("RootConflict", "The storage settings changed. Reload them and try again.");
    }

    public Task<LibraryRootResult> RemoveRootAsync(string id, CancellationToken ct) =>
        Task.FromResult(RootFailure("NotAvailable", "The download folder cannot be removed here. Change it in Client settings."));
}
