using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed record LibraryDeleteScope(string Kind, int? Season, int? Episode);
public sealed record LibraryDeleteRelease(string Name, int FileCount, long Bytes, bool FilesRecorded);
public sealed record LibraryDeleteBlocked(string Name, string Reason, string Covers, int FileCount, long Bytes);
public sealed record LibraryDeletePlan(LibraryDeleteScope Scope, string Outcome, int FileCount, long TotalBytes,
    int MissingFileCount, ImmutableArray<LibraryDeleteRelease> Releases, ImmutableArray<LibraryDeleteBlocked> Blocked, string Summary);
public sealed record LibraryDeleteItem(DownloadRow Download, ImmutableArray<string> TargetIds, ImmutableArray<string> Paths);
public sealed record LibraryDeletePreview(LibraryDeletePlan Plan, ImmutableArray<LibraryDeleteItem> Items);
public sealed record LibraryDeleteSuccess(string Name, long Bytes, int FileCount);
public sealed record LibraryDeleteFailure(string Name, string Message);
public sealed record LibraryDeleteResult(bool Ok, long FreedBytes, int FreedFiles,
    ImmutableArray<LibraryDeleteSuccess> Deleted, ImmutableArray<LibraryDeleteFailure> Failed, LibraryDeletePlan Plan);

public static class LibraryRemoval
{
    public static LibraryDeletePreview Preview(LibraryDeleteScope scope, string workId, HashSet<string> episodeIds,
        IEnumerable<TargetRow> targets, IEnumerable<DownloadTargetRow> links,
        IEnumerable<DownloadRow> downloads, ImmutableArray<DownloadFileRow> bindings, ImmutableArray<MediaFileRow> media)
    {
        bool Within(string? id) => scope.Kind == "show" || id is not null && episodeIds.Contains(id);
        var ids = targets.Where(t => t.WorkId == workId && Within(t.EpisodeId)).Select(t => t.Id).ToHashSet();
        var selectedMedia = media.Where(m => m.WorkId == workId && Within(m.EpisodeId)).ToArray();
        var associations = links.ToArray();
        var downloadIds = associations.Where(l => ids.Contains(l.TargetId)).Select(l => l.DownloadId)
            .Concat(bindings.Where(f => f.TargetId is not null && ids.Contains(f.TargetId)).Select(f => f.DownloadId))
            .Concat(selectedMedia.Select(m => m.DownloadId).OfType<string>()).ToHashSet();
        var releases = ImmutableArray.CreateBuilder<LibraryDeleteRelease>();
        var blocked = ImmutableArray.CreateBuilder<LibraryDeleteBlocked>();
        var items = ImmutableArray.CreateBuilder<LibraryDeleteItem>();
        var missing = 0;
        foreach (var download in downloads.Where(d => downloadIds.Contains(d.Id)))
        {
            var files = bindings.Where(f => f.DownloadId == download.Id).ToArray();
            if (files.Length == 0) continue;
            var present = DownloadFiling.PayloadPaths(files, media);
            var bytes = present.Sum(p => new FileInfo(p).Length);
            var name = Path.GetFileName(files.FirstOrDefault(f => f.Role == FileRole.Video)?.FinalPath) ?? download.Hash;
            if (associations.Any(l => l.DownloadId == download.Id && !ids.Contains(l.TargetId)) ||
                files.Any(f => f.TargetId is not null && !ids.Contains(f.TargetId)) ||
                media.Any(m => m.DownloadId == download.Id && (m.WorkId != workId || !Within(m.EpisodeId))))
            {
                blocked.Add(new(name, "covers-more", "other episodes", present.Length, bytes));
                continue;
            }
            items.Add(new(download, [.. associations.Where(l => l.DownloadId == download.Id)
                .Select(l => l.TargetId).Concat(files.Select(f => f.TargetId).OfType<string>()).Distinct()], present));
            releases.Add(new(name, present.Length, bytes, true));
            missing += files.Count(f => f.Filed && f.FinalPath is not null && !File.Exists(f.FinalPath));
        }
        foreach (var external in selectedMedia.Where(m => m.DownloadId is null ||
            bindings.All(f => f.DownloadId != m.DownloadId)))
            blocked.Add(new(Path.GetFileName(external.Path), "unrecognised",
                "an imported file requiring a removal operation", File.Exists(external.Path) ? 1 : 0, external.Bytes));
        var outcome = items.Count > 0 ? "deletes" : blocked.Count > 0 ? "blocked" : "nothing-held";
        var fileCount = releases.Sum(r => r.FileCount);
        var totalBytes = releases.Sum(r => r.Bytes);
        var subject = scope.Kind == "show" ? "this title" : scope.Kind == "season" ? $"Season {scope.Season}" :
            $"S{scope.Season:00}E{scope.Episode:00}";
        var size = totalBytes >= 1024 * 1024 * 1024 ? $"{totalBytes / (1024d * 1024 * 1024):0.##} GB" :
            totalBytes >= 1024 * 1024 ? $"{totalBytes / (1024d * 1024):0.##} MB" : $"{totalBytes} bytes";
        var summary = outcome == "deletes" ? $"Deletes {fileCount} files · {size} from {subject}." :
            outcome == "blocked" ? "These files also belong to other episodes or need a separate removal operation. They will be left in place." :
            $"No files held for {subject}. Nothing to delete.";
        if (outcome == "deletes" && blocked.Count > 0) summary += $" {blocked.Count} releases will be left in place.";
        return new(new(scope, outcome, fileCount, totalBytes, missing, releases.ToImmutable(), blocked.ToImmutable(), summary),
            items.ToImmutable());
    }

    public static async Task<LibraryDeleteResult> DeleteAsync(LibraryDeletePreview preview,
        Func<string, CancellationToken, Task> removeTarget, Func<string, CancellationToken, Task> removeDownload, CancellationToken ct)
    {
        var deleted = ImmutableArray.CreateBuilder<LibraryDeleteSuccess>();
        var failed = ImmutableArray.CreateBuilder<LibraryDeleteFailure>();
        foreach (var item in preview.Items)
        {
            var before = item.Paths.Where(File.Exists).Select(p => (Path: p, Bytes: new FileInfo(p).Length)).ToArray();
            try
            {
                foreach (var targetId in item.TargetIds) await removeTarget(targetId, ct);
                await removeDownload(item.Download.Hash, ct);
                var removed = before.Where(p => !File.Exists(p.Path)).ToArray();
                if (removed.Length != before.Length) throw new IOException("Some files could not be removed. Close apps using them and try again.");
                deleted.Add(new(item.Download.Hash, removed.Sum(p => p.Bytes), removed.Length));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            { failed.Add(new(item.Download.Hash, ex.Message)); }
        }
        return new(failed.Count == 0, deleted.Sum(d => d.Bytes), deleted.Sum(d => d.FileCount),
            deleted.ToImmutable(), failed.ToImmutable(), preview.Plan);
    }
}
