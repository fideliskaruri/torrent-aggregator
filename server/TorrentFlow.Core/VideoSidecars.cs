using System.Text;
using System.Text.RegularExpressions;

namespace TorrentFlow.Core;

/// <summary>
/// Which files of a torrent belong to one video (docs/release-language.md, "Sidecars"): its own subtitle and audio files.
/// The English check judges each video with these only, never with another video's files, and a season pack downloads
/// each chosen episode's own sidecars with it.
/// </summary>
public static partial class VideoSidecars
{
    /// <summary>A release's main videos: the selected ones, or the largest and any at least half its size.</summary>
    public static List<(int Index, string Path, long Length)> MainVideos(IReadOnlyList<(int Index, string Path, long Length)> files,
        IReadOnlySet<int>? selected = null)
    {
        var videos = files.Where(f => MediaFileRules.IsVideo(f.Path) && (selected == null || selected.Contains(f.Index))).ToList();
        if (videos.Count == 0 || selected != null) return videos;
        var largest = videos.Max(f => f.Length);
        return videos.Where(f => f.Length * 2 >= largest).ToList();
    }

    /// <summary>
    /// The video's own subtitle and audio files, read from the torrent's whole file list:
    /// <list type="bullet">
    /// <item>the same base name beside it or in a folder below it (<c>Show - 05.mkv</c> with <c>Show - 05.en.ass</c>,
    /// <c>Subs/Show - 05.eng.srt</c> or the external audio <c>Show - 05.mka</c>), or the same episode
    /// (<see cref="SeasonPackFiles.EpisodeKey"/>: <c>Show.S01E05.en.srt</c> for <c>Show.S01E05.1080p.mkv</c>) when no other
    /// video is that episode;</item>
    /// <item>a folder below it named after it or its episode (<c>Subs/Show.S01E05.1080p/2_English.srt</c>, <c>Subs/S01E05/English.srt</c>);</item>
    /// <item>when no other video sits in its folder or below it, every file in that folder or in a <c>Subs</c> folder right in
    /// it (<c>Pack/01/Subs/English.srt</c> for <c>Pack/01/Show.S01E01.mkv</c>);</item>
    /// <item>when it is the torrent's only video (samples aside, <see cref="MediaFileRules.IsSample"/>; a featurette or a
    /// second episode counts), every other subtitle and audio file (<c>Subs/English.srt</c>, <c>Subs/2_English.srt</c>).</item>
    /// </list>
    /// A file named for another video, or for another video's episode, is never its own. Names compare in Unicode NFC.
    /// </summary>
    public static List<(int Index, string Path, long Length)> Of((int Index, string Path, long Length) video,
        IReadOnlyList<(int Index, string Path, long Length)> files)
    {
        var (folder, stem) = Split(video.Path);
        var videos = files.Where(f => MediaFileRules.IsVideo(f.Path)).ToList();
        var counted = videos.Where(f => !MediaFileRules.IsSample(f.Path)).ToList();
        if (counted.Count == 0) counted = videos;
        var only = counted.Count == 1 && counted[0].Index == video.Index;
        var alone = !counted.Any(f => f.Index != video.Index && Split(f.Path).Folder.StartsWith(folder, StringComparison.OrdinalIgnoreCase));
        var others = videos.Where(f => f.Index != video.Index).Select(f => Split(f.Path).Stem)
            .Where(s => !s.Equals(stem, StringComparison.OrdinalIgnoreCase)).ToList();
        var keys = counted.Append(video).DistinctBy(f => f.Index)
            .Select(f => (f.Index, Key: SeasonPackFiles.EpisodeKey(Split(f.Path).Stem))).Where(k => k.Key != null).ToList();
        // The videos an episode key names: a sidecar or folder is this video's own only when it names this video alone.
        List<int> Named(string? key) => key == null ? [] : keys.Where(k => SeasonPackFiles.SameEpisode(k.Key!, key)).Select(k => k.Index).ToList();
        var found = new List<(int Index, string Path, long Length)>();
        foreach (var file in files)
        {
            if (file.Index == video.Index || !ReleaseLanguage.IsSidecar(file.Path)) continue;
            var (otherFolder, otherStem) = Split(file.Path);
            var below = otherFolder.StartsWith(folder, StringComparison.OrdinalIgnoreCase);
            var segments = below ? otherFolder[folder.Length..].Split('/', StringSplitOptions.RemoveEmptyEntries) : [];
            bool Mine(string? key) => Named(key) is [var index] && index == video.Index;
            var named = below && (SameName(otherStem, stem) || Mine(SeasonPackFiles.EpisodeKey(otherStem)));
            var ownFolder = segments.Any(segment => segment.Equals(stem, StringComparison.OrdinalIgnoreCase) || Mine(SeasonPackFiles.EpisodeKey(segment)));
            if (named || ownFolder) { found.Add(file); continue; }
            var allSegments = otherFolder.Split('/', StringSplitOptions.RemoveEmptyEntries);
            var foreign = others.Any(s => SameName(otherStem, s) || allSegments.Any(segment => segment.Equals(s, StringComparison.OrdinalIgnoreCase))) ||
                allSegments.Append(otherStem).Select(SeasonPackFiles.EpisodeKey).Any(key => Named(key) is { Count: > 0 } named2 && !named2.Contains(video.Index));
            if (foreign) continue;
            if (only || below && alone && (segments.Length == 0 || IsSubsFolder(segments[0]))) found.Add(file);
        }
        return found;
    }

    /// <summary>A folder that holds subtitles: <c>Subs</c>, <c>Sub</c>, <c>Subtitles</c>.</summary>
    public static bool IsSubsFolder(string name) => SubsFolder().IsMatch(name);

    /// <summary>The video's path followed by its own sidecars' paths: what the judge reads for it.</summary>
    public static IReadOnlyList<string> Paths((int Index, string Path, long Length) video, IReadOnlyList<(int Index, string Path, long Length)> files) =>
        Of(video, files).Select(f => f.Path).Prepend(video.Path).ToList();

    /// <summary>"Show - 05.en" and "Show - 05" belong to "Show - 05"; "Show - 10.en" does not belong to "Show - 1".</summary>
    private static bool SameName(string other, string stem) => other.Equals(stem, StringComparison.OrdinalIgnoreCase) ||
        other.Length > stem.Length && other.StartsWith(stem, StringComparison.OrdinalIgnoreCase) &&
        (other[stem.Length] is '.' or '_' or '[' or '(' || other[stem.Length] == ' ' && other.Length > stem.Length + 1 && other[stem.Length + 1] is '[' or '(');

    /// <summary>The folder (with a trailing slash) and the base name, in Unicode NFC so a name written decomposed (NFD, as
    /// macOS writes it) still matches its video.</summary>
    private static (string Folder, string Stem) Split(string path)
    {
        var normalized = Nfc(path.Replace('\\', '/'));
        var slash = normalized.LastIndexOf('/');
        var file = normalized[(slash + 1)..];
        var dot = file.LastIndexOf('.');
        return (slash < 0 ? "" : normalized[..(slash + 1)], dot > 0 ? file[..dot] : file);
    }

    private static string Nfc(string text)
    {
        try { return text.IsNormalized(NormalizationForm.FormC) ? text : text.Normalize(NormalizationForm.FormC); }
        catch (ArgumentException) { return text; }
    }

    [GeneratedRegex(@"^(?:subs?|subtitles?)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SubsFolder();
}
