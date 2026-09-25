using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>One search in the on-demand relaxation ladder. <paramref name="Relaxed"/> selects the zero-seeder picker.</summary>
public sealed record LadderRung(string Kind, string Query, string Category, SearchFilters Filters, bool Relaxed = false)
{
    internal string SearchKey => $"{Query}|{Category}|{FilterKey(Filters)}";
    internal static string FilterKey(SearchFilters f) => $"{f.HasMagnet}:{f.MinSeeders}:{f.Season}:{f.Episode}";
}

/// <summary>
/// Port of the TS on-demand fallback ladder (lib/library/ondemand.ts buildEpisodeRungs and helpers).
/// A single "Show SxxEyy" search is only one way an indexer names a release; anime also needs its short
/// or romaji alias, the anime category, and absolute "Show - 01" numbering. The ladder relaxes one rung at
/// a time and the caller stops at the first working send. Packs are never promoted to episode candidates.
/// </summary>
public static class EpisodeLadder
{
    /// <summary>Per-rung indexer page size — anime titles need more than 15 to surface the single.</summary>
    public const int SearchLimit = 40;

    private static readonly Regex ParenYear = new(@"\(\s*(?:19|20)\d{2}\s*\)");
    private static readonly Regex DashSplit = new(@"\s+[-–—]\s*");
    private static readonly Regex TrailingDashes = new("[-–—]+$");
    private static readonly Regex NonAlnumSpace = new(@"[^\p{L}\p{N}\s]");
    private static readonly Regex Whitespace = new(@"\s+");
    private static readonly Regex NonAlnum = new(@"[^\p{L}\p{N}]+");

    /// <summary>Port of <c>searchTitleVariants</c>: formal title first, then the short forms indexers rank.</summary>
    public static IReadOnlyList<string> SearchTitleVariants(string title)
    {
        var raw = (title ?? "").Trim();
        var output = new List<string>();
        if (raw.Length == 0) return output;
        void Add(string value)
        {
            var v = Whitespace.Replace(value, " ").Trim();
            if (v.Length < 2 || output.Any(x => x.Equals(v, StringComparison.OrdinalIgnoreCase))) return;
            output.Add(v);
        }
        Add(raw);
        var noYear = Whitespace.Replace(ParenYear.Replace(raw, " "), " ").Trim();
        Add(noYear);
        // TMDB writes "-Starting" with no space after the dash, so only the leading whitespace is required.
        var dashHead = TrailingDashes.Replace(DashSplit.Split(noYear)[0], "").Trim();
        Add(dashHead);
        foreach (var b in new[] { dashHead, noYear })
        {
            Add(b.Replace(':', ' '));
            Add(b.Replace(":", "", StringComparison.Ordinal));
            var alnum = Whitespace.Replace(NonAlnumSpace.Replace(Regex.Replace(b, "[:._]", " "), " "), " ").Trim();
            Add(alnum);
            Add(Whitespace.Replace(alnum, ""));
        }
        return output.Take(6).ToList();
    }

    /// <summary>
    /// Port of <c>aliasTitleForms</c>: AniList romaji is often a sentence whose seeded name precedes a comma,
    /// so the comma head (two words, six characters) joins the forms. Colons never split: "Re" is too loose.
    /// </summary>
    public static IReadOnlyList<string> AliasTitleForms(string title)
    {
        var output = new List<string>();
        void Add(string value)
        {
            if (value.Length == 0 || output.Any(x => x.Equals(value, StringComparison.OrdinalIgnoreCase))) return;
            output.Add(value);
        }
        foreach (var variant in SearchTitleVariants(title)) Add(variant);
        foreach (var variant in output.ToArray())
        {
            var head = variant.Split(',')[0].Trim();
            if (head.Length < 6 || !head.Any(char.IsWhiteSpace) || head.Equals(variant, StringComparison.OrdinalIgnoreCase)) continue;
            foreach (var headVariant in SearchTitleVariants(head)) Add(headVariant);
        }
        return output;
    }

    /// <summary>Port of <c>rankAliases</c>: Latin, unpunctuated, spaced, short names first (stable).</summary>
    public static IReadOnlyList<string> RankAliases(IEnumerable<string> aliases)
    {
        static double Cost(string t) =>
            (Regex.IsMatch(t, "[a-z]", RegexOptions.IgnoreCase) ? 0 : 4) +
            (Regex.IsMatch(t, "[:;,]") ? 2 : 0) +
            (t.Any(char.IsWhiteSpace) ? 0 : 1) +
            (Regex.IsMatch(t, @"\p{Ll}\p{Lu}") ? 0.5 : 0) +
            Math.Min(t.Length, 60) / 12.0;
        return aliases.OrderBy(Cost).ToList();
    }

    /// <summary>Port of <c>searchCategoryForMediaType</c>: anime|movies|tv, or null for an unknown type.</summary>
    public static string? SearchCategory(string? mediaType) => mediaType?.Trim().ToLowerInvariant() switch
    {
        "anime" => "anime",
        "movie" or "movies" or "film" => "movies",
        "tv" or "series" or "show" or "tvshow" => "tv",
        _ => null,
    };

    private static List<string> LadderCategories(string? mediaType)
    {
        var primary = SearchCategory(mediaType) ?? "tv";
        var cats = new List<string> { primary };
        // Nyaa is the right place for many series TMDB labels as plain "tv".
        if (primary != "anime") cats.Add("anime");
        cats.Add("all");
        return cats;
    }

    /// <summary>Port of <c>buildEpisodeRungs</c>, in relaxation order.</summary>
    public static IReadOnlyList<LadderRung> BuildEpisodeRungs(string title, EpisodeCursor cursor, string? mediaType,
        IReadOnlyList<string>? extraTitles = null, int? minimumResolution = null)
    {
        var (season, episode) = (cursor.Season, cursor.Episode);
        var titles = SearchTitleVariants(title);
        var primaryTitle = titles.Count > 0 ? titles[0] : (title ?? "").Trim();
        // Provider aliases (AniList romaji/native) are names no punctuation rule can reach from the English title.
        var seenAlias = new HashSet<string>(StringComparer.Ordinal) { primaryTitle.ToLowerInvariant() };
        var injected = (extraTitles ?? []).SelectMany(AliasTitleForms).Where(t => seenAlias.Add(t.ToLowerInvariant())).ToList();
        var aliases = RankAliases(titles.Where(t => !t.Equals(primaryTitle, StringComparison.OrdinalIgnoreCase)).Concat(injected));

        // A rescue alias changes the name, not just its punctuation ("FamilyGuy" is not a rescue for "Family Guy").
        static string Squash(string t) => NonAlnum.Replace(t.ToLowerInvariant(), "");
        var primarySquashed = Squash(primaryTitle);
        var rescues = aliases.Where(a => Squash(a) != primarySquashed || a.Length <= primaryTitle.Length * 0.6).ToList();
        var spellings = aliases.Where(a => !rescues.Contains(a)).ToList();
        var bestAlias = rescues.ElementAtOrDefault(0);
        var secondAlias = rescues.ElementAtOrDefault(1) ?? spellings.ElementAtOrDefault(0);

        var cats = LadderCategories(mediaType);
        var primaryCat = cats[0];
        var animeCat = cats.Contains("anime") ? "anime" : null;
        var extraCats = cats.Where(c => c != primaryCat && c != "anime").ToList();

        var rungs = new List<LadderRung>();
        // One distinct search per (category, query, filters): the relaxed rung re-asks an earlier query on purpose.
        var seen = new HashSet<string>(StringComparer.Ordinal);
        void Push(string kind, string query, string? category, SearchFilters filters, bool relaxed = false)
        {
            if (category == null) return;
            if (!seen.Add($"{category}::{query.ToLowerInvariant()}::{LadderRung.FilterKey(filters)}")) return;
            rungs.Add(new(kind, query, category, filters, relaxed));
        }
        var epFilters = new SearchFilters { HasMagnet = true, MinSeeders = 1, Season = season, Episode = episode };
        var absFilters = new SearchFilters { HasMagnet = true, MinSeeders = 1, Episode = episode };
        string Absolute(string t) => $"{t.Trim()} - {episode:00}";
        void Exact(string? t, string? cat) { if (t != null) Push("exact", cursor.Query(t), cat, epFilters); }
        void Alt(string? t, string? cat) { if (t != null) Push("alt", $"{t.Trim()} {season}x{episode:00}", cat, epFilters); }
        // "Show - 01" numbers from the start of the show, so it is only SxxEyy while hunting season one.
        void AbsoluteRung(string? t, string? cat) { if (t != null && season == 1) Push("absolute", Absolute(t), cat, absFilters); }
        void QualityAbsolute(string? t, string? cat)
        {
            if (t != null && season == 1 && minimumResolution != null) Push("absolute", $"{Absolute(t)} {minimumResolution}p", cat, absFilters);
        }
        void CommonQualityAbsolute(string? t, string? cat)
        {
            if (t != null && season == 1 && minimumResolution == null) Push("absolute", $"{Absolute(t)} 1080p", cat, absFilters);
        }

        Exact(primaryTitle, primaryCat);
        if (bestAlias != null)
        {
            // Anime-shaped title: the catalog string is often a zero-hit query, so the rescue name comes second.
            Exact(bestAlias, animeCat);
            Exact(bestAlias, primaryCat);
            AbsoluteRung(bestAlias, animeCat);
            // Naming the quality narrows the indexer before pagination pushes old singles off the page.
            QualityAbsolute(bestAlias, animeCat);
            CommonQualityAbsolute(bestAlias, animeCat);
            Alt(primaryTitle, primaryCat);
            AbsoluteRung(bestAlias, primaryCat);
        }
        else
        {
            Alt(primaryTitle, primaryCat);
            Exact(primaryTitle, animeCat);
            AbsoluteRung(primaryTitle, animeCat);
        }
        Exact(secondAlias, animeCat);
        Exact(secondAlias, primaryCat);
        AbsoluteRung(secondAlias, animeCat);
        foreach (var cat in extraCats)
        {
            Exact(bestAlias ?? primaryTitle, cat);
            AbsoluteRung(bestAlias ?? primaryTitle, cat);
        }
        Push("relaxed", cursor.Query(bestAlias ?? primaryTitle), animeCat ?? primaryCat,
            new SearchFilters { HasMagnet = true, MinSeeders = 0, Season = season, Episode = episode }, relaxed: true);
        return rungs;
    }

    /// <summary>Port of <c>matchesTargetEpisode</c>: exact SxxEyy, or season-less N while hunting season one.</summary>
    public static bool MatchesTargetEpisode(TorrentResult result, EpisodeCursor target)
    {
        var ep = result.Episode ?? ReleaseNames.ParseEpisode(result.Title);
        if (ep.IsBatch || ep.IsSeasonPack || ep.IsMultiSeason == true || ReleaseNames.IsEpisodeRangeRelease(result.Title)) return false;
        if (ep.Episode != target.Episode) return false;
        return ep.Season == target.Season || ep.Season == null && target.Season == 1;
    }

    /// <summary>Port of <c>episodeReleaseMatchesWork</c>: the release's identity keys to one of the accepted names.</summary>
    public static bool ReleaseMatchesWork(TorrentResult release, IReadOnlyList<string> titles)
    {
        var identity = ReleaseNames.IdentityFor(release.Title);
        return titles.Any(title => ReleaseNames.WorkKeyFor(title) is { Length: > 0 } key && ReleaseNames.WorkKeyMatches(key, identity.Name, identity.Year));
    }

    /// <summary>The TS rung selectors: seeded exact episode in rank order, or (relaxed) any exact episode, healthiest first.</summary>
    public static TorrentResult? Select(LadderRung rung, IEnumerable<TorrentResult> results, EpisodeCursor target, ISet<string> attempted)
    {
        var open = results.Where(r => !attempted.Contains(CandidateKey(r)) && !string.IsNullOrEmpty(r.Magnet) && MatchesTargetEpisode(r, target));
        return rung.Relaxed ? open.OrderByDescending(r => r.Seeders).FirstOrDefault() : open.FirstOrDefault(r => r.Seeders > 0);
    }

    /// <summary>Stable identity for cross-rung dedupe: infohash, else magnet, else id.</summary>
    public static string CandidateKey(TorrentResult r) => LibraryJson.Hash(r.InfoHash) ?? r.Magnet ?? r.Id;

    /// <summary>Port of <c>normalizeTitle</c> (lib/utils.ts), used by the guarded AniList alias recovery.</summary>
    public static string NormalizeTitle(string title)
    {
        var t = Regex.Replace(title.ToLowerInvariant(), @"[\[\](){}【】]", " ");
        t = Regex.Replace(t, @"\b(s\d{1,2}e\d{1,3}|ep?\s*\d{1,3}|season\s*\d+)\b", " ", RegexOptions.IgnoreCase);
        t = Regex.Replace(t, @"\b(1080p|720p|480p|2160p|4k|hevc|x265|x264|web-?dl|webrip|bluray|bdrip|hdtv|aac|flac|10bit|dual|multi|sub|dub|vostfr|raw)\b", " ", RegexOptions.IgnoreCase);
        t = Regex.Replace(t, @"[._\-–—|]+", " ");
        return Whitespace.Replace(t, " ").Trim();
    }
}
