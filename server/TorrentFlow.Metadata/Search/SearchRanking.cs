using System.Globalization;
using TorrentFlow.Metadata.Text;

namespace TorrentFlow.Metadata.Search;

/// <summary>
/// Orders catalog search hits so "Best match" is the work people mean: how closely a title matches the query plus how
/// well known the work is. Providers answer in their own order and on their own scales, so ranking on title match alone
/// put an obscure literal match (the 1996 TV movie "Frieren") above the anime nearly everyone searches for.
/// Popularity is IMDb's suggestion rank when the hit carries an IMDb id, otherwise the provider's own signal.
/// </summary>
internal static class SearchRanking
{
    private const double UnknownPopularity = 0.2;
    private const double MusicVideoPenalty = 0.4;
    private const double UpcomingPenalty = 0.3;
    private const double YearBonus = 0.6;

    /// <summary>AniList list count (users who added the entry): about 100 → 0, 1M → 1.</summary>
    public static double AniListPopularity(int? users) =>
        users is > 0 ? Clamp((Math.Log10(users.Value) - 2) / 4) : UnknownPopularity;

    /// <summary>IMDb suggestion rank (1 = most popular): the top few hundred → ~0.9, two million → 0.</summary>
    public static double ImdbPopularity(int rank) => Clamp((6.3 - Math.Log10(Math.Max(1, rank))) / 4.3);

    /// <summary>TVmaze weight (0–100). Squared because most catalogue shows still sit mid-range.</summary>
    public static double TvmazeWeight(int? weight) =>
        weight is >= 0 ? 0.9 * Math.Pow(Math.Min(weight.Value, 100) / 100.0, 2) : UnknownPopularity;

    /// <summary>Cinemeta, TMDB and iTunes give no popularity figure but already list well-known works first.</summary>
    public static double PositionPrior(int index) => Math.Max(0.1, 0.45 - 0.03 * index);

    /// <summary>Scores and orders hits, one card per work; hits that do not match the query are dropped.</summary>
    public static List<WorkSearchHit> Rank(IReadOnlyList<WorkSearchHit> hits, string query, IReadOnlyDictionary<string, int> imdbRanks,
        DateTimeOffset now, IReadOnlyList<StoredWork>? stored = null)
    {
        hits = AssignWorkKeys(hits, stored ?? []);
        var names = hits.Select(h => (IReadOnlyList<string>)[h.Title, .. h.Aliases]).ToList();
        var tiers = names.Select(n => Relevance.BestTier(query, n)).ToList();
        var typoMode = tiers.All(t => t > 3);
        var years = QueryVariants.QueryYears(query);
        var today = DateOnly.FromDateTime(now.UtcDateTime);
        var scored = new List<(WorkSearchHit Hit, int Index, double Score, bool Matches)>();
        for (var i = 0; i < hits.Count; i++)
        {
            var hit = hits[i];
            // A hit no name of which matches can still be the same work as a card (TVmaze's "La Casa de Papel" carries the
            // IMDb id of "Money Heist"), so it is kept to fold into that card, but never makes a card of its own. A name
            // the provider matched the query by (an original or alternative title) is among its aliases (see
            // WorkSearchService.WithAlternateTitle), so it matches like any other name.
            var matches = tiers[i] < 6;
            var match = matches ? Relevance.MatchScore(query, names[i], typoMode) : 0;
            var score = match + Popularity(hit, imdbRanks);
            if (hit.Format == "MUSIC") score -= MusicVideoPenalty;
            if (IsUpcoming(hit, today)) score -= UpcomingPenalty;
            if (years.Count > 0 && MatchesYear(hit, years)) score += YearBonus;
            scored.Add((hit, i, matches ? score : score - 10, matches));
        }

        // One card per work. A hit is the same work as a card when it shares the work key (which the web uses as the card
        // key), an external id, is the AniList entry for a TVmaze animated show, or is the same film named alike from the
        // same year in another catalog. Every hit claims its work key and ids for the card it folded into.
        var output = new List<WorkSearchHit>();
        var owners = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (hit, _, _, matches) in scored.OrderByDescending(x => x.Score).ThenBy(x => x.Index))
        {
            var key = "key:" + hit.WorkKey;
            var ids = IdsOf(hit);
            var slot = owners.GetValueOrDefault(key, -1);
            if (slot < 0) slot = ids.Select(id => owners.GetValueOrDefault(id, -1)).FirstOrDefault(s => s >= 0, -1);
            if (slot < 0) slot = SameAnimeSlot(output, hit);
            if (slot < 0) slot = SameFilmSlot(output, hit);
            if (slot < 0)
            {
                if (!matches) continue;
                slot = output.Count;
                output.Add(hit);
            }
            // TVmaze lists anime as animated series, sometimes spelled differently ("Dandadan", "Spy×Family"). The AniList
            // entry of the same show carries its anime identity (label, seasons, episode numbering), so it takes the card
            // at the better of the two positions.
            else if (hit.Provider == "anilist" && output[slot].Animated && !output[slot].Stored && SameEra(output[slot].Year, hit.Year))
                output[slot] = Absorb(hit, output[slot]);
            else if (PreferredIdentity(hit, output[slot]))
                output[slot] = Absorb(hit, output[slot]);
            else
                output[slot] = Absorb(output[slot], hit);
            owners.TryAdd(key, slot);
            foreach (var id in ids) owners.TryAdd(id, slot);
        }
        return output;
    }

    private static List<string> IdsOf(WorkSearchHit hit) => hit.ExternalIds?.Select(p => $"{p.Key}:{p.Value}").ToList() ?? [];

    /// <summary>
    /// Which catalog's record a card shows when several catalogs list the work: the one with its original release year and
    /// richest identity. AniList owns anime films (its anime series take over TVmaze's above), TVmaze series episodes, TMDB
    /// dates films by their first release, and Cinemeta (IMDb) dates some films by their US release (Spirited Away 2003).
    /// </summary>
    private static bool PreferredIdentity(WorkSearchHit hit, WorkSearchHit card)
    {
        // A stored work's own record keeps the card, so its title link stays the library's work key and provider.
        if (hit.Stored != card.Stored) return hit.Stored;
        if (card.Provider == "anilist") return false;
        if (hit.Provider == "anilist") return !hit.IsSeries && !card.IsSeries;
        return IdentityRank(hit) < IdentityRank(card);
    }

    private static int IdentityRank(WorkSearchHit hit) => hit.Provider switch
    {
        "tvmaze" => 1,
        "tmdb" => 2,
        "cinemeta" => 3,
        "itunes" => 4,
        _ => 5,
    };

    /// <summary><paramref name="card"/> with the other catalog's ids and names added, so either finds the same card.</summary>
    private static WorkSearchHit Absorb(WorkSearchHit card, WorkSearchHit other)
    {
        var ids = new Dictionary<string, string>(card.ExternalIds ?? new Dictionary<string, string>(), StringComparer.Ordinal);
        foreach (var (k, v) in other.ExternalIds ?? new Dictionary<string, string>()) ids.TryAdd(k, v);
        var aliases = card.Aliases.Concat([other.Title, .. other.Aliases])
            .Where(a => !string.Equals(a, card.Title, StringComparison.OrdinalIgnoreCase))
            .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        return card with
        {
            ExternalIds = ids, Aliases = aliases, PosterUrl = card.PosterUrl ?? other.PosterUrl, Overview = card.Overview ?? other.Overview,
        };
    }

    /// <summary>
    /// The work key each hit links to. A stored work always keeps its key: a hit that is that work by provider identity
    /// (provider id, a stored id or a verified link), or a same-name series from the stored work's era, links to it, so
    /// its downloads, requests and watchlist row stay attached. Series keys carry no year, so namesakes from other eras
    /// (Doctor Who 1963 and 2023 next to a stored 2005, Hunter x Hunter 1999 and 2011) get their year in their key,
    /// "doctor-who-1963". A series nobody stored keeps the plain key unless a namesake shows up; its year then comes from
    /// its own era, never from which catalogs answered first or which is more popular.
    /// </summary>
    private static IReadOnlyList<WorkSearchHit> AssignWorkKeys(IReadOnlyList<WorkSearchHit> hits, IReadOnlyList<StoredWork> stored)
    {
        var resolved = hits.Select(hit => stored.FirstOrDefault(w => w.IsSeries == hit.IsSeries && w.Ids.Overlaps(IdentityOf(hit))) is { } work
            ? hit.WithWorkKey(work.WorkKey) with { Stored = true } : hit).ToList();
        // Every era of each plain series key: the years of the hits under it and of the stored works named alike.
        var eras = new Dictionary<string, List<int>>(StringComparer.Ordinal);
        foreach (var hit in hits.Where(h => h.IsSeries && h.Year is not null))
            Era(eras, hit.WorkKey).Add(hit.Year!.Value);
        foreach (var work in stored.Where(w => w.IsSeries && w.Year is not null))
            Era(eras, PlainSeriesKey(work.WorkKey)).Add(work.Year!.Value);
        return resolved.Select((hit, i) =>
        {
            if (hit.Stored || !hit.IsSeries) return hit;
            var plain = hits[i].WorkKey;
            var namesakes = stored.Where(w => w.IsSeries && PlainSeriesKey(w.WorkKey) == plain).ToList();
            var clusters = eras.TryGetValue(plain, out var years) ? Clusters(years) : [];
            // A stored namesake with no year is this show only when no other era is in sight.
            if (namesakes.FirstOrDefault(w => SameEra(w.Year, hit.Year) && (w.Year is not null || clusters.Count < 2)) is { } same)
                return hit.WithWorkKey(same.WorkKey);
            if (hit.Year is not { } year || (clusters.Count < 2 && namesakes.Count == 0)) return hit;
            var era = clusters.First(c => c.Contains(year)).Min();
            return plain.EndsWith($"-{era}", StringComparison.Ordinal) ? hit : hit.WithWorkKey(WorkKeys.WorkKeyFor(hit.Title, era));
        }).ToList();
    }

    private static List<int> Era(Dictionary<string, List<int>> eras, string key) =>
        eras.TryGetValue(key, out var list) ? list : eras[key] = [];

    /// <summary>Years a year apart are one era: catalogs date a show's start a year apart (Doctor Who 2023 and 2024).</summary>
    private static List<List<int>> Clusters(IEnumerable<int> years)
    {
        var clusters = new List<List<int>>();
        foreach (var year in years.Distinct().Order())
            if (clusters.Count > 0 && year - clusters[^1][^1] <= 1) clusters[^1].Add(year);
            else clusters.Add([year]);
        return clusters;
    }

    /// <summary>"doctor-who-1963" → "doctor-who"; a key with no year suffix is already plain.</summary>
    private static string PlainSeriesKey(string key) =>
        key.Length > 5 && key[^5] == '-' && key[^4..].All(char.IsAsciiDigit) ? key[..^5] : key;

    /// <summary>The ids a hit is known by, as "provider:id" (Cinemeta's ids are IMDb's).</summary>
    private static HashSet<string> IdentityOf(WorkSearchHit hit)
    {
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (hit.ProviderId is { Length: > 0 } own) ids.Add(StoredWork.Id(hit.Provider, own));
        foreach (var (provider, id) in hit.ExternalIds ?? new Dictionary<string, string>())
            if (!string.IsNullOrWhiteSpace(id)) ids.Add(StoredWork.Id(provider, id));
        return ids;
    }

    /// <summary>The card already showing this film from another catalog: the same name released the same year or the next,
    /// or a name one letter apart from the very same year (TMDB's "Se7en" is IMDb's "Seven", both 1995). "A Silent Voice:
    /// The Movie" is "A Silent Voice".</summary>
    private static int SameFilmSlot(List<WorkSearchHit> output, WorkSearchHit hit)
    {
        if (hit.IsSeries || hit.Year is null) return -1;
        var names = hit.Aliases.Prepend(hit.Title).Select(FilmName).Where(n => n.Length > 0).ToList();
        for (var i = 0; i < output.Count; i++)
        {
            var card = output[i];
            if (card.IsSeries || card.Provider == hit.Provider || card.Year is null || !SameEra(card.Year, hit.Year)) continue;
            foreach (var name in card.Aliases.Prepend(card.Title).Select(FilmName))
                if (names.Any(n => n == name || (card.Year == hit.Year && n.Length >= 5 && Relevance.BoundedDamerauLevenshtein(n, name, 1) != null)))
                    return i;
        }
        return -1;
    }

    private static string FilmName(string name)
    {
        var compact = CompactName(name);
        foreach (var suffix in (string[])["themovie", "movie"])
            if (compact.Length > suffix.Length + 3 && compact.EndsWith(suffix, StringComparison.Ordinal)) return compact[..^suffix.Length];
        return compact;
    }

    /// <summary>The card already showing this anime under another work key: an AniList entry and a TVmaze animated show
    /// with the same name from the same era.</summary>
    private static int SameAnimeSlot(List<WorkSearchHit> output, WorkSearchHit hit)
    {
        if (hit.Provider != "anilist" && !hit.Animated) return -1;
        for (var i = 0; i < output.Count; i++)
        {
            var (anime, show) = hit.Provider == "anilist" ? (hit, output[i]) : (output[i], hit);
            if (anime.Provider == "anilist" && show.Animated && SameEra(anime.Year, show.Year) && NamedAlike(anime, show)) return i;
        }
        return -1;
    }

    private static bool NamedAlike(WorkSearchHit anime, WorkSearchHit show)
    {
        var name = CompactName(show.Title);
        return name.Length > 0 && anime.Aliases.Prepend(anime.Title).Any(n => CompactName(n) == name);
    }

    private static string CompactName(string name) => Relevance.NormalizeForMatch(name).Replace(" ", "");

    private static double Popularity(WorkSearchHit hit, IReadOnlyDictionary<string, int> imdbRanks) =>
        hit.ExternalIds is { } ids && ids.TryGetValue("imdb", out var imdb) && imdbRanks.TryGetValue(imdb, out var rank)
            ? ImdbPopularity(rank)
            : hit.Popularity ?? UnknownPopularity;

    private static bool IsUpcoming(WorkSearchHit hit, DateOnly today)
    {
        if (hit.Upcoming) return true;
        if (hit.ReleaseDate is { Length: >= 10 } date &&
            DateOnly.TryParseExact(date[..10], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var released))
            return released > today;
        return hit.Year > today.Year;
    }

    /// <summary>The typed year is the release year, or part of the title ("Blade Runner 2049").</summary>
    private static bool MatchesYear(WorkSearchHit hit, IReadOnlyList<int> years) =>
        (hit.Year is { } year && years.Contains(year)) ||
        Relevance.NormalizeForMatch(hit.Title).Split(' ')
            .Any(token => int.TryParse(token, NumberStyles.None, CultureInfo.InvariantCulture, out var value) && years.Contains(value));

    private static bool SameEra(int? a, int? b) => a is null || b is null || Math.Abs(a.Value - b.Value) <= 1;

    private static double Clamp(double value) => Math.Clamp(value, 0, 1);
}
