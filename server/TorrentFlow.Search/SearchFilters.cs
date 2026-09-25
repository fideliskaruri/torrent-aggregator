using TorrentFlow.Core.Contracts.Search;
using static TorrentFlow.Search.EpisodeParser;

namespace TorrentFlow.Search;

public static class TorrentFilters
{
    public static bool IsUnsafeExecutable(string name) => Match(name, @"\.(?:exe|scr|com|bat|cmd|ps1|psm1|msi|msp|cpl|hta|jar|js|jse|vbs|vbe|wsf|wsh|lnk|pif|reg|dll|sys)$").Success;
    public static bool IsVideo(string name) => Match(name, @"\.(?:mkv|mp4|avi|m4v|mov|wmv|flv|webm|ts|m2ts|mpg|mpeg|vob)$").Success;
    public static bool IsSubtitle(string name) => Match(name, @"\.(?:vtt|srt|ass|ssa)$").Success;
    public static bool IsExtras(string title) => Match(Replace(title, @"[._]"), @"\b(?:samples?|featurettes?|extras?|bonus(?:[ _-]?dis[ck])?|deleted[ _-]?scenes?|behind[ _-]?the[ _-]?scenes|making[ _-]?of|gag[ _-]?reels?|bloopers?|outtakes?|b[ _-]?roll)\b").Success;
    public static IReadOnlyList<TorrentResult> Apply(IEnumerable<TorrentResult> results, SearchFilters f) => results.Where(r =>
    {
        if (IsUnsafeExecutable(r.Title)) return false;
        if (f.MinSeeders is { } min && r.Seeders < min || f.MaxSeeders is { } max && r.Seeders > max) return false;
        if (f.MinSizeBytes is { } minSize && (r.SizeBytes == null || r.SizeBytes < minSize)) return false;
        if (f.MaxSizeBytes is { } maxSize && (r.SizeBytes == null || r.SizeBytes > maxSize)) return false;
        var hay = $"{r.Title} {string.Join(' ', r.Tags)}".ToLowerInvariant();
        if (f.Resolution is { } res && !(res is "2160p" or "4k" ? new[] { "2160p", "4k", "uhd" }.Any(hay.Contains) : hay.Contains(res))) return false;
        if (f.Codec is { } codec && !(codec is "hevc" or "x265" ? new[] { "hevc", "x265", "h.265" }.Any(hay.Contains) : hay.Contains(codec))) return false;
        if (f.HasMagnet == true && string.IsNullOrEmpty(r.Magnet)) return false;
        var ep = r.Episode ?? Parse(r.Title);
        var pack = ep.IsBatch || ep.IsSeasonPack;
        if (f.ReleaseKind == "packs" && !pack || f.ReleaseKind == "episodes" && pack) return false;
        var parsed = Parse(r.Title);
        if (f.Season != null && parsed.Season != null && f.Season != parsed.Season) return false;
        if (f.Episode != null && parsed.Episode != null && f.Episode != parsed.Episode) return false;
        return true;
    }).ToArray();
}
