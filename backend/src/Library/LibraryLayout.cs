using System.Collections.Immutable;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

internal static class LibraryLayout
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMilliseconds(100);

    internal static ImmutableDictionary<int, string> Names(WorkSnapshot work, TargetRow target,
        ImmutableArray<TorrentFile> files, ImmutableArray<SelectedFile> selected, bool film)
    {
        var title = work.Names.Where(n => n.Label == NameLabel.English).OrderBy(n => n.Ordinal)
            .Select(n => n.Value).FirstOrDefault() ??
            work.Names.OrderBy(n => n.Ordinal).Select(n => n.Value).FirstOrDefault() ?? "";
        var itemTitle = LibraryPaths.SafeTitle(title, work.Work.Id);
        var itemFolder = LibraryPaths.ItemFolder(title, work.Work.Id, work.Work.Year, true);

        var episode = target.EpisodeId is null ? null : work.Episodes.SingleOrDefault(e => e.Id == target.EpisodeId);
        var season = episode is null ? null : work.Seasons.SingleOrDefault(s => s.Id == episode.SeasonId);
        if (!film && (episode is null || season is null))
            throw new ArgumentException("The selected episode has no confirmed season and episode.");
        if (film && target.EpisodeId is not null)
            throw new ArgumentException("A film target cannot include an episode.");

        string Stem(SelectedFile file)
        {
            if (film)
                return itemFolder;
            var episodeNumber = episode!.Number.ToString(episode.Number > 99 ? "D3" : "D2",
                System.Globalization.CultureInfo.InvariantCulture);
            return $"{itemTitle} S{season!.Number:00}E{episodeNumber}";
        }

        var videoFiles = selected.Where(s => s.Role == FileRole.Video).ToArray();
        var output = ImmutableDictionary.CreateBuilder<int, string>();
        foreach (var selection in selected)
        {
            var source = files.Single(f => f.Index == selection.FileIndex);
            var extension = Path.GetExtension(source.RelativePath);
            if (selection.Role == FileRole.Video)
            {
                var videoStem = Stem(selection);
                output[selection.FileIndex] = Path.Combine(
                    film ? "" : $"Season {season!.Number:00}", LibraryPaths.SafeLeaf(videoStem + extension));
                continue;
            }

            if (selection.Role is not (FileRole.Subtitle or FileRole.Audio))
                throw new ArgumentException("Only selected media files can be placed in the library.");
            var sourceStem = Path.GetFileNameWithoutExtension(source.RelativePath);
            var matches = videoFiles.Where(video =>
            {
                var videoStem = Path.GetFileNameWithoutExtension(
                    files.Single(f => f.Index == video.FileIndex).RelativePath);
                return sourceStem.Equals(videoStem, StringComparison.OrdinalIgnoreCase) ||
                    sourceStem.StartsWith(videoStem + ".", StringComparison.OrdinalIgnoreCase) ||
                    EpisodeKey(sourceStem) is { } key && key == EpisodeKey(videoStem);
            }).ToArray();
            var video = matches.Length == 1 ? matches[0] :
                videoFiles.Length == 1 ? videoFiles[0] : throw new ArgumentException(
                    "A selected sidecar does not identify one video.");
            var videoSource = files.Single(f => f.Index == video.FileIndex);
            var videoSourceStem = Path.GetFileNameWithoutExtension(videoSource.RelativePath);
            var suffix = sourceStem.StartsWith(videoSourceStem + ".", StringComparison.OrdinalIgnoreCase)
                ? sourceStem[videoSourceStem.Length..]
                : sourceStem.Equals(videoSourceStem, StringComparison.OrdinalIgnoreCase) ? "" : "." + sourceStem;
            if (selection.Role == FileRole.Subtitle && EpisodeKey(sourceStem) is { } sidecarEpisode &&
                sidecarEpisode == EpisodeKey(videoSourceStem) &&
                !sourceStem.StartsWith(videoSourceStem + ".", StringComparison.OrdinalIgnoreCase))
            {
                var language = Regex.Match(sourceStem,
                    @"(?:^|[._ -])([a-z]{2,3}(?:[._ -](?:forced|sdh|cc|default))*)$",
                    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, Timeout);
                if (language.Success) suffix = "." + Regex.Replace(language.Groups[1].Value, @"[ _-]+", ".");
            }
            var stem = Stem(video);
            output[selection.FileIndex] = Path.Combine(
                film ? "" : $"Season {season!.Number:00}",
                LibraryPaths.SafeLeaf(stem + suffix + extension));
        }
        return output.ToImmutable();
    }

    private static string? EpisodeKey(string value)
    {
        var match = Regex.Match(value,
            @"(?:^|[^a-z0-9])s(\d{1,3})[\s._-]*e(\d{1,4})(?![0-9])",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, Timeout);
        if (!match.Success) return null;
        return $"{int.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture)}:" +
            int.Parse(match.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture);
    }
}
