using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Search;
using static TorrentFlow.Search.EpisodeParser;
using static TorrentFlow.Search.ReleaseQuality;

namespace TorrentFlow.Search;

public static class ReleaseRanking
{
    private const string Tokens = @"\d{3,4}p|4k|8k|uhd|hd|sd|hevc|x\s*26[45]|h\s*26[45]|avc|av1|xvid|divx|hi10p|10\s*bit|8\s*bit|aac\s*\d*(?:\s*\d)?|e?ac3\s*\d*(?:\s*\d)?|ddp?\s*\d*(?:\s*\d)?|dts(?:\s*hd)?(?:\s*ma)?\s*\d*(?:\s*\d)?|flac\s*\d*(?:\s*\d)?|opus\s*\d*(?:\s*\d)?|truehd\s*\d*(?:\s*\d)?|atmos|mp3|e?-?ac-?3|(?:dual|multi)\s*audio|web\s*-?\s*dl|web\s*-?\s*rip|web|blu\s*-?\s*ray|bd\s*rip|br\s*rip|hd\s*rip|bd|hdtv|dvd\s*rip|dvd|remux|hdr\d*|dv|sdr|cam|ts|extended|unrated|theatrical|imax|hybrid|\d{1,2}\s*bit|repack|proper|rerip|internal|uncensored|batch|complete|subbed|dubbed|raw|\d+(?:[.,]\d+)?\s*[mg]b|nordic|multi|multisubs?|amzn|dsnp|atvp|hulu|hmax|nf|cr|funi|tver|yts|rarbg|bili|bilibili|b-global|bglobal|iq|iqiyi|viki|wetv|abema|baha|mkv|mp4|avi|m4v";
    public static string StripReleaseGroup(string title)
    {
        var result = Replace(Replace(title, @"[\[({【][^\])}】]*[\])}】]"), @"\s+").Trim();
        if (result.Length == 0) result = title;
        if (Match(Replace(result, @"[._]"), $@"\b(?:{Tokens})\b").Success)
            result = Replace(result, @"(?<=\S)-([A-Za-z0-9]{2,12})\s*$").Trim();
        return result;
    }
    public static int? ReleaseYear(string title)
    {
        var t = Replace(title, @"[._]");
        var matches = Regex.Matches(t, @"(?<!\d)(?:19|20)\d{2}(?!\d|p)", RegexOptions.IgnoreCase);
        return matches.Cast<Match>().FirstOrDefault(m => m.Index > 0 && t[..m.Index].Trim(' ', '[', '(', '{').Length > 0) is { } year
            ? int.Parse(year.Value) : null;
    }
    public static string GroupKey(string title, EpisodeInfo ep)
    {
        var normalized = NormalizeTitle(StripReleaseGroup(title));
        var name = Replace(normalized, @"\b(s\d{1,2}\s*e\d{1,4}|\d{1,2}x\d{1,4}|ep?\s*\d{1,4}|season\s*\d+|episode\s*\d+)\b");
        name = Replace(name, $@"\b(?:{Tokens})\b");
        if (ep.Episode != null) name = Replace(name, $@"\b0*{ep.Episode}\b");
        if (ep.AbsoluteEpisode != null) name = Replace(name, $@"\b0*{ep.AbsoluteEpisode}\b");
        var year = ReleaseYear(title);
        if (year != null) name = Replace(name, $@"(?<![\d.]){year}(?![\d.])");
        name = Replace(name, @"\s+").Trim();
        if (Match(title, @"[\])]\s+\d{1,3}\s*$").Success) name = Replace(name, @"\s+\d{1,3}$").Trim();
        if (name.Length == 0) name = normalized.Length == 0 ? title : normalized;
        return ep.IsSeasonPack ? $"{name}|S{ep.Season?.ToString() ?? "X"}-pack"
            : ep.Season != null && ep.Episode != null ? $"{name}|S{ep.Season}E{ep.Episode}"
            : ep.Episode != null ? $"{name}|E{ep.Episode}"
            : year != null ? $"{name}|Y{year}" : name;
    }
    public static int ComputeHealth(TorrentResult r) => r.Seeders <= 0 ? r.Leechers > 0 ? 10 : 0
        : Round(Math.Min(100, Math.Min(70, Math.Log10(r.Seeders + 1d) * 28) + Math.Min(30, Math.Log10(r.Seeders / (double)Math.Max(r.Leechers, 1) + 1) * 20)));
    public static IReadOnlyList<TorrentResult> Dedupe(IEnumerable<TorrentResult> results)
    {
        HashSet<string> hashes = new(StringComparer.OrdinalIgnoreCase);
        HashSet<string> keys = [];
        return results.Where(r => (string.IsNullOrEmpty(r.InfoHash) || hashes.Add(r.InfoHash))
            && keys.Add($"{NormalizeTitle(r.Title)}|{r.SizeBytes?.ToString() ?? r.SizeLabel ?? ""}")).ToArray();
    }
    public static IReadOnlyList<TorrentResult> Rank(IEnumerable<TorrentResult> results, string query, int target = 1080, string category = "all")
    {
        var affinities = new int?[] { null, 360, 480, 576, 720, 1080, 2160 }.Select(r => ResolutionAffinity(r, target)).Order().ToArray();
        var requested = Parse(query);
        var sorted = results.Select(r =>
        {
            var ep = r.Episode ?? Parse(r.Title);
            var kind = r.Route?.Kind;
            var actual = kind == "software" ? "apps" : kind;
            var categoryMatch = category == "all" || actual == null ? 0 : category == actual ? 1 : -1;
            var relevance = RelevanceTier(r.Title, query);
            var good = 2 - (IsJunkSource(r.Title) ? 1 : 0) - (IsImplausible(r) ? 1 : 0);
            var language = Match(Replace(r.Title, @"[._()[\]\-]+"), @"\b(?:vostfr|subfrench|truefrench|french|vf{1,2})\b").Success ? 0
                : Match(r.Title, @"\b(?:eng|english|dual\s+audio|dual[-\s]?audio|dub(?:bed)?)\b").Success ? 2 : 1;
            var extras = TorrentFilters.IsExtras(r.Title) || (category == "anime" || kind == "anime" || r.Metadata?.MediaType == "anime") && ep.SpecialType != null;
            double score = (extras ? 0 : 1_000_000_000) + (categoryMatch + 1) * 10_000_000 + relevance * 1_000_000 + good * 100_000
                + (r.Seeders >= 3 ? 10_000 : 0) + Array.IndexOf(affinities, ResolutionAffinity(ParseResolution(r.Title), target)) * 1000
                + DirectPlayableRank(DirectPlayableFromTitle(r.Title)) * 300 + language * 100 + Math.Min(SeedersBucket(r.Seeders), 9) * 10 + RecencyBucket(r.PublishedAt);
            var group = Match(r.Title, @"^\s*\[([^\]]{1,60})\]");
            return r with { Episode = ep, Score = score, GroupKey = GroupKey(r.Title, ep), Health = ComputeHealth(r), ReleaseGroup = group.Success ? group.Groups[1].Value.Trim() : null };
        }).OrderByDescending(r => r.Score)
            .ThenByDescending(r => requested.Season == null && requested.Episode == null ? (r.Episode!.Season ?? 0) * 10_000 + (r.Episode.Episode ?? 0) : 0)
            .ThenByDescending(r => SeedersBucket(r.Seeders)).ThenByDescending(r => r.SizeBytes ?? 0);
        HashSet<string> seen = [];
        return sorted.Select(r => r with { BestPick = seen.Add(r.GroupKey!) }).ToArray();
    }
    public static IReadOnlyList<ReleaseGroup> Groups(IEnumerable<TorrentResult> results) => results.GroupBy(r => r.GroupKey ?? r.Id)
        .Select(g =>
        {
            var sorted = g.OrderByDescending(r => r.Score).ToArray();
            var best = sorted[0];
            var label = best.Episode?.Label is { } ep ? $"{best.Metadata?.Title ?? best.Title[..Math.Min(40, best.Title.Length)]} · {ep}"
                : best.Title[..Math.Min(60, best.Title.Length)];
            return new ReleaseGroup(g.Key, label, best, sorted.Skip(1).ToArray());
        }).OrderByDescending(g => g.Best.Score).ToArray();
}
