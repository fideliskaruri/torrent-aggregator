using System.Collections.Immutable;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed class LibraryPlacement(ILibraryRepository repository) : ILibraryPlacement
{
    public Task<ImmutableArray<StorageRootRow>> RootsAsync(CancellationToken ct) => repository.RootsAsync(ct);

    public async Task<LibraryRootResult> AddRootAsync(LibraryRootInput input, CancellationToken ct)
    {
        if (!input.Confirmed) return RootFailure("ConfirmationRequired", "Confirm the drive and folder before adding it.");
        try
        {
            if (!Path.IsPathFullyQualified(input.Path) || input.ReserveBytes < 0 ||
                input.MaxAllocatedBytes is < 0 || input.Kinds.IsDefaultOrEmpty || input.Kinds.Any(k => !Enum.IsDefined(k)) ||
                input.Kinds.Distinct().Count() != input.Kinds.Length)
                return RootFailure("InvalidRoot", "Choose an absolute folder, accepted kinds and a non-negative reserve.");
            var path = Path.GetFullPath(input.Path).TrimEnd(Path.DirectorySeparatorChar);
            if (path == Path.GetPathRoot(path)?.TrimEnd(Path.DirectorySeparatorChar))
                return RootFailure("InvalidRoot", "Choose a folder on the drive, not the drive itself.");
            LibraryPaths.NoLinks(path);
            var folders = input.Folders ?? LibraryPaths.DefaultFolders;
            foreach (var kind in Enum.GetValues<LibraryKind>())
            {
                var folder = LibraryPaths.KindFolder(folders, kind);
                if (string.IsNullOrWhiteSpace(folder)) throw new ArgumentException("Every library kind needs its own folder.");
                _ = LibraryPaths.Within(path, folder);
            }
            var mappings = Enum.GetValues<LibraryKind>().Select(k => LibraryPaths.KindFolder(folders, k)).ToArray();
            if (mappings.Distinct(StringComparer.OrdinalIgnoreCase).Count() != mappings.Length)
                throw new ArgumentException("Library kinds must use separate folders.");
            var mappedPaths = mappings.Select(m => LibraryPaths.Within(path, m)).ToArray();
            if (mappedPaths.Any(a => mappedPaths.Any(b => a != b && LibraryPaths.IsInside(a, b))))
                throw new ArgumentException("Library kind folders cannot be nested inside each other.");
            var roots = await RootsAsync(ct);
            if (roots.Any(r => LibraryPaths.PhysicalKey(path) == r.PhysicalKey ||
                    LibraryPaths.IsInside(r.Path, path) || LibraryPaths.IsInside(path, r.Path)))
                return RootFailure("RootOverlap", "This folder overlaps an existing storage root.");
            Directory.CreateDirectory(path);
            var marker = Path.Combine(path, ".torrentflow-root");
            if (File.Exists(marker)) return RootFailure("RootIdentity", "This folder already belongs to a storage root.");
            var now = DateTimeOffset.UtcNow;
            var id = Guid.NewGuid().ToString("N");
            var volume = LibraryPaths.Volume(path);
            await using (var stream = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                await stream.WriteAsync(System.Text.Encoding.UTF8.GetBytes(id), ct);
            var root = new StorageRootRow { Id = id, Path = path, PhysicalKey = LibraryPaths.PhysicalKey(path), Kinds = input.Kinds, LibraryFolders = folders, VolumeSerial = volume, Priority = input.Priority, ReserveBytes = input.ReserveBytes, MaxAllocatedBytes = input.MaxAllocatedBytes, Enabled = true, Online = true, ReviewRequired = false, LastCheckedAt = now, LastError = null, CreatedAt = now, UpdatedAt = now, Version = 1 };
            if (!await repository.SaveRootAsync(root, null, ct))
            {
                // Remove only our just-created enrollment marker, never a pre-existing file.
                if (await File.ReadAllTextAsync(marker, ct) == id) File.Delete(marker);
                return RootFailure("RootConflict", "The storage settings changed. Reload them and try again.");
            }
            return new(root, null);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        { return RootFailure("InvalidRoot", ex.Message); }
    }

    public async Task<LibraryRootResult> CheckRootAsync(string id, CancellationToken ct)
    {
        var root = (await RootsAsync(ct)).SingleOrDefault(r => r.Id == id);
        if (root is null) return RootFailure("RootNotFound", "This storage root no longer exists.");
        var online = false;
        string? error = null;
        try
        {
            LibraryPaths.NoLinks(root.Path);
            online = Directory.Exists(root.Path) && !root.ReviewRequired &&
                LibraryPaths.PhysicalKey(root.Path) == root.PhysicalKey &&
                LibraryPaths.Volume(root.Path) == root.VolumeSerial &&
                await File.ReadAllTextAsync(Path.Combine(root.Path, ".torrentflow-root"), ct) == root.Id;
            if (!online) error = "Drive is offline. Reconnect the original drive and check it again.";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        { error = "Drive is offline. Reconnect the original drive and check it again."; }
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
        var massVanish = online && (vanished > 20 || inventory.Length > 0 && vanished > inventory.Length * 0.1);
        if (massVanish)
        {
            online = false;
            error = "Files disappeared from this drive. Check the drive and confirm it before continuing.";
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

    public async Task<LibraryRootResult> RemoveRootAsync(string id, CancellationToken ct)
    {
        var root = (await RootsAsync(ct)).SingleOrDefault(r => r.Id == id);
        if (root is null) return RootFailure("RootNotFound", "This storage root no longer exists.");
        if (!await repository.RemoveRootAsync(id, root.Version, ct))
            return RootFailure("RootInUse", "This drive still holds tracked files or downloads. Move or untrack them before removing it.");
        // Removing a root never deletes payload. Remove just its enrollment marker when still on the same volume.
        try
        {
            LibraryPaths.NoLinks(root.Path);
            var marker = Path.Combine(root.Path, ".torrentflow-root");
            if (LibraryPaths.Volume(root.Path) == root.VolumeSerial && File.Exists(marker) &&
                await File.ReadAllTextAsync(marker, ct) == root.Id) File.Delete(marker);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { }
        return new(null, null);
    }

    public async Task<LibraryRootResult> ConfigureRootAsync(string id, LibraryRootConfiguration input, CancellationToken ct)
    {
        var root = (await RootsAsync(ct)).SingleOrDefault(r => r.Id == id);
        if (root is null) return RootFailure("RootNotFound", "This storage root no longer exists.");
        if (input.ExpectedVersion != root.Version || input.ReserveBytes < 0 || input.Kinds.IsDefaultOrEmpty ||
            input.Kinds.Any(k => !Enum.IsDefined(k)) || input.MaxAllocatedBytes is <= 0 ||
            input.Kinds.Distinct().Count() != input.Kinds.Length)
            return RootFailure("InvalidRoot", "Reload the storage settings and choose a non-negative reserve and accepted kinds.");
        var updated = root with { Priority = input.Priority, ReserveBytes = input.ReserveBytes,
            Enabled = input.Enabled, Kinds = input.Kinds, MaxAllocatedBytes = input.MaxAllocatedBytes ?? root.MaxAllocatedBytes,
            UpdatedAt = DateTimeOffset.UtcNow, Version = root.Version + 1 };
        if (input.ConfirmIdentity)
        {
            try
            {
                LibraryPaths.NoLinks(root.Path);
                if (!Directory.Exists(root.Path)) return RootFailure("DriveOffline", "Reconnect the drive before confirming it.");
                var marker = Path.Combine(root.Path, ".torrentflow-root");
                var volume = LibraryPaths.Volume(root.Path);
                if (root.VolumeSerial.Length != 0 && volume != root.VolumeSerial)
                    return RootFailure("RootIdentity", "This is not the original drive.");
                if (File.Exists(marker))
                {
                    if (await File.ReadAllTextAsync(marker, ct) != root.Id)
                        return RootFailure("RootIdentity", "This folder belongs to another storage root.");
                }
                else
                {
                    await using var stream = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                    await stream.WriteAsync(System.Text.Encoding.UTF8.GetBytes(root.Id), ct);
                }
                updated = updated with { VolumeSerial = volume, Online = true, ReviewRequired = false,
                    LastError = null, LastCheckedAt = DateTimeOffset.UtcNow };
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            { return RootFailure("InvalidRoot", ex.Message); }
        }
        return await repository.SaveRootAsync(updated, root.Version, ct) ? new(updated, null) :
            RootFailure("RootConflict", "The storage settings changed. Reload them and try again.");
    }

    public async Task<ImmutableArray<OwnedItem>> OwnedAsync(TargetScope scope, CancellationToken ct)
    {
        var roots = await RootsAsync(ct);
        var videos = (await repository.MediaAsync(scope.WorkId, ct)).Where(m => m.Role == FileRole.Video &&
            (scope.Film ? m.EpisodeId is null : scope.EpisodeIds.IsDefaultOrEmpty ||
                m.EpisodeId is not null && scope.EpisodeIds.Contains(m.EpisodeId)) &&
            (m.Status == FilePresence.Present ||
             m.Status == FilePresence.Offline && (m.RootId is null || roots.Any(r => r.Id == m.RootId && !r.Online)) ||
             m.Status == FilePresence.Missing && m.MissingConfirmedAt is null));
        return [.. videos.GroupBy(m => m.EpisodeId).Select(g => new OwnedItem(scope.WorkId, g.Key,
            [.. g.OrderByDescending(m => m.Resolution ?? 0).ThenBy(m => m.Id)]))];
    }

    public static LibraryOwnedView PublicOwned(OwnedItem item)
    {
        var quality = item.Videos.Max(m => m.Resolution);
        return new(item.WorkId, item.EpisodeId, quality,
            quality is > 0 ? $"In your library, {quality}p" : "In your library",
            [.. item.Videos.Select(m => new LibraryMediaView(m.Id, m.WorkId, m.EpisodeId, m.RootId,
                m.Path, m.Bytes, m.Resolution, m.Source, m.Status, m.DownloadId, m.AddedAt, m.LastSeenAt))]);
    }

    public async Task<Failure?> RecordAsync(MediaFileRow file, WorkFolderRow? folder, CancellationToken ct)
    {
        try
        {
            if (file.Role == FileRole.Unwanted || !Path.IsPathFullyQualified(file.Path) || file.Bytes < 0)
                return Fail("InvalidMedia", "Provide a media file at an absolute path with its actual size.");
            LibraryPaths.NoLinks(file.Path);
            if (file.PhysicalKey != LibraryPaths.PhysicalKey(file.Path))
                return Fail("InvalidMedia", "The file identity does not match its path.");
            var roots = await RootsAsync(ct);
            var root = roots.SingleOrDefault(r => r.Id == file.RootId);
            if (file.RootId is not null)
            {
                if (root is null || !LibraryPaths.IsInside(root.Path, file.Path))
                    return Fail("InvalidMedia", "The file is outside its storage root.");
            }
            else if (roots.Any(r => LibraryPaths.IsInside(r.Path, file.Path)))
                return Fail("InvalidMedia", "This file is inside a storage root. Record it with that root.");
            if (folder is null && file.Role == FileRole.Video && file.EpisodeId is not null &&
                !(await repository.FoldersAsync(ct)).Any(f => f.WorkId == file.WorkId))
            {
                var actual = Path.GetDirectoryName(file.Path)!;
                if (Regex.IsMatch(Path.GetFileName(actual), @"^Season \d+$",
                    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100)))
                    actual = Path.GetDirectoryName(actual)!;
                var now = DateTimeOffset.UtcNow;
                folder = new WorkFolderRow
                {
                    Id = Guid.NewGuid().ToString("N"),
                    WorkId = file.WorkId,
                    RootId = file.RootId,
                    RelativeItemFolder = root is null ? null : Path.GetRelativePath(root.Path, actual),
                    ExternalItemFolder = root is null ? actual : null,
                    CreatedAt = now,
                    UpdatedAt = now,
                    Version = 1,
                };
            }
            if (folder is not null && (folder.WorkId != file.WorkId || folder.RootId != file.RootId))
                return Fail("InvalidMedia", "The title folder and file must belong to the same work and root.");
            if (folder is not null)
            {
                var itemFolder = root is null ? folder.ExternalItemFolder :
                    folder.RelativeItemFolder is null ? null : LibraryPaths.Within(root.Path, folder.RelativeItemFolder);
                if (itemFolder is null || !Path.IsPathFullyQualified(itemFolder) || !LibraryPaths.IsInside(itemFolder, file.Path))
                    return Fail("InvalidMedia", "The file is not inside its recorded title folder.");
            }
            if (file.Status == FilePresence.Present)
            {
                var info = new FileInfo(file.Path);
                if (!info.Exists || info.Length != file.Bytes)
                    return Fail("FileChanged", "The file is missing or changed. Scan it again.");
                file = file with { MtimeUtc = info.LastWriteTimeUtc, LastSeenAt = DateTimeOffset.UtcNow,
                    MissingSince = null, MissingConfirmedAt = null };
            }
            return await repository.RecordAsync(file, folder, ct) ? null :
                Fail("InventoryConflict", "The library changed or the work is not recorded. Reload it and try again.");
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException)
        { return Fail("InvalidMedia", ex.Message); }
    }

    public Task<int> PruneMissingAsync(DateTimeOffset now, CancellationToken ct) =>
        repository.PruneMissingAsync(now.AddDays(-30), ct);

    public async Task<PlacementResult> PlaceAsync(PlacementInput input, CancellationToken ct)
    {
        PlacementResult Rejected(string code, string message) => new([], null, 0, [], Fail(code, message));
        static PlacementResult Waiting(WaitReason reason, string message) =>
            new([], null, 0, [], new Failure(reason.ToString(), message, null, false));
        if (input.Work is not { } work || input.Targets.IsDefaultOrEmpty || input.Assignment.Files.IsDefaultOrEmpty)
            return Rejected("MappingUncertain", "Choose a work and map each selected video to its film or episode.");
        try
        {
            var selected = input.Assignment.Files;
            if (work.Work.Kind == WorkKind.Unknown || input.Files.IsDefaultOrEmpty ||
                input.Targets.Select(t => t.Id).Distinct().Count() != input.Targets.Length ||
                input.Files.Any(f => f.Index < 0 || f.Bytes < 0 || f.Offset < 0) ||
                input.Files.Select(f => f.Index).Distinct().Count() != input.Files.Length ||
                selected.Select(s => s.FileIndex).Distinct().Count() != selected.Length ||
                selected.Any(s => !input.Files.Any(f => f.Index == s.FileIndex) || s.Role == FileRole.Unwanted ||
                    !input.Targets.Any(t => t.Id == s.TargetId && t.WorkId == work.Work.Id)))
                return Rejected("MappingUncertain", "The selected files must map to this work's targets.");
            var film = work.Work.Kind == WorkKind.Film;
            var kind = input.ExplicitKind ?? (work.Work.Anime == true ?
                film ? LibraryKind.AnimeMovies : LibraryKind.Anime : film ? LibraryKind.Movies : LibraryKind.TV);
            var title = work.Names.Where(n => n.Label == NameLabel.English).OrderBy(n => n.Ordinal).FirstOrDefault()?.Value ??
                work.Names.OrderBy(n => n.Ordinal).FirstOrDefault()?.Value ?? "";
            var roots = await RootsAsync(ct);
            var folders = await repository.FoldersAsync(ct);
            var pin = folders.SingleOrDefault(f => f.WorkId == work.Work.Id);
            var media = await repository.MediaAsync(work.Work.Id, ct);
            if (!film && pin?.ExternalItemFolder is not null)
                return Rejected("PlacementRequired", "This series is tracked outside the library. Choose where to place new episodes.");
            var selectedSeasons = work.Episodes.Where(e => input.Targets.Any(t => t.EpisodeId == e.Id))
                .Select(e => e.SeasonId).ToHashSet();
            var existing = !film ? media.Where(m => m.Role == FileRole.Video && m.RootId is not null)
                .GroupBy(m => m.RootId!).OrderByDescending(g => g.Count(m =>
                    work.Episodes.Any(e => e.Id == m.EpisodeId && selectedSeasons.Contains(e.SeasonId))))
                .ThenByDescending(g => g.Count())
                .ThenBy(g => roots.FirstOrDefault(r => r.Id == g.Key)?.Priority ?? int.MaxValue).ThenBy(g => g.Key).FirstOrDefault() : null;
            var pinnedRoot = pin?.RootId ?? existing?.Key;
            if (pinnedRoot is not null && input.ExplicitRootId is not null && input.ExplicitRootId != pinnedRoot)
                return Rejected("TitlePinned", "This title already has a drive. Move the title explicitly before choosing another.");
            var requiredRoot = pinnedRoot ?? input.ExplicitRootId;
            var size = selected.Sum(s => input.Files.Single(f => f.Index == s.FileIndex).Bytes);
            var reserve = Math.Max(size, input.Assignment.ReservedPieceBytes);
            var reservations = await repository.ReservationsAsync(ct);
            StorageRootRow? chosen = null;
            var requiredOffline = false;
            foreach (var candidate in roots.Where(r => requiredRoot is null || r.Id == requiredRoot)
                         .OrderBy(r => r.Priority).ThenBy(r => r.Id))
            {
                if (!candidate.Enabled || !candidate.Kinds.Contains(kind)) continue;
                var checkedRoot = await CheckRootAsync(candidate.Id, ct);
                var root = checkedRoot.Root;
                if (root is null || !root.Online)
                {
                    if (requiredRoot is not null) requiredOffline = true;
                    continue;
                }
                var outstanding = roots.Where(r => r.VolumeSerial == root.VolumeSerial)
                    .Sum(r => reservations.GetValueOrDefault(r.Id));
                var free = LibraryPaths.FreeBytes(root.Path);
                if (reserve > free || outstanding > free - reserve || root.ReserveBytes > free - reserve - outstanding) continue;
                if (root.MaxAllocatedBytes is { } cap)
                {
                    // Physical folder allocation and outstanding reservations, never progress estimates.
                    var allocated = InventoryBytes(root.Path);
                    if (reserve > cap || allocated > cap - reserve || outstanding > cap - reserve - allocated) continue;
                }
                chosen = root;
                break;
            }
            if (chosen is null)
            {
                var pinned = roots.FirstOrDefault(r => r.Id == requiredRoot);
                if (requiredRoot is not null && (requiredOffline || pinned is null || !pinned.Online))
                    return Waiting(WaitReason.DriveOffline, "Drive is offline");
                return Waiting(WaitReason.NoDriveSpace, "No drive has space");
            }
            var itemRelative = pin?.RelativeItemFolder;
            if (itemRelative is null && existing is not null)
            {
                var old = Path.GetDirectoryName(existing.First().Path)!;
                if (Regex.IsMatch(Path.GetFileName(old), @"^Season \d+$", RegexOptions.CultureInvariant))
                    old = Path.GetDirectoryName(old)!;
                itemRelative = Path.GetRelativePath(chosen.Path, old);
            }
            itemRelative ??= Path.Combine(LibraryPaths.KindFolder(chosen.LibraryFolders, kind),
                LibraryPaths.ItemFolder(title, work.Work.Id, work.Work.Year, film));
            if (folders.Any(f => f.WorkId != work.Work.Id && f.RootId == chosen.Id &&
                LibraryPaths.PhysicalKey(LibraryPaths.Within(chosen.Path, f.RelativeItemFolder!)) ==
                LibraryPaths.PhysicalKey(LibraryPaths.Within(chosen.Path, itemRelative))))
                return Rejected("TitleCollision", "Another title uses this folder. Choose a separate title folder.");
            var itemFolder = LibraryPaths.Within(chosen.Path, itemRelative);
            if (input.ExplicitDirectory is not null && LibraryPaths.PhysicalKey(input.ExplicitDirectory) != LibraryPaths.PhysicalKey(itemFolder))
                return Rejected("PlacementRequired", "The explicit folder does not match this title's managed library folder.");
            var now = DateTimeOffset.UtcNow;
            var proposedPin = pin ?? new WorkFolderRow { Id = Guid.NewGuid().ToString("N"), WorkId = work.Work.Id, RootId = chosen.Id, RelativeItemFolder = itemRelative, ExternalItemFolder = null, CreatedAt = now, UpdatedAt = now, Version = 1 };
            var bindings = await repository.BindingsAsync(ct);
            var used = new HashSet<string>(StringComparer.Ordinal);
            var output = ImmutableArray.CreateBuilder<DownloadFileRow>();
            foreach (var target in input.Targets.Where(t => selected.Any(s => s.TargetId == t.Id)))
            {
                if (!selected.Any(s => s.TargetId == target.Id && s.Role == FileRole.Video))
                    return Rejected("MappingUncertain", "Every selected item needs its own video.");
                var episode = target.EpisodeId is null ? null : work.Episodes.SingleOrDefault(e => e.Id == target.EpisodeId);
                var season = episode is null ? null : work.Seasons.SingleOrDefault(s => s.Id == episode.SeasonId);
                if (!film && season is null || film && target.EpisodeId is not null)
                    return Rejected("MappingUncertain", "A selected item has no confirmed season and episode.");
                var destination = film ? itemFolder : LibraryPaths.Within(itemFolder, $"Season {season!.Number:00}");
                var mapped = LibraryLayout.Names(input.Files, selected.Where(s => s.TargetId == target.Id).ToImmutableArray(), destination);
                foreach (var selection in selected.Where(s => s.TargetId == target.Id))
                {
                    var file = input.Files.Single(f => f.Index == selection.FileIndex);
                    var final = LibraryPaths.Within(destination, mapped[file.Index]);
                    var key = LibraryPaths.PhysicalKey(final);
                    var replacing = target.ChosenReleaseHash is { } current && current != input.Assignment.Hash &&
                        bindings.Any(b => b.TargetId == target.Id &&
                            (b.PhysicalKey == key || b.FinalPath is { } oldFinal && LibraryPaths.PhysicalKey(oldFinal) == key));
                    if (replacing)
                    {
                        // A replacement reserves its own final and partial. Publication is
                        // still a no-overwrite atomic rename; the old release stays intact.
                        var suffix = input.Assignment.Hash;
                        final = Path.Combine(Path.GetDirectoryName(final)!,
                            $"{Path.GetFileNameWithoutExtension(final)} [{suffix}]{Path.GetExtension(final)}");
                        key = LibraryPaths.PhysicalKey(final);
                    }
                    if (!used.Add(key) || File.Exists(final) || Directory.Exists(final) || File.Exists(final + ".partial") ||
                        bindings.Any(b => b.PhysicalKey == key) || media.Any(m => m.PhysicalKey == key))
                        return Rejected("FileCollision", "A file already uses the destination name. Review the duplicate before downloading.");
                    output.Add(new DownloadFileRow
                    {
                        Id = $"placement:{input.Assignment.Hash}:{file.Index}",
                        DownloadId = input.Assignment.Hash,
                        FileIndex = file.Index,
                        Selected = true,
                        TargetId = target.Id,
                        PartialPath = final + ".partial",
                        FinalPath = final,
                        PhysicalKey = key,
                        MediaFileId = null,
                        Role = selection.Role,
                        ExpectedBytes = file.Bytes,
                        EnginePath = final + ".partial",
                        Filed = false,
                    });
                }
            }
            return new(output.ToImmutable(), chosen.Id, reserve, [proposedPin], null);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or OverflowException)
        { return Rejected("InvalidPath", "The library folder or file list could not be used. " + ex.Message); }
    }

    private static long InventoryBytes(string path)
    {
        LibraryPaths.NoLinks(path);
        long bytes = 0;
        foreach (var entry in Directory.EnumerateFileSystemEntries(path))
        {
            LibraryPaths.NoLinks(entry);
            bytes = checked(bytes + (Directory.Exists(entry) ? InventoryBytes(entry) : new FileInfo(entry).Length));
        }
        return bytes;
    }

    private static Failure Fail(string code, string message) => new(code, message, null, true);
    private static LibraryRootResult RootFailure(string code, string message) => new(null, Fail(code, message));
}
