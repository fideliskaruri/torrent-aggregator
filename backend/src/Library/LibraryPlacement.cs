using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed partial class LibraryPlacement(ILibraryRepository repository) : ILibraryPlacement
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

            var root = (await RootsAsync(ct)).FirstOrDefault();
            if (root is null) return Wait(WaitReason.NoDriveSpace, "No drive has space");
            var checkedRoot = await CheckRootAsync(root.Id, ct);
            root = checkedRoot.Root;
            if (root is null || !root.Online) return Wait(WaitReason.DriveOffline, "Drive is offline");
            var kind = input.ExplicitKind ?? (work.Work.Anime == true
                ? work.Work.Kind == WorkKind.Film ? LibraryKind.AnimeMovies : LibraryKind.Anime
                : work.Work.Kind == WorkKind.Film ? LibraryKind.Movies : LibraryKind.TV);
            if (!root.Kinds.Contains(kind)) return Reject("PlacementRequired", "This library folder is not available.");
            if (input.ExplicitRootId is not null && input.ExplicitRootId != root.Id)
                return Reject("PlacementRequired", "TorrentFlow uses one download folder. Change it in Client settings.");

            var film = work.Work.Kind == WorkKind.Film;
            var title = work.Names.Where(n => n.Label == NameLabel.English).OrderBy(n => n.Ordinal).FirstOrDefault()?.Value ??
                work.Names.OrderBy(n => n.Ordinal).FirstOrDefault()?.Value ?? "";
            var itemRelative = Path.Combine(LibraryPaths.KindFolder(root.LibraryFolders, kind),
                LibraryPaths.ItemFolder(title, work.Work.Id, work.Work.Year, film));
            var itemFolder = LibraryPaths.Within(root.Path, itemRelative);
            if (input.ExplicitDirectory is not null &&
                LibraryPaths.PhysicalKey(input.ExplicitDirectory) != LibraryPaths.PhysicalKey(itemFolder))
                return Reject("PlacementRequired", "The selected folder does not match the title's library folder.");
            var bytes = selected.Sum(s => input.Files.Single(f => f.Index == s.FileIndex).Bytes);
            if (bytes > LibraryPaths.FreeBytes(root.Path)) return Wait(WaitReason.NoDriveSpace, "No drive has space");

            var placed = await BuildFilesAsync(input, work, itemFolder, film, ct);
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

    private static Failure Fail(string code, string message) => new(code, message, null, true);
    private static LibraryRootResult RootFailure(string code, string message) => new(null, Fail(code, message));
}
