using System.Collections.Immutable;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed partial class LibraryPlacement
{
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
            var root = (await RootsAsync(ct)).SingleOrDefault(r => r.Id == file.RootId);
            if (file.RootId is not null)
            {
                if (root is null || !LibraryPaths.IsInside(root.Path, file.Path))
                    return Fail("InvalidMedia", "The file is outside its download folder.");
            }
            else if ((await RootsAsync(ct)).Any(r => LibraryPaths.IsInside(r.Path, file.Path)))
                return Fail("InvalidMedia", "This file is inside the download folder. Record it with that root.");
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
                    Id = Guid.NewGuid().ToString("N"), WorkId = file.WorkId, RootId = file.RootId,
                    RelativeItemFolder = root is null ? null : Path.GetRelativePath(root.Path, actual),
                    ExternalItemFolder = root is null ? actual : null, CreatedAt = now, UpdatedAt = now, Version = 1,
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
}
