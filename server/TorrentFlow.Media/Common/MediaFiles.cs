using System.Text.RegularExpressions;

namespace TorrentFlow.Media.Common;

/// <summary>Port of the file-name helpers in src/lib/torrents/filters.ts.</summary>
internal static partial class MediaFiles
{
    public static bool IsVideo(string? name) => name is not null && VideoExtRe().IsMatch(name.Replace('\\', '/'));
    public static bool IsSubtitle(string? name) => name is not null && SubtitleExtRe().IsMatch(name.Replace('\\', '/'));
    public static bool IsMediaAsset(string? name) => IsVideo(name) || IsSubtitle(name);
    public static bool IsUnsafeExecutable(string? name) => name is not null && ExecutableExtRe().IsMatch(name.Replace('\\', '/'));

    public static bool IsExtras(string? title) =>
        !string.IsNullOrEmpty(title) && ExtrasRe().IsMatch(title.Replace('.', ' ').Replace('_', ' '));

    /// <summary>
    /// The main feature among a torrent's files: the largest supported video that is not an extra, falling back to
    /// the largest extra; never a non-video. Returns the index into the original list.
    /// </summary>
    public static int? SelectMainFeatureFile(IReadOnlyList<(string Name, long Length)> files)
    {
        if (files.Count == 0) return null;
        var videos = files.Select((f, i) => (f.Name, Length: f.Length > 0 ? f.Length : 0, Index: i)).Where(f => IsVideo(f.Name)).ToList();
        if (videos.Count == 0) return null;
        var mains = videos.Where(f => !IsExtras(f.Name)).ToList();
        var candidates = mains.Count > 0 ? mains : videos;
        var best = candidates[0];
        foreach (var f in candidates) if (f.Length > best.Length) best = f;
        return best.Index;
    }

    /// <summary>Port of normalizeTitle in src/lib/utils.ts (the SearchCache.normalizedQuery key).</summary>
    public static string NormalizeTitle(string title)
    {
        var t = title.ToLowerInvariant();
        t = BracketsRe().Replace(t, " ");
        t = EpisodeTokensRe().Replace(t, " ");
        t = QualityTokensRe().Replace(t, " ");
        t = SeparatorsRe().Replace(t, " ");
        t = SpacesRe().Replace(t, " ");
        return t.Trim();
    }

    [GeneratedRegex(@"\.(?:mkv|mp4|avi|m4v|mov|wmv|flv|webm|ts|m2ts|mpg|mpeg|vob)$", RegexOptions.IgnoreCase)] private static partial Regex VideoExtRe();
    [GeneratedRegex(@"\.(?:vtt|srt|ass|ssa)$", RegexOptions.IgnoreCase)] private static partial Regex SubtitleExtRe();
    [GeneratedRegex(@"\.(?:exe|scr|com|bat|cmd|ps1|psm1|msi|msp|cpl|hta|jar|js|jse|vbs|vbe|wsf|wsh|lnk|pif|reg|dll|sys)$", RegexOptions.IgnoreCase)] private static partial Regex ExecutableExtRe();
    [GeneratedRegex(@"\b(?:samples?|featurettes?|extras?|bonus(?:[ _-]?dis[ck])?|deleted[ _-]?scenes?|behind[ _-]?the[ _-]?scenes|making[ _-]?of|gag[ _-]?reels?|bloopers?|outtakes?|b[ _-]?roll)\b", RegexOptions.IgnoreCase)] private static partial Regex ExtrasRe();
    [GeneratedRegex(@"[\[\](){}【】]")] private static partial Regex BracketsRe();
    [GeneratedRegex(@"\b(s\d{1,2}e\d{1,3}|ep?\s*\d{1,3}|season\s*\d+)\b", RegexOptions.IgnoreCase)] private static partial Regex EpisodeTokensRe();
    [GeneratedRegex(@"\b(1080p|720p|480p|2160p|4k|hevc|x265|x264|web-?dl|webrip|bluray|bdrip|hdtv|aac|flac|10bit|dual|multi|sub|dub|vostfr|raw)\b", RegexOptions.IgnoreCase)] private static partial Regex QualityTokensRe();
    [GeneratedRegex(@"[._\-–—|]+")] private static partial Regex SeparatorsRe();
    [GeneratedRegex(@"\s+")] private static partial Regex SpacesRe();
}
