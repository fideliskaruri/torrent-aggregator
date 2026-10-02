namespace TorrentFlow.Core;

/// <summary>
/// Which files of a torrent belong to one video (docs/release-language.md, "Sidecars"): its own subtitle and audio files.
/// The English check judges each video with these only, never with another video's files, and a season pack downloads
/// each chosen episode's own sidecars with it.
/// </summary>
public static class VideoSidecars
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
    /// the same base name beside it or in a folder below it (<c>Show - 05.mkv</c> with <c>Show - 05.en.ass</c>,
    /// <c>Subs/Show - 05.eng.srt</c> or the external audio <c>Show - 05.mka</c>); a folder named after it
    /// (<c>Subs/Show.S01E05.1080p/2_English.srt</c>); and, when it is the torrent's only main video, every other subtitle and
    /// audio file (<c>Subs/English.srt</c>, <c>Subs/2_English.srt</c>). A file named for another video is never its own.
    /// </summary>
    public static List<(int Index, string Path, long Length)> Of((int Index, string Path, long Length) video,
        IReadOnlyList<(int Index, string Path, long Length)> files)
    {
        var (folder, stem) = Split(video.Path);
        var main = MainVideos(files);
        var only = main.Count == 1 && main[0].Index == video.Index;
        var others = files.Where(f => f.Index != video.Index && MediaFileRules.IsVideo(f.Path)).Select(f => Split(f.Path).Stem)
            .Where(s => !s.Equals(stem, StringComparison.OrdinalIgnoreCase)).ToList();
        var found = new List<(int Index, string Path, long Length)>();
        foreach (var file in files)
        {
            if (file.Index == video.Index || !ReleaseLanguage.IsSidecar(file.Path)) continue;
            var (otherFolder, otherStem) = Split(file.Path);
            var below = otherFolder.StartsWith(folder, StringComparison.OrdinalIgnoreCase);
            var named = below && Named(otherStem, stem);
            var ownFolder = below && otherFolder[folder.Length..].Split('/', StringSplitOptions.RemoveEmptyEntries)
                .Any(segment => segment.Equals(stem, StringComparison.OrdinalIgnoreCase));
            if (named || ownFolder) { found.Add(file); continue; }
            var foreign = others.Any(s => Named(otherStem, s) ||
                otherFolder.Split('/', StringSplitOptions.RemoveEmptyEntries).Any(segment => segment.Equals(s, StringComparison.OrdinalIgnoreCase)));
            if (only && !foreign) found.Add(file);
        }
        return found;
    }

    /// <summary>The video's path followed by its own sidecars' paths: what the judge reads for it.</summary>
    public static IReadOnlyList<string> Paths((int Index, string Path, long Length) video, IReadOnlyList<(int Index, string Path, long Length)> files) =>
        Of(video, files).Select(f => f.Path).Prepend(video.Path).ToList();

    /// <summary>"Show - 05.en" and "Show - 05" belong to "Show - 05"; "Show - 10.en" does not belong to "Show - 1".</summary>
    private static bool Named(string other, string stem) => other.Equals(stem, StringComparison.OrdinalIgnoreCase) ||
        other.Length > stem.Length && other.StartsWith(stem, StringComparison.OrdinalIgnoreCase) &&
        (other[stem.Length] is '.' or '_' or '[' or '(' || other[stem.Length] == ' ' && other.Length > stem.Length + 1 && other[stem.Length + 1] is '[' or '(');

    private static (string Folder, string Stem) Split(string path)
    {
        var normalized = path.Replace('\\', '/');
        var slash = normalized.LastIndexOf('/');
        var file = normalized[(slash + 1)..];
        var dot = file.LastIndexOf('.');
        return (slash < 0 ? "" : normalized[..(slash + 1)], dot > 0 ? file[..dot] : file);
    }
}
