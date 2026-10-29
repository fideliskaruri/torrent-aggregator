using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed partial class LibraryPlacement(ILibraryRepository repository, IStorageStatus storage) : ILibraryPlacement
{
    public async Task<PlacementResult> PlaceAsync(PlacementInput input, CancellationToken ct)
    {
        static PlacementResult Reject(string code, string message) =>
            new([], null, 0, [], new Failure(code, message, null, true));
        static PlacementResult Wait(WaitReason reason, string message) =>
            new([], null, 0, [], new Failure(reason.ToString(), message, null, false));
        if (input.Work is not { } work || input.Targets.IsDefaultOrEmpty ||
            input.Assignment.Files.IsDefaultOrEmpty || input.Files.IsDefaultOrEmpty)
            return Reject("MappingUncertain", "Choose a work and map each selected video to its film or episode.");
        try
        {
            var selected = input.Assignment.Files;
            if (work.Work.Kind == WorkKind.Unknown ||
                input.Targets.Select(t => t.Id).Distinct().Count() != input.Targets.Length ||
                input.Files.Any(f => f.Index < 0 || f.Bytes < 0 || f.Offset < 0) ||
                input.Files.Select(f => f.Index).Distinct().Count() != input.Files.Length ||
                selected.Select(s => s.FileIndex).Distinct().Count() != selected.Length ||
                selected.Any(s => !input.Files.Any(f => f.Index == s.FileIndex) || s.Role == FileRole.Unwanted ||
                    !input.Targets.Any(t => t.Id == s.TargetId && t.WorkId == work.Work.Id)))
                return Reject("MappingUncertain", "The selected files must map to this work's targets.");

            var roots = (await RootsAsync(ct)).Where(r => r.Enabled)
                .OrderBy(r => r.Priority).ThenBy(r => r.Id, StringComparer.Ordinal).ToArray();
            if (input.ExplicitRootId is not null && roots.All(r => r.Id != input.ExplicitRootId))
                return Reject("PlacementRequired", "Choose an enabled storage location from Settings.");
            var kind = input.ExplicitKind ?? (work.Work.Anime == true
                ? work.Work.Kind == WorkKind.Film ? LibraryKind.AnimeMovies : LibraryKind.Anime
                : work.Work.Kind == WorkKind.Film ? LibraryKind.Movies : LibraryKind.TV);
            roots = input.ExplicitRootId is null ? roots :
                roots.Where(r => r.Id == input.ExplicitRootId).ToArray();
            var accepting = roots.Where(r => r.Kinds.Contains(kind)).ToArray();
            if (accepting.Length == 0) return Wait(WaitReason.NoDriveSpace, $"No location takes {KindName(kind)}.");

            var pins = (await repository.FoldersAsync(ct)).Where(f => f.WorkId == work.Work.Id && f.RootId is not null)
                .ToArray();
            var pinnedIds = pins.Select(f => f.RootId!).ToHashSet(StringComparer.Ordinal);
            var media = await repository.MediaAsync(work.Work.Id, ct);
            var targetEpisodes = input.Targets.Where(t => t.EpisodeId is not null)
                .Select(t => t.EpisodeId!).ToHashSet(StringComparer.Ordinal);
            var selectedSeasonCounts = media.Where(m => m.RootId is not null &&
                    m.EpisodeId is not null && targetEpisodes.Contains(m.EpisodeId))
                .GroupBy(m => m.RootId!).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
            var fileCounts = media.Where(m => m.RootId is not null).GroupBy(m => m.RootId!)
                .ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
            var candidates = accepting.OrderByDescending(r => pinnedIds.Contains(r.Id))
                .ThenByDescending(r => selectedSeasonCounts.GetValueOrDefault(r.Id) > 0)
                .ThenByDescending(r => selectedSeasonCounts.GetValueOrDefault(r.Id))
                .ThenByDescending(r => pinnedIds.Contains(r.Id) ? fileCounts.GetValueOrDefault(r.Id) : -1)
                .ThenBy(r => r.Priority).ThenBy(r => r.Id, StringComparer.Ordinal).ToArray();
            var pinnedOffline = accepting.Where(r => pinnedIds.Contains(r.Id) && !storage.IsOnline(r.Path)).ToArray();
            if (pinnedOffline.Length > 0)
                return Wait(WaitReason.DriveOffline, $"Waiting for drive {storage.Label(pinnedOffline[0].Path)}.");

            var film = work.Work.Kind == WorkKind.Film;
            var bytes = selected.Sum(s => input.Files.Single(f => f.Index == s.FileIndex).Bytes);
            var downloads = await repository.DownloadsAsync(ct);
            var bindings = await repository.BindingsAsync(ct);
            var committedByRoot = roots.ToDictionary(r => r.Id,
                r => StorageCapacity.CommittedBytes(r.Id, downloads, bindings), StringComparer.Ordinal);
            var pinFolderByRoot = pins.ToDictionary(f => f.RootId!, f => f.RelativeItemFolder!, StringComparer.Ordinal);
            var existingLeaf = pins.Select(f => Path.GetFileName(f.RelativeItemFolder))
                .FirstOrDefault(name => !string.IsNullOrWhiteSpace(name));
            StorageRootRow? root = null;
            string? itemRelative = null;
            string? itemFolder = null;
            var offlineCouldFit = false;
            foreach (var candidate in candidates)
            {
                if (!storage.IsOnline(candidate.Path)) { offlineCouldFit = true; continue; }
                var status = storage.Status(candidate.Path);
                var free = status.FreeBytes ?? LibraryPaths.FreeBytes(candidate.Path);
                var reserve = StorageCapacity.EffectiveReserve(candidate, null);
                var committed = committedByRoot.GetValueOrDefault(candidate.Id);
                if (free < reserve || free - reserve < committed || free - reserve - committed < bytes) continue;
                if (candidate.MaxAllocatedBytes is { } limit)
                {
                    var stored = media.Where(m => m.RootId == candidate.Id && m.Status != FilePresence.Missing)
                        .Sum(m => m.Bytes);
                    if (stored + committed + bytes > limit) continue;
                }
                root = candidate;
                var title = work.Names.Where(n => n.Label == NameLabel.English).OrderBy(n => n.Ordinal).FirstOrDefault()?.Value ??
                    work.Names.OrderBy(n => n.Ordinal).FirstOrDefault()?.Value ?? "";
                itemRelative = pinFolderByRoot.TryGetValue(candidate.Id, out var existing)
                    ? existing
                    : Path.Combine(LibraryPaths.KindFolder(candidate.LibraryFolders, kind),
                        existingLeaf ?? LibraryPaths.ItemFolder(title, work.Work.Id, work.Work.Year, film));
                itemFolder = LibraryPaths.Within(candidate.Path, itemRelative);
                break;
            }
            if (root is null)
                return offlineCouldFit ? Wait(WaitReason.DriveOffline, "A storage location that may have room is offline.")
                    : Wait(WaitReason.NoDriveSpace, "No drive has room. Increase Keep free or Use at most, or free space.");
            if (input.ExplicitDirectory is not null &&
                LibraryPaths.PhysicalKey(input.ExplicitDirectory) != LibraryPaths.PhysicalKey(itemFolder!))
                return Reject("PlacementRequired", "The selected folder does not match the title's library folder.");

            var placed = await BuildFilesAsync(input, work, itemFolder!, film, ct);
            if (placed.Failure is not null) return placed;
            var now = DateTimeOffset.UtcNow;
            var folder = new WorkFolderRow
            {
                Id = Guid.NewGuid().ToString("N"), WorkId = work.Work.Id, RootId = root.Id,
                RelativeItemFolder = itemRelative, ExternalItemFolder = null, CreatedAt = now, UpdatedAt = now, Version = 1,
            };
            return placed with { RootId = root.Id, ReservedBytes = bytes, Folders = [folder] };
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or OverflowException)
        { return Reject("InvalidPath", "The library folder or file list could not be used. " + ex.Message); }
    }

    private static string KindName(LibraryKind kind) => kind switch
    {
        LibraryKind.TV => "series", LibraryKind.Anime => "anime series",
        LibraryKind.AnimeMovies => "anime movies", _ => "movies",
    };

    private static Failure Fail(string code, string message) => new(code, message, null, true);
    private static LibraryRootResult RootFailure(string code, string message) => new(null, Fail(code, message));
}
