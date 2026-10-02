using System.Globalization;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Text;
using TorrentFlow.Data;
using TorrentFlow.Metadata.Text;

namespace TorrentFlow.Metadata.Search;

/// <summary>
/// Orders catalog search hits so "Best match" is the work people mean: how closely a title matches the query plus how
/// well known the work is. Providers answer in their own order and on their own scales, so ranking on title match alone
/// put an obscure literal match (the 1996 TV movie "Frieren") above the anime nearly everyone searches for.
/// Popularity is IMDb's suggestion rank when the hit carries an IMDb id, otherwise the provider's own signal.
/// </summary>
internal static partial class SearchRanking
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
    /// The work key each hit links to. A stored work always keeps its key: a hit that is that work by identity (its
    /// provider id, stored ids or verified links, <see cref="WorkIdentities"/>), or a same-name series from the stored
    /// work's era that no id contradicts, links to it, so its downloads, requests and watchlist row stay attached. Any
    /// other series is keyed by its name and the first year of its era, "doctor-who-1963", as films are, so its key never
    /// depends on which namesakes the catalogs returned this time. A key that a stored work of the other kind or another
    /// identity holds, or another work of these results took, gets the kind on the end ("the-flash-2023-tv"), then the
    /// record's own id ("the-flash-2023-tv-tmdb200"), so a hit never opens or downloads into another work.
    /// </summary>
    private static IReadOnlyList<WorkSearchHit> AssignWorkKeys(IReadOnlyList<WorkSearchHit> hits, IReadOnlyList<StoredWork> stored)
    {
        // Every era of each plain series key: the years of the hits under it and of the stored works named alike. Catalogs
        // date a start a year apart (Doctor Who 2023 and 2024), so an era is years a year apart and is named by its first.
        var eras = new Dictionary<string, List<int>>(StringComparer.Ordinal);
        foreach (var hit in hits.Where(h => h.IsSeries && h.Year is not null))
            Era(eras, hit.WorkKey).Add(hit.Year!.Value);
        foreach (var work in stored.Where(w => w.IsSeries && w.Year is not null))
            Era(eras, WorkKeySlug.NameOf(work.WorkKey)).Add(work.Year!.Value);
        // The key each hit is named by before stored works are consulted: a film's own dated key, a series' era key.
        var named = hits.Select(hit =>
        {
            if (!hit.IsSeries || hit.Year is not { } year) return hit.WorkKey;
            var era = Clusters(eras[hit.WorkKey]).First(c => c.Contains(year)).Min();
            return hit.WorkKey.EndsWith($"-{era}", StringComparison.Ordinal) ? hit.WorkKey : WorkKeys.WorkKeyFor(hit.Title, era);
        }).ToList();
        // The records of one work: hits of a kind under one name whose ids never contradict each other (TVmaze's Doctor Who
        // 2005 and TMDB's, which share no id but name the same show). Each group is one claim, so its records always land
        // on one key, and a stored work is judged against all of their ids together.
        var groups = new List<(bool IsSeries, string Named, HashSet<string> Ids, List<int> Members)>();
        for (var i = 0; i < hits.Count; i++)
        {
            var ids = IdentityOf(hits[i]);
            var group = groups.FindIndex(g => g.IsSeries == hits[i].IsSeries && g.Named == named[i] &&
                WorkIdentities.Compare(g.Ids, ids) != IdentityMatch.Different);
            if (group < 0) groups.Add((hits[i].IsSeries, named[i], ids, [i]));
            else
            {
                groups[group].Ids.UnionWith(ids);
                groups[group].Members.Add(i);
            }
        }
        // Identity decides before any name does, so each pass only takes keys no earlier pass gave to another group.
        var chosen = new string?[groups.Count];
        var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // 1. The stored work these records are (a shared provider id, stored id or verified link) keeps its key.
        for (var g = 0; g < groups.Count; g++)
            if (stored.FirstOrDefault(w => w.IsSeries == groups[g].IsSeries && WorkIdentities.Compare(w.Ids, groups[g].Ids) == IdentityMatch.Same) is { } same)
                taken.Add(chosen[g] = same.WorkKey);
        // 2. A series takes a stored namesake from its era only when no id of it contradicts the records and no group above
        // holds it: a stored tmdb:100 never lends its key to tmdb:200. One with no year is this show only when no other era
        // is in sight.
        for (var g = 0; g < groups.Count; g++)
        {
            var (isSeries, name, ids, members) = groups[g];
            if (chosen[g] != null || !isSeries) continue;
            var year = hits[members[0]].Year;
            var plain = WorkKeySlug.NameOf(name);
            var clusters = eras.TryGetValue(plain, out var years) ? Clusters(years) : [];
            if (stored.FirstOrDefault(w => w.IsSeries && !taken.Contains(w.WorkKey) && WorkKeySlug.NameOf(w.WorkKey) == plain && SameEra(w.Year, year) &&
                    (w.Year is not null || clusters.Count < 2) && WorkIdentities.Compare(w.Ids, ids) != IdentityMatch.Different) is { } namesake)
                taken.Add(chosen[g] = namesake.WorkKey);
        }
        // 3. Every other group takes the first of its keys that no group above took and no stored work of the other kind or
        // another identity holds, base and kind-tagged alike: "the-flash-2023", "the-flash-2023-tv", "the-flash-2023-tv-tmdb200".
        for (var g = 0; g < groups.Count; g++)
        {
            var (isSeries, name, ids, members) = groups[g];
            if (chosen[g] != null) continue;
            var first = hits[members[0]];
            var key = WorkKeySlug.KeyCandidates(name, isSeries, first.Provider, first.ProviderId).FirstOrDefault(candidate => !taken.Contains(candidate) &&
                (stored.FirstOrDefault(w => string.Equals(w.WorkKey, candidate, StringComparison.OrdinalIgnoreCase)) is not { } holder ||
                    holder.IsSeries == isSeries && WorkIdentities.Compare(holder.Ids, ids) != IdentityMatch.Different), name);
            taken.Add(chosen[g] = key);
        }
        var keys = new string[hits.Count];
        for (var g = 0; g < groups.Count; g++)
            foreach (var member in groups[g].Members) keys[member] = chosen[g]!;
        return hits.Select((hit, i) =>
        {
            var keyed = keys[i] == hit.WorkKey ? hit : hit.WithWorkKey(keys[i]);
            // The stored work's own record (it shares an id) keeps the card, so its link stays the library's work.
            return stored.Any(w => w.IsSeries == hit.IsSeries && string.Equals(w.WorkKey, keys[i], StringComparison.OrdinalIgnoreCase) &&
                WorkIdentities.Compare(w.Ids, IdentityOf(hit)) == IdentityMatch.Same) ? keyed with { Stored = true } : keyed;
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
