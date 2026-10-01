using TorrentFlow.Core.Contracts.Search;
using static TorrentFlow.Search.EpisodeParser;

namespace TorrentFlow.Search;

public sealed record SelectableFile(string? Name = null, string? Path = null, long? Length = null);
public sealed record MainFeatureSelection(SelectableFile File, int Index);
public sealed record TorrentPayloadValidation(bool Ok, int? VideoCount = null, string? Reason = null, string? Message = null);

public static class TorrentFilters
{
    public static bool IsUnsafeExecutable(string name) => TorrentFlow.Core.MediaFileRules.IsDangerous(name);
    public static bool IsVideo(string name) => TorrentFlow.Core.MediaFileRules.IsVideo(name);
    public static bool IsSubtitle(string name) => Match(name, @"\.(?:vtt|srt|ass|ssa)$").Success;
    public static bool IsExtras(string title) => Match(Replace(title, @"[._]"), @"\b(?:samples?|featurettes?|extras?|bonus(?:[ _-]?dis[ck])?|deleted[ _-]?scenes?|behind[ _-]?the[ _-]?scenes|making[ _-]?of|gag[ _-]?reels?|bloopers?|outtakes?|b[ _-]?roll)\b").Success;
    public static TorrentPayloadValidation ValidatePayload(IEnumerable<SelectableFile> files)
    {
        var names = files.Select(f => f.Path ?? f.Name ?? "").ToArray();
        if (names.Any(IsUnsafeExecutable)) return new(false, Reason: "unsafe-file", Message: "That release contains an unsafe non-media file. Trying another release.");
        var count = names.Count(IsVideo);
        return count > 0 ? new(true, count) : new(false, Reason: "no-video", Message: "That release does not contain a supported video file. Trying another release.");
    }
    public static MainFeatureSelection? SelectMainFeature(IEnumerable<SelectableFile> files)
    {
        var video = files.Select((file, index) => new MainFeatureSelection(file, index))
            .Where(f => IsVideo(f.File.Name ?? f.File.Path ?? "")).ToArray();
        return video.OrderBy(f => IsExtras(f.File.Name ?? f.File.Path ?? "") ? 1 : 0)
            .ThenByDescending(f => Math.Max(0, f.File.Length ?? 0)).FirstOrDefault();
    }
    public static IReadOnlyList<TorrentResult> Apply(IEnumerable<TorrentResult> results, SearchFilters f) =>
        results.Where(r => RejectReason(r, f) == null).ToArray();

    public static string? RejectReason(TorrentResult r, SearchFilters f)
    {
        if (IsUnsafeExecutable(r.Title)) return "unsafe";
        if (f.MinSeeders is { } min && r.Seeders < min) return "no_seeders";
        if (f.MaxSeeders is { } max && r.Seeders > max) return "seeder_filter";
        if (f.MinSizeBytes is { } minSize && (r.SizeBytes == null || r.SizeBytes < minSize)) return "size_filter";
        if (f.MaxSizeBytes is { } maxSize && (r.SizeBytes == null || r.SizeBytes > maxSize)) return "size_filter";
        var hay = $"{r.Title} {string.Join(' ', r.Tags)}".ToLowerInvariant();
        if (f.Resolution is { } res && (TorrentFlow.Core.ReleaseResolution.Parse(res) is { } wanted
                ? TorrentFlow.Core.ReleaseResolution.Parse(hay) != wanted : !hay.Contains(res))) return "resolution_filter";
        if (f.Codec is { } codec && !(codec is "hevc" or "x265" ? new[] { "hevc", "x265", "h.265" }.Any(hay.Contains) : hay.Contains(codec))) return "codec_filter";
        if (f.HasMagnet == true && string.IsNullOrEmpty(r.Magnet)) return "no_link";
        var ep = r.Episode ?? Parse(r.Title);
        var pack = ep.IsBatch || ep.IsSeasonPack;
        if (f.ReleaseKind == "packs" && !pack || f.ReleaseKind == "episodes" && pack) return "release_kind";
        var parsed = Parse(r.Title);
        if (f.Season != null && parsed.Season != null && f.Season != parsed.Season) return "episode_filter";
        if (f.Episode != null && parsed.Episode != null && f.Episode != parsed.Episode) return "episode_filter";
        return null;
    }
}
