using TorrentFlow.Core;
using TorrentFlow.Core.Text;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Core.Contracts.Library;
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

    /// <summary>
    /// Port of <c>searchTitleVariants</c>: formal title first, then the short forms indexers rank. Apostrophes are made
    /// plain first (<see cref="Apostrophes"/>), so every query and alias form built from a title carries <c>'</c>.
    /// </summary>
    public static IReadOnlyList<string> SearchTitleVariants(string title)
    {
        var raw = Apostrophes.Normalize(title).Trim();
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

    /// <summary>
    /// Season pack fallback searches, built from the same title variants, aliases and categories as the episode ladder.
    /// No season filter: indexers name batches without one, and the pack scope and file list decide.
    /// </summary>
    public static IReadOnlyList<LadderRung> BuildPackRungs(string title, int season, string? mediaType, IReadOnlyList<string>? extraTitles,
        int? minimumResolution)
    {
        var titles = SearchTitleVariants(title);
        var primaryTitle = titles.Count > 0 ? titles[0] : (title ?? "").Trim();
        var alias = RankAliases((extraTitles ?? []).SelectMany(AliasTitleForms)
            .Where(a => !a.Equals(primaryTitle, StringComparison.OrdinalIgnoreCase))).FirstOrDefault();
        var cats = LadderCategories(mediaType);
        var filters = new SearchFilters { HasMagnet = true, MinSeeders = 1 };
        var rungs = new List<LadderRung>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Push(string kind, string query, string category)
        {
            if (seen.Add($"{category}::{query}")) rungs.Add(new(kind, query, category, filters));
        }
        if (minimumResolution is { } preferred) Push("pack-quality", $"{primaryTitle} S{season:00} {preferred}p", cats[0]);
        Push("pack", $"{primaryTitle} S{season:00}", cats[0]);
        Push("pack", $"{primaryTitle} Season {season}", cats[0]);
        if (alias != null) Push("pack-alias", $"{alias} S{season:00}", cats.Contains("anime") ? "anime" : cats[0]);
        Push("pack", $"{primaryTitle} S{season:00}", "all");
        return rungs.Take(5).ToList();
    }

    /// <summary>Port of <c>buildEpisodeRungs</c>, in relaxation order.</summary>
    public static IReadOnlyList<LadderRung> BuildEpisodeRungs(string title, EpisodeCursor cursor, string? mediaType,
        IReadOnlyList<string>? extraTitles = null, int? minimumResolution = null, AnimeEpisodeMapping? mapping = null,
        bool preferRequestedQuality = false)
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
        var rescues = aliases.Where(a => Squash(a) != primarySquashed || a.Length <= primaryTitle.Length * 0.6)
            .DistinctBy(Squash).ToList();
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

        // A mapping speaks for its entry's episodes on the page season it was placed on; `local` is the entry's own number.
        var mapped = mapping != null && season == mapping.TargetSeason ? mapping : null;
        var local = mapped?.Local(episode) ?? episode;
        var franchiseTitles = mapped?.FranchiseTitles.Select(Apostrophes.Normalize).ToList() ?? [];
        if (mapped is { FranchiseSeason: { } mappedFirst } && local >= 1 &&
            RankAliases(franchiseTitles.Take(2)).FirstOrDefault() is { } franchiseName)
        {
            var first = new EpisodeCursor(mappedFirst, local + mapped.SeasonEpisodeOffset);
            Push("mapped-season", first.Query(franchiseName), primaryCat,
                new() { HasMagnet = true, MinSeeders = 1, Season = first.Season, Episode = first.Episode });
        }
        if (preferRequestedQuality && minimumResolution is { } preferred)
            Push("preferred-quality", $"{cursor.Query(primaryTitle)} {preferred}p", primaryCat, epFilters);
        Exact(primaryTitle, primaryCat);
        if (mapped?.IsSequel == true && local >= 1)
        {
            // Entry English/romaji names qualify a cour and number it from its own episode 1.
            var entryCursor = new EpisodeCursor(1, local);
            var entryFilters = epFilters with { Season = 1, Episode = local };
            var entryAbsolute = absFilters with { Episode = local };
            foreach (var entryTitle in mapped.EntryTitles.Take(2).Select(Apostrophes.Normalize))
            {
                Push("exact", entryCursor.Query(entryTitle), animeCat ?? primaryCat, entryFilters);
                Push("absolute", $"{entryTitle.Trim()} - {local:00}", animeCat ?? primaryCat, entryAbsolute);
                // Internal hyphens in provider names can exclude the spaced release spelling on Nyaa.
                var spaced = Whitespace.Replace(NonAlnumSpace.Replace(entryTitle, " "), " ").Trim();
                Push("absolute", $"{spaced} - {local:00}", animeCat ?? primaryCat, entryAbsolute);
            }
        }
        if (mapped != null && local >= 1)
        {
            foreach (var name in new[] { primaryTitle, bestAlias }.Where(n => n != null).Cast<string>()
                .Concat(RankAliases(franchiseTitles)).DistinctBy(Squash))
            {
                if (mapped.FranchiseSeason is { } mappedSeason)
                {
                    var franchiseCursor = new EpisodeCursor(mappedSeason, local + mapped.SeasonEpisodeOffset);
                    Push("mapped-season", franchiseCursor.Query(name), primaryCat,
                        new() { HasMagnet = true, MinSeeders = 1, Season = franchiseCursor.Season, Episode = franchiseCursor.Episode });
                }
                if (mapped.AbsoluteOffset is { } offset)
                    Push("mapped-absolute", $"{name} - {offset + local:00}", animeCat ?? primaryCat,
                        new() { HasMagnet = true, MinSeeders = 1, Episode = offset + local });
            }
        }
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
        foreach (var alias in rescues.Skip(2))
        {
            Exact(alias, animeCat ?? primaryCat);
            AbsoluteRung(alias, animeCat ?? primaryCat);
        }
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
    public static bool MatchesTargetEpisode(TorrentResult result, EpisodeCursor target, AnimeEpisodeMapping? mapping = null)
    {
        var parsed = ReleaseEpisodeParser.Parse(result.Title);
        var ep = result.Episode ?? parsed;
        if (parsed.IsBatch || ReleaseEpisodeParser.IsMultiEpisode(result.Title, ep)) return false;
        var local = target.Episode;
        if (mapping != null && target.Season == mapping.TargetSeason)
        {
            local = mapping.Local(target.Episode);
            if (mapping.FranchiseSeason is { } season && ep.Season == season &&
                ep.Episode == local + mapping.SeasonEpisodeOffset) return true;
            if (mapping.AbsoluteOffset is { } offset &&
                (ep.AbsoluteEpisode == offset + local || ep.Season == null && ep.Episode == offset + local)) return true;
            // A page placed by the show's numbering (TMDB S01E29) is also how some releases number it.
            if ((mapping.TargetSeason != 1 || mapping.EntryEpisodeOffset != 0) && ep.Season == target.Season && ep.Episode == target.Episode)
                return true;
            // A base-franchise S01E05 isn't the sequel's local E05. Only an entry-qualified name may use local numbering.
            if (mapping.IsSequel || mapping.AbsoluteOffset is > 0 || mapping.FranchiseSeason is > 1)
            {
                var name = ReleaseSelection.Normalize(result.Title);
                var bases = mapping.FranchiseTitles.Concat(mapping.PrequelTitles ?? []).Select(ReleaseSelection.Normalize).ToHashSet();
                if (!mapping.EntryTitles.Select(ReleaseSelection.Normalize)
                    .Any(t => t.Length > 0 && !bases.Contains(t) && name.Contains(t, StringComparison.Ordinal))) return false;
                return ep.Episode == local && ep.Season is null or 1;
            }
        }
        if (ep.Episode != target.Episode) return false;
        return ep.Season == target.Season || ep.Season == null && target.Season == 1;
    }

    /// <summary>Port of <c>episodeReleaseMatchesWork</c>: the release's identity keys to one of the accepted names.</summary>
    public static bool ReleaseMatchesWork(TorrentResult release, IReadOnlyList<string> titles, int? premiereYear = null)
    {
        if (premiereYear is { } expected && ReleaseNames.ReleaseYear(release.Title) is { } actual && actual != expected)
            return false;
        var identity = ReleaseNames.IdentityFor(release.Title);
        if (titles.Any(title => WorkKeySlug.WorkKeyFor(title) is { Length: > 0 } key && WorkKeySlug.Matches(key, identity.Name, identity.Year)))
            return true;
        // Fansub releases may retain the title itself in brackets, unlike ordinary release-group brackets.
        var bracket = Regex.Match(release.Title, @"(?:\[(?<title>[^\]]+)\]|(?<title>[^\[\]【】]+))\s*\[\d{1,4}(?:v\d+)?\]",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
        if (!bracket.Success) return false;
        return bracket.Groups["title"].Value.Split('/').Any(name =>
            titles.Any(title => WorkKeySlug.WorkKeyFor(title) is { Length: > 0 } key &&
                WorkKeySlug.Matches(key, name.Trim(), null)));
    }

    /// <summary>The TS rung selectors: seeded exact episode in rank order, or (relaxed) any exact episode, healthiest first.</summary>
    public static TorrentResult? Select(LadderRung rung, IEnumerable<TorrentResult> results, EpisodeCursor target, ISet<string> attempted,
        AnimeEpisodeMapping? mapping = null)
    {
        var open = results.Where(r => !attempted.Contains(CandidateKey(r)) && !string.IsNullOrEmpty(r.Magnet) && MatchesTargetEpisode(r, target, mapping));
        return open.FirstOrDefault(r => r.Seeders > 0) ?? (rung.Relaxed ? open.FirstOrDefault() : null);
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
