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
            var replacedFile = target.Kind == TargetKind.Replace && target.ReplaceMediaFileId is { } replacedId
                ? media.FirstOrDefault(existing => existing.Id == replacedId) : null;
            var replacedTargetId = replacedFile is null ? null : bindings.FirstOrDefault(binding =>
                binding.MediaFileId == replacedFile.Id && binding.Role == FileRole.Video)?.TargetId;
            if (!targetFiles.Any(s => s.Role == FileRole.Video))
                return Reject("MappingUncertain", "Every selected item needs its own video.");
            var episode = target.EpisodeId is null ? null : work.Episodes.SingleOrDefault(e => e.Id == target.EpisodeId);
            var season = episode is null ? null : work.Seasons.SingleOrDefault(s => s.Id == episode.SeasonId);
            if (!film && season is null || film && target.EpisodeId is not null)
                return Reject("MappingUncertain", "A selected item has no confirmed season and episode.");
            var mapped = LibraryLayout.Names(work, target, input.Files, targetFiles, film);
            foreach (var selection in targetFiles)
            {
                var file = input.Files.Single(f => f.Index == selection.FileIndex);
                var final = LibraryPaths.Within(itemFolder, mapped[file.Index]);
                var key = LibraryPaths.PhysicalKey(final);
                var collision = used.Contains(key) || File.Exists(final) || Directory.Exists(final) ||
                    File.Exists(final + ".partial") || bindings.Any(b => b.PhysicalKey == key) ||
                    media.Any(m => m.PhysicalKey == key);
                var replacesSamePath = replacedFile is not null &&
                    (replacedFile.PhysicalKey == key || replacedTargetId is not null &&
                        bindings.Any(binding => binding.TargetId == replacedTargetId &&
                            binding.PhysicalKey == key));
                if (collision && replacesSamePath)
                {
                    var directory = Path.GetDirectoryName(final)!;
                    var stem = Path.GetFileNameWithoutExtension(final);
                    var extension = Path.GetExtension(final);
                    for (var copy = 2; copy < 1000; copy++)
                    {
                        var candidate = Path.Combine(directory, $"{stem} (copy {copy}){extension}");
                        var candidateKey = LibraryPaths.PhysicalKey(candidate);
                        if (used.Contains(candidateKey) || File.Exists(candidate) || Directory.Exists(candidate) ||
                            File.Exists(candidate + ".partial") || bindings.Any(b => b.PhysicalKey == candidateKey) ||
                            media.Any(existing => existing.PhysicalKey == candidateKey))
                            continue;
                        final = candidate;
                        key = candidateKey;
                        collision = false;
                        break;
                    }
                }
                if (collision || !used.Add(key))
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
