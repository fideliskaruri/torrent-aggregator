using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed partial class LibraryPlacement
{
    public Task<ImmutableArray<StorageRootRow>> RootsAsync(CancellationToken ct) => repository.RootsAsync(ct);

    public async Task<LibraryRootResult> SetDownloadRootAsync(string path, long? maxBytes, CancellationToken ct)
    {
        try
        {
            if (!Path.IsPathFullyQualified(path) || maxBytes is <= 0)
                return RootFailure("InvalidRoot", "Choose a full download folder and a positive storage limit.");
            path = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var roots = await repository.RootsAsync(ct);
            var current = roots.FirstOrDefault(r => r.Priority == 0);
            ValidateRootPath(path, roots, current?.Id);
            LibraryPaths.NoLinks(path);
            var now = DateTimeOffset.UtcNow;
            Directory.CreateDirectory(path);
            var serial = LibraryPaths.Volume(path);
            if (current is not null)
            {
                if (LibraryPaths.PhysicalKey(path) != current.PhysicalKey)
                {
                    var media = (await repository.MediaAsync(null, ct)).Any(m => m.RootId == current.Id);
                    var files = (await repository.BindingsAsync(ct)).Any(f =>
                        new[] { f.FinalPath, f.EnginePath, f.PartialPath }.OfType<string>()
                            .Any(p => LibraryPaths.IsInside(current.Path, p)));
                    if (media || files)
                        return RootFailure("RootInUse", "Remove or move the files using this location before changing its path.");
                }
                StorageIdentity.WriteMarker(path, current.Id, serial);
                var updated = current with { Path = path, PhysicalKey = LibraryPaths.PhysicalKey(path),
                    VolumeSerial = serial, MaxAllocatedBytes = maxBytes ?? current.MaxAllocatedBytes, Enabled = true,
                    Online = true, ReviewRequired = false, LastError = null, LastCheckedAt = now,
                    UpdatedAt = now, Version = current.Version + 1 };
                if (!await repository.SaveRootAsync(updated, current.Version, ct))
                    return RootFailure("RootConflict", "The storage settings changed. Reload them and try again.");
                storage.Update(path, true, ReadFreeBytes(path));
                return new(updated, null);
            }
            var root = new StorageRootRow
            {
                Id = Guid.NewGuid().ToString("N"), Path = path, PhysicalKey = LibraryPaths.PhysicalKey(path),
                Kinds = [.. Enum.GetValues<LibraryKind>()], LibraryFolders = LibraryPaths.DefaultFolders,
                VolumeSerial = serial, Priority = 0, ReserveBytes = 0, MaxAllocatedBytes = maxBytes,
                Enabled = true, Online = true, ReviewRequired = false, LastCheckedAt = now, LastError = null,
                CreatedAt = now, UpdatedAt = now, Version = 1,
            };
            StorageIdentity.WriteMarker(path, root.Id, serial);
            if (!await repository.SaveRootAsync(root, null, ct))
                return RootFailure("RootConflict", "The storage settings changed. Reload them and try again.");
            storage.Update(path, true, ReadFreeBytes(path));
            return new(root, null);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        { return RootFailure("InvalidRoot", ex.Message); }
    }

    public async Task<LibraryRootResult> AddRootAsync(LibraryRootInput input, CancellationToken ct)
    {
        try
        {
            if (!Path.IsPathFullyQualified(input.Path))
                return RootFailure("InvalidRoot", "Choose the full path to a folder, not a relative path.");
            if (input.ReserveBytes < 0 || input.MaxAllocatedBytes is <= 0 ||
                input.Kinds.IsDefaultOrEmpty || input.Kinds.Any(k => !Enum.IsDefined(k)) ||
                input.Kinds.Distinct().Count() != input.Kinds.Length)
                return RootFailure("InvalidRoot", "Choose at least one valid library type and non-negative limits.");
            var roots = await repository.RootsAsync(ct);
            var path = Path.GetFullPath(input.Path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            ValidateRootPath(path, roots, null);
            LibraryPaths.NoLinks(path);
            Directory.CreateDirectory(path);
            var now = DateTimeOffset.UtcNow;
            var serial = LibraryPaths.Volume(path);
            var root = new StorageRootRow
            {
                Id = Guid.NewGuid().ToString("N"), Path = path, PhysicalKey = LibraryPaths.PhysicalKey(path),
                Kinds = input.Kinds, LibraryFolders = input.Folders ?? LibraryPaths.DefaultFolders,
                VolumeSerial = serial, Priority = roots.IsEmpty ? 0 : roots.Max(r => r.Priority) + 1,
                ReserveBytes = input.ReserveBytes, MaxAllocatedBytes = input.MaxAllocatedBytes,
                Enabled = true, Online = true, ReviewRequired = false, LastCheckedAt = now, LastError = null,
                CreatedAt = now, UpdatedAt = now, Version = 1,
            };
            StorageIdentity.WriteMarker(path, root.Id, serial);
            if (!await repository.SaveRootAsync(root, null, ct))
                return RootFailure("RootConflict", "This location could not be saved. Refresh the list and try again.");
            storage.Update(path, true, ReadFreeBytes(path));
            return new(root, null);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        { return RootFailure("InvalidRoot", ex.Message); }
    }

    public async Task<LibraryRootResult> CheckRootAsync(string id, CancellationToken ct)
    {
        var root = (await repository.RootsAsync(ct)).SingleOrDefault(r => r.Id == id);
        if (root is null) return RootFailure("RootNotFound", "This storage location no longer exists.");
        var online = false;
        string? error = null;
        string? actualSerial = null;
        var legacyMarker = false;
        var identityMismatch = false;
        try
        {
            LibraryPaths.NoLinks(root.Path);
            actualSerial = LibraryPaths.Volume(root.Path);
            var markerExists = File.Exists(StorageIdentity.MarkerPath(root.Path));
            legacyMarker = string.IsNullOrEmpty(root.VolumeSerial) && !markerExists;
            var identityMatches = legacyMarker || actualSerial == root.VolumeSerial &&
                StorageIdentity.MarkerMatches(root.Path, root.Id, root.VolumeSerial);
            identityMismatch = Directory.Exists(root.Path) && !identityMatches;
            online = Directory.Exists(root.Path) && !root.ReviewRequired && identityMatches;
            if (!online) error = root.ReviewRequired || identityMismatch
                ? "Check needed. Confirm that this is the correct storage location."
                : "This location is offline. Reconnect it and check again.";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        { error = "This location is offline. Reconnect it and check again."; }

        var now = DateTimeOffset.UtcNow;
        var inventory = (await repository.MediaAsync(null, ct)).Where(m => m.RootId == id).ToArray();
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
            error = $"Check needed. {vanished} files are missing. Confirm the location after checking the drive.";
        }
        var updated = root with { Online = online,
            ReviewRequired = root.ReviewRequired || massVanish || identityMismatch,
            VolumeSerial = online && legacyMarker ? actualSerial! : root.VolumeSerial,
            LastError = error, LastCheckedAt = now, UpdatedAt = now, Version = root.Version + 1 };
        var changes = inventory.Select(m => (File: m, Status: massVanish
                ? seen.Contains(m.Id) ? FilePresence.Present : FilePresence.Missing
                : online ? seen.Contains(m.Id) ? FilePresence.Present : FilePresence.Missing
                    : FilePresence.Offline))
            .Where(item => item.File.Status != item.Status)
            .Select(item => item.File with { Status = item.Status,
                LastSeenAt = item.Status == FilePresence.Present ? now : item.File.LastSeenAt,
                MissingSince = item.Status == FilePresence.Missing ? item.File.MissingSince ?? now : null,
                MissingConfirmedAt = item.Status == FilePresence.Present ? null : item.File.MissingConfirmedAt,
                Version = item.File.Version + 1 }).ToImmutableArray();
        if (!await repository.SaveRootCheckAsync(updated, root.Version, changes, ct))
            return RootFailure("RootConflict", "The storage settings changed. Reload them and try again.");
        if (online && legacyMarker) StorageIdentity.WriteMarker(root.Path, root.Id, actualSerial!);
        storage.Update(root.Path, online, online ? ReadFreeBytes(root.Path) : null);
        return new(updated, null);
    }

    public async Task<LibraryRootResult> ConfigureRootAsync(string id, LibraryRootConfiguration input, CancellationToken ct)
    {
        var root = (await repository.RootsAsync(ct)).SingleOrDefault(r => r.Id == id);
        if (root is null) return RootFailure("RootNotFound", "This storage location no longer exists.");
        if (input.ExpectedVersion != root.Version || input.Priority != root.Priority ||
            input.ReserveBytes < 0 || input.MaxAllocatedBytes is <= 0 || input.Kinds.IsDefaultOrEmpty ||
            input.Kinds.Any(k => !Enum.IsDefined(k)) || input.Kinds.Distinct().Count() != input.Kinds.Length)
            return RootFailure("InvalidSettings", "Reload the location, choose valid settings, and try again.");
        var updated = root with { ReserveBytes = input.ReserveBytes,
            MaxAllocatedBytes = input.ClearMaxAllocatedBytes ? null : input.MaxAllocatedBytes ?? root.MaxAllocatedBytes,
            Enabled = input.Enabled, Kinds = input.Kinds, UpdatedAt = DateTimeOffset.UtcNow,
            Version = root.Version + 1 };
        if (input.ConfirmIdentity)
        {
            try
            {
                LibraryPaths.NoLinks(root.Path);
                if (!Directory.Exists(root.Path))
                    return RootFailure("DriveOffline", "Reconnect this location before confirming its identity.");
                var serial = LibraryPaths.Volume(root.Path);
                StorageIdentity.WriteMarker(root.Path, root.Id, serial);
                updated = updated with { VolumeSerial = serial, Online = true, ReviewRequired = false,
                    LastError = null, LastCheckedAt = DateTimeOffset.UtcNow };
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            { return RootFailure("InvalidRoot", ex.Message); }
        }
        if (!await repository.SaveRootAsync(updated, root.Version, ct))
            return RootFailure("RootConflict", "The storage settings changed. Reload them and try again.");
        if (input.ConfirmIdentity) storage.Update(root.Path, true, ReadFreeBytes(root.Path));
        else if (!input.Enabled) storage.Update(root.Path, false, null);
        else if (!root.Enabled && updated is { Online: true, ReviewRequired: false } && QuickIdentityMatches(updated))
            storage.Update(root.Path, true, ReadFreeBytes(root.Path));
        return new(updated, null);
    }

    public async Task<LibraryRootResult> RemoveRootAsync(string id, CancellationToken ct)
    {
        var roots = await repository.RootsAsync(ct);
        var root = roots.SingleOrDefault(r => r.Id == id);
        if (root is null) return RootFailure("RootNotFound", "This storage location no longer exists.");
        if (roots.Length <= 1)
            return RootFailure("LastRoot", "Keep at least one storage location. Turn off this location after adding another.");
        if (root.Enabled && roots.Count(r => r.Enabled) <= 1)
            return RootFailure("LastRoot", "Keep at least one location enabled. Turn off this location only after enabling another.");
        if ((await repository.MediaAsync(null, ct)).Any(m => m.RootId == id))
            return RootFailure("RootInUse", "Remove or move the titles stored here before removing this location. You can turn it off instead.");
        if (!await repository.RemoveRootAsync(id, root.Version, ct))
            return RootFailure("RootInUse", "Remove or move unfinished downloads using this location first. You can turn it off instead.");
        return new(null, null);
    }

    public Task<bool> ReorderRootsAsync(ImmutableArray<string> ids, CancellationToken ct) =>
        repository.ReorderRootsAsync(ids, ct);

    private static void ValidateRootPath(string path, ImmutableArray<StorageRootRow> roots, string? exceptId)
    {
        if (path == Path.GetPathRoot(path)?.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
            throw new ArgumentException("Choose a folder on the drive, not the drive root.");
        var key = LibraryPaths.PhysicalKey(path);
        foreach (var root in roots.Where(r => r.Id != exceptId))
            if (key == root.PhysicalKey || LibraryPaths.IsInside(root.Path, path) || LibraryPaths.IsInside(path, root.Path))
                throw new ArgumentException($"This folder overlaps the storage location {root.Path}. Choose a separate folder.");
    }

    private static long? ReadFreeBytes(string path)
    {
        try { return LibraryPaths.FreeBytes(path); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { return null; }
    }

    private static bool QuickIdentityMatches(StorageRootRow root)
    {
        try
        {
            LibraryPaths.NoLinks(root.Path);
            return Directory.Exists(root.Path) && LibraryPaths.Volume(root.Path) == root.VolumeSerial &&
                StorageIdentity.MarkerMatches(root.Path, root.Id, root.VolumeSerial);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { return false; }
    }
}
