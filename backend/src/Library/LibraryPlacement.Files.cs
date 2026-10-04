using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed partial class LibraryPlacement
{
    private async Task<PlacementResult> BuildFilesAsync(PlacementInput input, WorkSnapshot work,
        string itemFolder, bool film, CancellationToken ct)
    {
        static PlacementResult Reject(string code, string message) =>
            new([], null, 0, [], new Failure(code, message, null, true));
        var selected = input.Assignment.Files;
        var bindings = await repository.BindingsAsync(ct);
        var media = await repository.MediaAsync(work.Work.Id, ct);
        var used = new HashSet<string>(StringComparer.Ordinal);
        var output = ImmutableArray.CreateBuilder<DownloadFileRow>();
        foreach (var target in input.Targets.Where(t => selected.Any(s => s.TargetId == t.Id)))
        {
            var targetFiles = selected.Where(s => s.TargetId == target.Id).ToImmutableArray();
            if (!targetFiles.Any(s => s.Role == FileRole.Video))
                return Reject("MappingUncertain", "Every selected item needs its own video.");
            var episode = target.EpisodeId is null ? null : work.Episodes.SingleOrDefault(e => e.Id == target.EpisodeId);
            var season = episode is null ? null : work.Seasons.SingleOrDefault(s => s.Id == episode.SeasonId);
            if (!film && season is null || film && target.EpisodeId is not null)
                return Reject("MappingUncertain", "A selected item has no confirmed season and episode.");
            var directory = film ? itemFolder : LibraryPaths.Within(itemFolder, $"Season {season!.Number:00}");
            var mapped = LibraryLayout.Names(input.Files, targetFiles, directory);
            foreach (var selection in targetFiles)
            {
                var file = input.Files.Single(f => f.Index == selection.FileIndex);
                var final = LibraryPaths.Within(directory, mapped[file.Index]);
                var key = LibraryPaths.PhysicalKey(final);
                if (!used.Add(key) || File.Exists(final) || Directory.Exists(final) || File.Exists(final + ".partial") ||
                    bindings.Any(b => b.PhysicalKey == key) || media.Any(m => m.PhysicalKey == key))
                    return Reject("FileCollision", "A file already uses the destination name. Review the duplicate before downloading.");
                output.Add(new DownloadFileRow
                {
                    Id = $"placement:{input.Assignment.Hash}:{file.Index}", DownloadId = input.Assignment.Hash,
                    FileIndex = file.Index, Selected = true, TargetId = target.Id, PartialPath = final + ".partial",
                    FinalPath = final, PhysicalKey = key, MediaFileId = null, Role = selection.Role,
                    ExpectedBytes = file.Bytes, EnginePath = final + ".partial", Filed = false,
                });
            }
        }
        return new(output.ToImmutable(), null, 0, [], null);
    }
}
