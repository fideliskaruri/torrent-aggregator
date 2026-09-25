using TorrentFlow.Core.Contracts.Search;
using static TorrentFlow.Search.EpisodeParser;

namespace TorrentFlow.Search;

public static class ReleaseQuality
{
    public static int? ParseResolution(string title)
    {
        var t = Replace(title, @"[._]");
        (string Pattern, int Value)[] patterns =
        [
            (@"\b4kto1080p\b", 1080),
            (@"\b(?:2160p|3840x2160|uhd|4k[-_. ]?(?:uhd|hevc|bd|h ?265)|(?:uhd|hevc|bd|h ?265)[-_. ]4k)\b|\[4k\]", 2160),
            (@"\b(?:1080p|1920x1080|1440p|fhd|1080i)\b", 1080),
            (@"\b(?:720p|1280x720|960p)\b", 720),
            (@"\b(?:576p|576i)\b", 576),
            (@"\b(?:480p|480i|640x480|848x480)\b", 480),
            (@"\b(?:360p|240p)\b", 360)
        ];
        foreach (var (pattern, value) in patterns)
            if (Match(t, pattern).Success) return value;
        return null;
    }
    public static bool MeetsResolutionFloor(string title, int? floor) => floor is null or < 1 || ParseResolution(title) >= floor;
    public static int ResolutionAffinity(int? resolution, int target = 1080) => resolution == null ? -1 : resolution == target ? 1000
        : resolution < target ? 500 + Round(resolution.Value / 10d) : 100 - Round(resolution.Value / 100d);
    internal static int Round(double value) => (int)Math.Floor(value + .5);
    public static bool IsJunkSource(string title)
    {
        var t = Replace(title, @"[._]");
        if (Match(t, @"\b(?:hdcam|cam-?rip|telesync|hdts|telecine|tele-?cine|dvdscr|dvd-?screener|screener|workprint|hdtc)\b").Success) return true;
        var cam = Match(t, @"\bcam\b");
        var anchor = Match(t, @"\b(?:19|20)\d{2}\b|\b\d{3,4}[pi]\b");
        return cam.Success && anchor.Success && anchor.Index < cam.Index;
    }
    public static int ParseSourceTier(string title)
    {
        var t = Replace(title, @"[._]");
        if (Match(t, @"\b(?:blu[-_. ]?ray|bdrip|brrip|bd[-_. ]?remux|remux|uhdbd)\b").Success) return 3;
        if (Match(t, @"\bweb[-_. ]?rip\b").Success) return 2;
        if (Match(t, @"\bweb[-_. ]?dl\b").Success) return 3;
        if (Match(t, @"\b(?:hdtv|pdtv|sdtv|dsr|dvbs?[-_. ]?rip|tvrip)\b").Success) return 1;
        var web = Match(t, @"\bweb\b");
        var anchor = Match(t, @"\b(?:19|20)\d{2}\b|\b\d{3,4}[pi]\b");
        return web.Success && anchor.Success && anchor.Index < web.Index ? 3 : 2;
    }
    public static bool IsImplausible(TorrentResult r) => Match(r.Title, @"\bsample\b").Success
        || ParseResolution(r.Title) >= 720 && r.SizeBytes is > 0 and < 52428800;
    public static bool? DirectPlayableFromTitle(string title)
    {
        var t = Replace(title, @"[._-]");
        if (Match(t, @"\b(?:mkv|avi|hevc|x265|h\s*265|hvc1|hev1|vc\s*1|xvid|divx|true\s*hd|mlp|dts|e\s*ac\s*3|eac3|ec\s*3|ddp|ac\s*3|ac3|dd|dolby\s*digital)\b").Success) return false;
        var container = Match(t, @"\b(?:mp4|m4v|mov|webm)\b");
        var video = Match(t, @"\b(?:h\s*264|x264|avc1?|av1|vp9|vp8)\b");
        var audio = Match(t, @"\baac\d?(?:\s*\d)?\b|\b(?:mp4a|opus|mp3|flac)\b");
        return container.Success && video.Success && audio.Success ? true : null;
    }
    public static int DirectPlayableRank(bool? value) => value == true ? 2 : value == null ? 1 : 0;
    public static string NormalizeTitle(string title)
    {
        var t = Replace(title.ToLowerInvariant(), @"[\[\](){}【】]");
        t = Replace(t, @"\b(s\d{1,2}e\d{1,3}|ep?\s*\d{1,3}|season\s*\d+)\b");
        t = Replace(t, @"\b(1080p|720p|480p|2160p|4k|hevc|x265|x264|web-?dl|webrip|bluray|bdrip|hdtv|aac|flac|10bit|dual|multi|sub|dub|vostfr|raw)\b");
        return Replace(Replace(t, @"[._\-–—|]+"), @"\s+").Trim();
    }
    public static string StripEpisodeTokens(string query)
    {
        var t = Replace(query, @"\b(?:s\d{1,3}\s?e\d{1,4}|season\s*\d{1,3}|episode\s*\d{1,4})\b");
        t = Replace(t, @"(?<=\S\s+)\b\d{1,3}x\d{1,3}\b");
        t = Replace(t, @"\s+").Trim();
        return t.Length > 0 ? t : query.Trim();
    }
    public static int RelevanceTier(string title, string query)
    {
        var q = NormalizeTitle(StripEpisodeTokens(query));
        if (q.Length == 0) return 0;
        var head = Replace(title, @"[._]+");
        var marker = Match(head, @"\b(?:s\d{1,3}\s?e\d{1,4}|season\s*\d{1,3}|episode\s*\d{1,4})\b");
        if (marker.Success && marker.Index > 0) head = head[..marker.Index];
        var t = NormalizeTitle(head);
        if (t.Contains(q)) return 3;
        var tokens = q.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var hits = tokens.Count(t.Contains);
        return hits == tokens.Length ? 2 : hits * 2 >= tokens.Length ? 1 : 0;
    }
    public static int SeedersBucket(int seeders) => seeders <= 0 ? 0 : Round(Math.Log10(seeders));
    public static int RecencyBucket(string? date)
    {
        if (!DateTimeOffset.TryParse(date, out var d)) return 0;
        var hours = (DateTimeOffset.UtcNow - d).TotalHours;
        return hours < 0 ? 0 : hours < 24 ? 4 : hours < 72 ? 3 : hours < 168 ? 2 : hours < 720 ? 1 : 0;
    }
    public static string[] ExtractTags(string title)
    {
        List<string> tags = [];
        if (ParseResolution(title) is { } resolution) tags.Add($"{resolution}p");
        foreach (var tag in new[] { "HEVC", "x265", "x264", "AV1", "WEB-DL", "WEBRip", "BluRay", "BDRip", "HDTV", "REMUX", "HDR", "Atmos", "FLAC", "Batch" })
            if (title.Contains(tag, StringComparison.OrdinalIgnoreCase)) tags.Add(tag);
        (string Tag, string Pattern)[] anchored = [("DV", @"\bd(?:olby ?)?v(?:ision)?\b"), ("DTS", @"\bdts(?:-?hd|-?x)?\b"), ("AAC", @"\baac\d?(?:\.\d)?\b"),
            ("Dual", @"\bdual(?:[- ]?audio)?\b"), ("Multi", @"\bmulti(?:ple)?\b"), ("Sub", @"\bsubs?(?:titles?|bed)?\b"), ("Dub", @"\bdub(?:bed)?\b")];
        foreach (var (tag, pattern) in anchored) if (Match(title, pattern).Success) tags.Add(tag);
        return [.. tags];
    }
    public static int VerdictTier(string verdict) => verdict switch { "good" => 0, "unknown" => 1, "weak" => 2, _ => 3 };
    public static int ResolutionPreferenceTier(string title, int? preferred) => preferred == null ? 0 : ParseResolution(title) is not { } resolution ? 1 : resolution == preferred ? 0 : 2;
}
