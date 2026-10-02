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
    /// The work key each hit links to. A record that is a stored work by its own ids (its provider id, stored ids or
    /// verified links, <see cref="WorkIdentities"/>) keeps that work's key, and the other catalogs' records of the same
    /// work take it too, so its downloads, requests and watchlist row stay attached. Every other work is keyed by its name
    /// and the earliest year its records give within a year of the record its card shows, "doctor-who-1963", as films are
    /// by their own year, so a key never depends on which namesakes the catalogs returned this time and always opens the
    /// card's record. A series with no stored record takes a stored namesake within a year of its card's record only when
    /// no id contradicts it and no other work here fits it as well. A key that a stored work of the other kind or another
    /// identity holds, or another work here took, gets the kind on the end ("the-flash-2023-tv"), then a record's own id
    /// ("the-flash-2023-tv-tmdb200"), so a hit never opens or downloads into another work.
    /// </summary>
    private static IReadOnlyList<WorkSearchHit> AssignWorkKeys(IReadOnlyList<WorkSearchHit> hits, IReadOnlyList<StoredWork> stored)
    {
        var ids = hits.Select(IdentityOf).ToList();
        // 1. The stored work each record is, judged by that record's own ids, never by another record's.
        var pins = hits.Select((hit, i) => StoredMatch(stored, hit, ids[i])).ToList();
        // 2. The records of each work, one name of one kind at a time.
        var groups = Enumerable.Range(0, hits.Count).GroupBy(i => (hits[i].IsSeries, Bucket(hits[i])))
            .SelectMany(bucket => KeyGroup.Split([.. bucket.Select(i => KeyGroup.Of(i, hits[i], bucket.Key.Item2, ids[i], pins[i]))]))
            .OrderBy(g => g.Members.Min()).ToList();
        foreach (var group in groups) group.Anchor(hits);
        var keys = new string[hits.Count];
        var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // 3. A work with a stored record keeps that work's key; a record that is another stored work keeps its own.
        foreach (var group in groups.Where(g => g.Pins.Count > 0))
        {
            group.Key = group.Pins.MinBy(w => YearGap(w.Year, group.FirstYear))!.WorkKey;
            foreach (var i in group.Members) keys[i] = pins[i]?.WorkKey ?? group.Key;
            taken.UnionWith(group.Pins.Select(w => w.WorkKey));
        }
        // 4. A series with no stored record takes a stored namesake of its era that no id of it contradicts, when it is the
        // one work here that fits (the namesake's own year breaks a tie): a stored tmdb:100 never lends its key to tmdb:200.
        // A namesake with no year is this show only when no other era is in sight.
        foreach (var work in stored.Where(w => w.IsSeries && !taken.Contains(w.WorkKey)).OrderBy(w => w.WorkKey, StringComparer.Ordinal))
        {
            var name = WorkKeySlug.NameOf(work.WorkKey);
            var named = groups.Where(g => g.IsSeries && g.Bucket == name).ToList();
            var fits = named.Where(g => g.Key == null && g.SameEra(work.Year) && (work.Year is not null || Clusters(named.SelectMany(n => n.Years)).Count < 2) &&
                WorkIdentities.Compare(work.Ids, g.Ids) != IdentityMatch.Different).ToList();
            if (fits.Count > 1) fits = fits.Where(g => work.Year is { } year && g.KeyYears.Contains(year)).ToList();
            if (fits is not [var only]) continue;
            only.Key = work.WorkKey;
            taken.Add(work.WorkKey);
        }
        // 5. Every other work takes the first of its keys that no work above took and no stored work holds, unless that is a
        // film of the same name and year no id contradicts: "the-flash-2023", "the-flash-2023-tv", "the-flash-2023-tv-tmdb200".
        foreach (var group in groups.Where(g => g.Key == null))
        {
            var lead = hits[group.Lead];
            var candidates = WorkKeySlug.KeyCandidates(group.Name, group.IsSeries, lead.Provider, lead.ProviderId);
            group.Key = candidates.FirstOrDefault(candidate => !taken.Contains(candidate) &&
                (stored.FirstOrDefault(w => string.Equals(w.WorkKey, candidate, StringComparison.OrdinalIgnoreCase)) is not { } holder ||
                    !group.IsSeries && !holder.IsSeries && WorkIdentities.Compare(holder.Ids, group.Ids) != IdentityMatch.Different)) ?? candidates[^1];
            taken.Add(group.Key);
        }
        foreach (var group in groups.Where(g => g.Pins.Count == 0))
            foreach (var i in group.Members) keys[i] = group.Key!;
        return hits.Select((hit, i) =>
        {
            var keyed = keys[i] == hit.WorkKey ? hit : hit.WithWorkKey(keys[i]);
            // The stored work's own record keeps the card, so its link stays the library's work.
            return pins[i] is { } pin && string.Equals(pin.WorkKey, keys[i], StringComparison.OrdinalIgnoreCase) ? keyed with { Stored = true } : keyed;
        }).ToList();
    }

    /// <summary>
    /// The stored work a record is by its own ids: one whose own record or canonical ids it shares before one only a link
    /// names, then the nearest year (an anime and its sequel can both be linked to one IMDb id).
    /// </summary>
    private static StoredWork? StoredMatch(IReadOnlyList<StoredWork> stored, WorkSearchHit hit, HashSet<string> ids) =>
        ids.Count == 0 ? null : stored.Where(w => w.IsSeries == hit.IsSeries && WorkIdentities.Compare(w.Ids, ids) == IdentityMatch.Same)
            .OrderByDescending(w => w.Own?.Overlaps(ids) == true).ThenBy(w => YearGap(w.Year, hit.Year)).FirstOrDefault();

    private static int YearGap(int? a, int? b) => a is { } x && b is { } y ? Math.Abs(x - y) : 99;

    /// <summary>
    /// The name a record is grouped under: a film's own key ("dune-2021"); a series' name, without the year its title ends
    /// in when that is its first year (AniList's "Hunter x Hunter (2011)" and TVmaze's "Hunter x Hunter" are one name).
    /// </summary>
    private static string Bucket(WorkSearchHit hit) =>
        hit.IsSeries && hit.Year is { } year && hit.WorkKey.EndsWith($"-{year}", StringComparison.Ordinal) && hit.WorkKey.Length > $"-{year}".Length
            ? hit.WorkKey[..^$"-{year}".Length] : hit.WorkKey;

    /// <summary>Years a year apart are one era: catalogs date a show's start a year apart (Doctor Who 2023 and 2024).</summary>
    private static List<List<int>> Clusters(IEnumerable<int> years)
    {
        var clusters = new List<List<int>>();
        foreach (var year in years.Distinct().Order())
            if (clusters.Count > 0 && year - clusters[^1][^1] <= 1) clusters[^1].Add(year);
            else clusters.Add([year]);
        return clusters;
    }

    /// <summary>The records of one work among the hits of one name and kind: who they are, their ids and years, the stored
    /// works they are, and the key they take.</summary>
    private sealed class KeyGroup
    {
        public required bool IsSeries { get; init; }
        public required string Bucket { get; init; }
        public List<int> Members { get; } = [];
        public HashSet<string> Ids { get; } = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<int> Years { get; } = [];
        public List<StoredWork> Pins { get; } = [];
        public string? Key { get; set; }

        /// <summary>The record the work's card shows (TVmaze before TMDB, Cinemeta and iTunes), set by <see cref="Anchor"/>.</summary>
        public int Lead { get; private set; }

        /// <summary>
        /// The years the work is named and matched to a stored namesake by: its lead record's and those a year from it. Records
        /// that share an id are one work however far apart their catalogs date it (TVmaze's Survivor 2023 is a show IMDb
        /// dates 2001), and the key must open the record its card shows.
        /// </summary>
        public HashSet<int> KeyYears { get; } = [];

        public int? FirstYear => KeyYears.Count > 0 ? KeyYears.Min() : null;

        /// <summary>The year of the record the card shows (else the first year), which a stored namesake must be within a year of.</summary>
        public int? LeadYear { get; private set; }

        /// <summary>The key its name and first year make ("doctor-who-1963"); a film's own key; a series with no year, its name.</summary>
        public string Name => IsSeries && FirstYear is { } year ? $"{Bucket}-{year}" : Bucket;

        public bool SameEra(int? year) => year is null || LeadYear is null || Math.Abs(LeadYear.Value - year.Value) <= 1;

        public void Anchor(IReadOnlyList<WorkSearchHit> hits)
        {
            Lead = Members.OrderBy(i => IdentityRank(hits[i])).ThenBy(i => i).First();
            LeadYear = hits[Lead].Year ?? (Years.Count > 0 ? Years.Min() : null);
            KeyYears.UnionWith(LeadYear is { } lead ? Years.Where(y => Math.Abs(y - lead) <= 1) : Years);
        }

        /// <summary>One record, with the ids of the stored work it is, so a record of another work never joins it.</summary>
        public static KeyGroup Of(int index, WorkSearchHit hit, string bucket, HashSet<string> ids, StoredWork? pin)
        {
            var group = new KeyGroup { IsSeries = hit.IsSeries, Bucket = bucket };
            group.Members.Add(index);
            group.Ids.UnionWith(ids);
            if (hit.Year is { } year) group.Years.Add(year);
            if (pin != null)
            {
                group.Pins.Add(pin);
                group.Ids.UnionWith(pin.Ids);
            }
            return group;
        }

        /// <summary>
        /// The works among one name's records. Records that share an id, or are one stored work, are one work. Then, an era
        /// at a time (catalogs date a start a year apart): an era no catalog lists twice is one work, each catalog's record
        /// of it (Doctor Who 2005 at TVmaze and at TMDB); otherwise a record joins another only when each is the other's one
        /// fit, the same year breaking a tie (The Traitors UK 2022 and US 2023 at TVmaze and at TMDB), or when it is the
        /// other's one fit and no other record wants it. Whatever stays unsure is a work of its own.
        /// </summary>
        public static List<KeyGroup> Split(List<KeyGroup> parts)
        {
            while (TryMerge(parts, (a, b) => a.Pins.Any(p => b.Pins.Any(q => q.WorkKey == p.WorkKey)) ||
                WorkIdentities.Compare(a.Ids, b.Ids) == IdentityMatch.Same)) { }
            var works = new List<KeyGroup>();
            foreach (var era in Eras(parts))
            {
                if (era.All(a => era.All(b => a == b || a.Fits(b))))
                {
                    foreach (var part in era.Skip(1)) era[0].Absorb(part);
                    works.Add(era[0]);
                    continue;
                }
                while (Pair(era)) { }
                works.AddRange(era);
            }
            return works;
        }

        private static bool TryMerge(List<KeyGroup> parts, Func<KeyGroup, KeyGroup, bool> same)
        {
            for (var a = 0; a < parts.Count; a++)
                for (var b = a + 1; b < parts.Count; b++)
                    if (same(parts[a], parts[b]))
                    {
                        parts[a].Absorb(parts[b]);
                        parts.RemoveAt(b);
                        return true;
                    }
            return false;
        }

        private static bool Pair(List<KeyGroup> era)
        {
            var best = era.ToDictionary(part => part, part => part.BestFit(era));
            foreach (var part in era)
            {
                if (best[part] is not { } other) continue;
                if (best[other] != part && (best[other] != null || era.Count(o => best[o] == other) > 1)) continue;
                part.Absorb(other);
                era.Remove(other);
                return true;
            }
            return false;
        }

        /// <summary>The one record this one may be, the same year breaking a tie; null when none or several fit.</summary>
        private KeyGroup? BestFit(List<KeyGroup> era)
        {
            var fits = era.Where(other => other != this && Fits(other)).ToList();
            if (fits.Count > 1) fits = fits.Where(other => other.Years.Overlaps(Years)).ToList();
            return fits is [var only] ? only : null;
        }

        /// <summary>Single-linkage eras: records a year apart (the same year for films), records with no year apart.</summary>
        private static List<List<KeyGroup>> Eras(List<KeyGroup> parts)
        {
            var eras = new List<List<KeyGroup>>();
            foreach (var part in parts)
            {
                var near = eras.Where(era => era.Any(other => other.SameEraAs(part))).ToList();
                if (near.Count == 0)
                {
                    eras.Add([part]);
                    continue;
                }
                near[0].Add(part);
                foreach (var other in near.Skip(1))
                {
                    near[0].AddRange(other);
                    eras.Remove(other);
                }
            }
            return eras;
        }

        /// <summary>Two records that may be one work: the same era, and no catalog both know names them differently.</summary>
        private bool Fits(KeyGroup other) => SameEraAs(other) && WorkIdentities.Compare(Ids, other.Ids) != IdentityMatch.Different;

        private bool SameEraAs(KeyGroup other) => (Years.Count == 0) == (other.Years.Count == 0) &&
            (Years.Count == 0 || Years.Any(a => other.Years.Any(b => IsSeries ? Math.Abs(a - b) <= 1 : a == b)));

        private void Absorb(KeyGroup other)
        {
            Members.AddRange(other.Members);
            Ids.UnionWith(other.Ids);
            Years.UnionWith(other.Years);
            Pins.AddRange(other.Pins.Where(p => Pins.All(q => q.WorkKey != p.WorkKey)));
        }
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
