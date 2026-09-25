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
        var t = Replace(title, @"[._]+");
        t = Replace(t, @"\b(?:\d{3,4}p|x?26[45]|h\.?26[45]|10bit|8bit|5\.1|7\.1|2\.0|ddp?5|dts|aac2|mp3|hdr10\+?|\d+(?:\.\d+)?\s*(?:gb|mb|gib|mib))\b");
        var matches = Regex.Matches(t, @"(?<![\d.])(?:19|20)\d{2}(?![\d.])");
        return matches.Select(m => int.Parse(m.Value)).Where(y => y >= 1900 && y <= DateTime.UtcNow.Year + 2).Select(y => (int?)y).LastOrDefault();
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
        name = WorkIdentityParser.StripTrailingJunkNumber(title, name);
        if (name.Length == 0) name = normalized.Length == 0 ? title : normalized;
        return ep.IsSeasonPack ? $"{name}|S{ep.Season?.ToString() ?? "X"}-pack"
            : ep.Season != null && ep.Episode != null ? $"{name}|S{ep.Season}E{ep.Episode}"
            : ep.Episode != null ? $"{name}|E{ep.Episode}"
            : year != null ? $"{name}|Y{year}" : name;
    }
    public static int ComputeHealth(TorrentResult r) => r.Seeders <= 0 ? r.Leechers > 0 ? 10 : 0
        : Round(Math.Min(100, Math.Min(70, Math.Log10(r.Seeders + 1d) * 28) + Math.Min(30, Math.Log10(r.Seeders / (double)Math.Max(r.Leechers, 1) + 1) * 20)));
    /// <summary>Below this a release is "weak": a better-seeded one at another resolution wins.</summary>
    public const int UsableSeeders = 10;
    /// <summary>0 dead, 1 weak (1–9), 2 usable (10+). HTTP webseeds earn nothing: the built-in engine could not pull from them in testing.</summary>
    public static int SwarmClass(TorrentResult r) => r.Seeders >= UsableSeeders ? 2 : r.Seeders >= 1 ? 1 : 0;
    /// <summary>log2 of seeders, capped at 4096: each doubling of the swarm is one step.</summary>
    public static int SwarmSizeBucket(int seeders) => seeders <= 0 ? 0 : Math.Min(13, (int)Math.Floor(Math.Log2(seeders)) + 1);
    public static IReadOnlyList<TorrentResult> Dedupe(IEnumerable<TorrentResult> results)
    {
        // The same info hash listed by several indexers is one swarm: keep the first listing, but with the best counts seen.
        var list = results.ToList();
        var best = list.Where(r => !string.IsNullOrEmpty(r.InfoHash)).GroupBy(r => r.InfoHash!, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => (Seeders: g.Max(r => r.Seeders), Leechers: g.Max(r => r.Leechers)), StringComparer.OrdinalIgnoreCase);
        HashSet<string> hashes = new(StringComparer.OrdinalIgnoreCase);
        HashSet<string> keys = [];
        return list.Where(r => (string.IsNullOrEmpty(r.InfoHash) || hashes.Add(r.InfoHash))
                && keys.Add($"{NormalizeTitle(r.Title)}|{r.SizeBytes?.ToString() ?? r.SizeLabel ?? ""}"))
            .Select(r => !string.IsNullOrEmpty(r.InfoHash) && best.TryGetValue(r.InfoHash, out var b) && (b.Seeders > r.Seeders || b.Leechers > r.Leechers)
                ? r with { Seeders = b.Seeders, Leechers = b.Leechers } : r).ToArray();
    }
    public static IReadOnlyList<TorrentResult> Rank(IEnumerable<TorrentResult> results, string query, int target = 1080, string category = "all")
    {
        var affinities = new int?[] { null, 360, 480, 576, 720, 1080, 2160 }.Select(r => ResolutionAffinity(r, target)).Order().ToArray();
        var requested = Parse(query);
        var sorted = results.Select(r =>
        {
            var ep = r.Episode ?? Parse(r.Title);
            var kind = r.Route?.Kind;
            var description = Describe(r, query, target, category);
            var relevance = description.Relevance;
            if (new[] { r.Metadata?.Title }.Concat(r.Metadata?.Aliases ?? []).Any(n => n != null && NormalizeTitle(n) == NormalizeTitle(query))
                && WorkIdentityParser.MetadataAgrees(WorkIdentityParser.Parse(r.Title).Name, r.Metadata)) relevance = Math.Max(relevance, 3);
            var good = 2 - (description.Junk ? 1 : 0) - (description.Implausible ? 1 : 0);
            var extras = TorrentFilters.IsExtras(r.Title) || (category == "anime" || kind == "anime" || r.Metadata?.MediaType == "anime") && ep.SpecialType != null;
            // Identity and junk gates first, then swarm class, then resolution, then swarm size within the band.
            double score = (extras ? 0 : 1e12) + (description.CategoryMatch + 1) * 1e10 + relevance * 1e9 + good * 1e8
                + SwarmClass(r) * 1e7 + Array.IndexOf(affinities, description.Affinity) * 1e5
                + SwarmSizeBucket(r.Seeders) * 600 + DirectPlayableRank(description.DirectPlayable) * 1200
                + description.LanguagePreference * 800 + description.Recency * 10;
            var group = Match(r.Title, @"^\s*\[([^\]]{1,60})\]");
            return r with { Episode = ep, Score = score, GroupKey = GroupKey(r.Title, ep), Health = ComputeHealth(r), ReleaseGroup = group.Success ? group.Groups[1].Value.Trim() : null };
        }).OrderByDescending(r => r.Score)
            .ThenBy(r => r, Comparer<TorrentResult>.Create((a, b) =>
            {
                if (requested.Season != null || requested.Episode != null) return 0;
                var ae = a.Episode!; var be = b.Episode!;
                var aOrder = (ae.Season ?? 0) * 10000 + (ae.Episode ?? 0);
                var bOrder = (be.Season ?? 0) * 10000 + (be.Episode ?? 0);
                bool Anime(TorrentResult r) => category == "anime" || r.Route?.Kind == "anime" || r.Metadata?.MediaType == "anime";
                if (Anime(a) && Anime(b) && !ae.IsBatch && !ae.IsSeasonPack && ae.SpecialType == null && !be.IsBatch && !be.IsSeasonPack && be.SpecialType == null)
                {
                    if (ae.AbsoluteEpisode != null && be.Season == null) { aOrder = ae.AbsoluteEpisode.Value; bOrder = be.Episode ?? 0; }
                    if (be.AbsoluteEpisode != null && ae.Season == null) { aOrder = ae.Episode ?? 0; bOrder = be.AbsoluteEpisode.Value; }
                }
                return bOrder.CompareTo(aOrder);
            }))
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
