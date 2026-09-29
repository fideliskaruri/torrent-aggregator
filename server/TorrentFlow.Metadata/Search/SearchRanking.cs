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
        DateTimeOffset now)
    {
        var names = hits.Select(h => (IReadOnlyList<string>)[h.Title, .. h.Aliases]).ToList();
        var tiers = names.Select(n => Relevance.BestTier(query, n)).ToList();
        var typoMode = tiers.All(t => t > 3);
        var years = QueryVariants.QueryYears(query);
        var today = DateOnly.FromDateTime(now.UtcDateTime);
        var scored = new List<(WorkSearchHit Hit, int Index, double Score)>();
        for (var i = 0; i < hits.Count; i++)
        {
            if (tiers[i] >= 6) continue;
            var hit = hits[i];
            var score = Relevance.MatchScore(query, names[i], typoMode) + Popularity(hit, imdbRanks);
            if (hit.Format == "MUSIC") score -= MusicVideoPenalty;
            if (IsUpcoming(hit, today)) score -= UpcomingPenalty;
            if (years.Count > 0 && MatchesYear(hit, years)) score += YearBonus;
            scored.Add((hit, i, score));
        }

        // One card per work. A hit is the same work as a card when it shares the work key (which the web uses as the card
        // key), an external id, or is the AniList entry for a TVmaze animated show. Only cards claim external ids, while
        // every hit claims its work key for the card it folded into, matching the old key-then-id dedupe.
        var output = new List<WorkSearchHit>();
        var owners = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (hit, _, _) in scored.OrderByDescending(x => x.Score).ThenBy(x => x.Index))
        {
            var key = "key:" + hit.WorkKey;
            var ids = hit.ExternalIds?.Select(p => $"{p.Key}:{p.Value}").ToList() ?? [];
            var slot = owners.GetValueOrDefault(key, -1);
            if (slot < 0) slot = ids.Select(id => owners.GetValueOrDefault(id, -1)).FirstOrDefault(s => s >= 0, -1);
            if (slot < 0) slot = SameAnimeSlot(output, hit);
            var card = slot < 0;
            if (card)
            {
                slot = output.Count;
                output.Add(hit);
            }
            // TVmaze lists anime as animated series, sometimes spelled differently ("Dandadan", "Spy×Family"). The AniList
            // entry of the same show carries its anime identity (label, seasons, episode numbering), so it takes the card
            // at the better of the two positions.
            else if (hit.Provider == "anilist" && output[slot].Animated && SameEra(output[slot].Year, hit.Year))
            {
                output[slot] = hit;
                card = true;
            }
            owners.TryAdd(key, slot);
            if (card) foreach (var id in ids) owners.TryAdd(id, slot);
        }
        return output;
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
