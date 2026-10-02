using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Text;
using TorrentFlow.Metadata.Artwork;
using TorrentFlow.Metadata.Caching;
using TorrentFlow.Metadata.Catalog;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Title;

public sealed record FranchiseQuery(string Title, int? Year, string? MediaType, string? Provider, string? ProviderId);

/// <summary>
/// One regular episode as the title page numbers it (<see cref="Season"/>, <see cref="Episode"/>), with its franchise
/// (absolute) number and the AniList entry that numbers it as its own episode <see cref="AniListEpisode"/>.
/// </summary>
public sealed record FranchiseEpisode(int Season, int Episode, int? Absolute, bool Aired, string? AniListId, int? AniListEpisode,
    string? Name = null, string? Overview = null, string? AirDate = null, string? AirStamp = null, int? RuntimeMin = null,
    string? StillUrl = null, int? ListedSeason = null, int? ListedEpisode = null);

/// <param name="Source">Whose numbering the page uses: tmdb or tvmaze when a show matched, anilist for the sequel chain alone or an entry's own Season 1.</param>
/// <param name="Banner">The entry's AniList banner, the art for episodes the show has no still for.</param>
/// <param name="Show">For a sequel entry numbered as its show: the show (first season) it belongs to; files land in its folder.</param>
/// <param name="Provisional">AniList cut the franchise walk short (a rate limit), or the show listing did not answer: the numbering may change on the next ask.</param>
/// <param name="Chained">Numbered as the show (the sequel chain or the show listing); false for an entry's own Season 1 kept for lack of one.</param>
/// <param name="Listing">The show listing the numbering was laid over ("tvmaze:1905", "tmdb:37854"), "none", or "unknown" when it did not answer.</param>
/// <param name="Uncertain">Absolute episodes whose AniList entry is not certain, where the listing and AniList count an episode differently.</param>
public sealed record FranchiseView(string Source, IReadOnlyList<FranchiseEpisode> Episodes, string? Banner, FranchiseShow? Show = null,
    bool Provisional = false, bool Chained = true, string Listing = "none", IReadOnlyList<EpisodeRange>? Uncertain = null)
{
    public IReadOnlyList<int> Seasons => Episodes.Select(e => e.Season).Distinct().Order().ToList();
    public IReadOnlyList<FranchiseEpisode> EpisodesOf(int season) => Episodes.Where(e => e.Season == season).ToList();

    /// <summary>An episode has aired once its air time (or, without one, its air day) has passed.</summary>
    public static bool HasAired(string? airDate, string? airStamp, DateTimeOffset now) =>
        DateTimeOffset.TryParse(airStamp, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at <= now :
        DateOnly.TryParse(airDate?.Length >= 10 ? airDate[..10] : airDate, CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) &&
        day <= DateOnly.FromDateTime(now.UtcDateTime);
}

/// <summary>The first-season AniList entry a sequel belongs to: its English catalog name (the show folder), year and id.</summary>
public sealed record FranchiseShow(string Title, int? Year, string AniListId, string? Format);

/// <summary>
/// The anime season shape, and the one answer to "which show, season and episode is this AniList entry's episode N".
/// Seasons follow the AniList sequel chain the way release groups number them: an entry marked as a new season
/// ("Season 2", "2nd Season", "Final Season", a roman numeral) starts the next season of the first entry's show, a split
/// cour ("Part 2", "Cour 2") continues the season before it, and an unmarked entry follows the show listing: a new season
/// where the listing starts one, the same season where it lists the episodes inside one. An unmarked entry no listing
/// speaks for is a show of its own (Bleach's Thousand-Year Blood War after TVmaze's Bleach), with its own numbering and
/// folder. The chain is laid over the one TMDB or TVmaze show it belongs to (pinned by the work's own provider id, or an
/// exact title and premiere match), whose numbers, names and stills are used when its seasons agree with the chain; when
/// the listing lumps a new season into an earlier one, the chain's numbers win and the listing's names and stills still
/// map by absolute number. A season start the listing places up to 2 episodes from the chain's is the listing's
/// (Mushoku Tensei counts an episode 0 AniList does not). A sequel entry's page shows its own episodes numbered as the
/// show does (Season 2 episode 1), never as a Season 1 of its own. With no confident chain an entry keeps its own
/// Season 1 and the banner as art. A listing that did not answer makes the view provisional: never read as "no listing".
/// </summary>
public sealed partial class AnimeFranchiseService(AniListClient anilist, TmdbClient tmdb, KeylessClients keyless, TimeProvider time,
    ILogger<AnimeFranchiseService> logger)
{
    private const int TimeoutMs = 5_000;
    private const int MaxSeasons = 40;
    /// <summary>A listing season start this close to the chain's is the same start.</summary>
    private const int Snap = 2;
    private readonly BoundedTtlCache<Lookup> _views = new(200, time);
    private readonly SingleFlight<Lookup> _flight = new();

    /// <param name="Failed">AniList (or the listing) gave no answer at all, so there is no view: never "this entry has no chain".</param>
    private sealed record Lookup(FranchiseView? View, bool Failed);

    /// <param name="Id">Which listing it is ("tvmaze:1905", "tmdb:37854"): a numbering keeps the listing it was laid over.</param>
    private sealed record Show(string Source, string Id, IReadOnlyList<FranchiseEpisode> Episodes);

    /// <summary>How an entry joins the entry before it: a new season, a cour of the same season, or a show of its own.</summary>
    private enum Join { Season, Cour, Cut }

    /// <summary>
    /// The chain laid over the listing: each entry's first absolute episode (AniList's offset, moved to the listing's own
    /// season start when the two are <see cref="Snap"/> or fewer apart), how it joins the entry before, and the absolute
    /// episodes whose entry such a move leaves uncertain. Entries with unknown offsets are left out.
    /// </summary>
    private sealed record Layout(int[] Starts, Join[] Joins, IReadOnlyList<EpisodeRange> Uncertain)
    {
        public int Count => Starts.Length;

        /// <summary>The first and last entry of the show an entry belongs to: the entries joined to it with no cut between.</summary>
        public (int First, int Last) ShowOf(int index)
        {
            var first = index;
            while (first > 0 && Joins[first] != Join.Cut) first--;
            var last = index;
            while (last + 1 < Count && Joins[last + 1] != Join.Cut) last++;
            return (first, last);
        }
    }

    public async Task<FranchiseView?> ResolveAsync(FranchiseQuery q, CancellationToken ct) => (await LookupAsync(q, ct).ConfigureAwait(false)).View;

    /// <summary>
    /// The view (<see cref="ResolveAsync"/>), and whether AniList or the listing failed to give one (a rate limit, an
    /// outage). A failure is never read as "this entry has no chain": its seasons are not known yet.
    /// </summary>
    public async Task<(FranchiseView? View, bool Failed)> LookupAsync(FranchiseQuery q, CancellationToken ct)
    {
        if (!AnimeIdentity.IsAnime(q.Provider, MediaTypes.Normalize(q.MediaType), q.ProviderId) || q.Provider == "anilist" && q.ProviderId is null)
            return (null, false);
        var key = string.Join('\u0000', tmdb.CredentialRevision, tmdb.HasKey, q.Provider, q.ProviderId, q.Title, q.Year);
        if (!_views.TryGet(key, out var found))
            found = await _flight.RunAsync(key, async () =>
            {
                FranchiseView? view = null;
                var partial = false;
                try { (view, partial) = await BuildAsync(q, CancellationToken.None).ConfigureAwait(false); }
                catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException)
                {
                    logger.LogDebug(e, "Anime season shape unavailable for {Title}", q.Title);
                    partial = true;
                }
                // A walk AniList cut short (a rate limit) or a listing that did not answer would number the seasons wrong for an
                // hour; it is asked again soon.
                if (partial && view is not null) view = view with { Provisional = true };
                var lookup = new Lookup(view, partial && view is null);
                // A background lookup the rate gate held back (ProviderPriority) is no answer from AniList: a page or grab asks itself.
                if (!(partial && ProviderPriority.IsBackground))
                    _views.Set(key, lookup, partial ? TimeSpan.FromMinutes(1) : view is { Source: not "anilist" } ? TimeSpan.FromHours(1) : TimeSpan.FromMinutes(5));
                return lookup;
            }, ct).ConfigureAwait(false);
        return (found.View, found.Failed);
    }

    private async Task<(FranchiseView? View, bool Partial)> BuildAsync(FranchiseQuery q, CancellationToken ct)
    {
        var franchise = q.Provider == "anilist"
            ? await anilist.GetFranchiseAsync(q.ProviderId!, ct).ConfigureAwait(false)
            : await FindFranchiseAsync(q, ct).ConfigureAwait(false);
        var (view, listingFailed) = await ViewAsync(q, franchise, ct).ConfigureAwait(false);
        return (view, franchise?.Partial == true || listingFailed);
    }

    private async Task<(FranchiseView? View, bool ListingFailed)> ViewAsync(FranchiseQuery q, AniListFranchise? franchise, CancellationToken ct)
    {
        if (franchise is null)
            return (q.Provider == "anilist" && await anilist.GetWorkByIdAsync(q.ProviderId!, ct).ConfigureAwait(false) is { IsSeries: true } work
                ? EntryPage(new([new(work, null)], 0), null, work.Metadata.BackdropUrl) : null, false);
        Show? show = null;
        var failed = false;
        if (franchise.Root.Offset is not null)
        {
            try { show = await ShowAsync(q, franchise.Root.Work.Metadata, ct).ConfigureAwait(false); }
            catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException)
            {
                // A listing that did not answer is not "no listing": the view is provisional and asked again soon.
                logger.LogDebug(e, "The show listing for {Title} did not answer", q.Title);
                failed = true;
            }
        }
        var listing = failed ? "unknown" : show?.Id ?? "none";
        var banner = franchise.Requested.Work.Metadata.BackdropUrl ?? franchise.Root.Work.Metadata.BackdropUrl;
        FranchiseView? Own() => q.Provider == "anilist" ? EntryPage(franchise, show, banner) with { Listing = listing } : null;
        if (franchise.Requested.Offset is null) return (Own(), failed);
        var layout = Lay(franchise, show);
        var (first, last) = layout.ShowOf(franchise.RequestedIndex);
        // The listing was matched to the franchise's first season: it speaks only for that show, never one cut off from it.
        var listed = first == 0 ? show : null;
        var numbered = Number(franchise, layout, first, last, listed, banner);
        var source = listed?.Source ?? "anilist";
        var uncertain = first == 0 ? layout.Uncertain : [];
        if (franchise.RequestedIndex == first)
            return (numbered is not null && (listed is not null || q.Provider == "anilist")
                ? new(source, numbered, banner, Listing: listing, Uncertain: uncertain) : Own(), failed);
        if (q.Provider != "anilist") return (null, failed);
        // A sequel's page lists its own episodes numbered as the show does, so one episode has one identity everywhere.
        var own = numbered?.Where(e => e.AniListId == franchise.Requested.Id).ToList();
        if (own is not { Count: > 0 }) return (Own(), failed);
        var root = franchise.Entries[first];
        // The show's catalog name, the one its own work is created with, so its seasons share one folder.
        return (new(source, own, banner, new(root.Work.Metadata.Title, root.Work.Metadata.Year, root.Id, root.Work.Format),
            Listing: listing, Uncertain: uncertain), failed);
    }

    /// <summary>
    /// Every episode of the show made of entries <paramref name="first"/> to <paramref name="last"/>, numbered as the show:
    /// the listing's own numbers when its seasons agree with the chain, else the chain's. Null when there is nothing to
    /// number (no listing and a single entry).
    /// </summary>
    private static List<FranchiseEpisode>? Number(AniListFranchise franchise, Layout layout, int first, int last, Show? show, string? banner)
    {
        var starts = Enumerable.Range(first + 1, last - first).Where(i => layout.Joins[i] == Join.Season).Select(i => layout.Starts[i]).ToHashSet();
        var continuations = Enumerable.Range(first + 1, last - first).Where(i => layout.Joins[i] == Join.Cour).Select(i => layout.Starts[i]).ToHashSet();
        if (show is not null)
        {
            var listed = ShowPage(franchise, layout, last, show, banner);
            var showStarts = listed.Where(e => e.Episode == 1 && e.Absolute is not null).Select(e => e.Absolute!.Value).ToHashSet();
            // The listing agrees when it starts a season everywhere the chain does and nowhere the chain continues one.
            if (starts.IsSubsetOf(showStarts) && !showStarts.Overlaps(continuations)) return listed;
            // The listing lumps a new season into an earlier one (TMDB's Frieren S1E29) or splits a cour into a season of
            // its own: the chain numbers, the listing still names. The listing's other season starts (inside a long entry,
            // or after everything AniList knows) stay, unless they sit next to an entry boundary the chain has decided.
            var boundaries = Enumerable.Range(1, last).Select(i => layout.Starts[i]).ToList();
            starts.UnionWith(showStarts.Where(s => s > 1 && !boundaries.Any(b => Math.Abs(b - s) <= Snap)));
            return listed.Select(e => e.Absolute is { } a ? Renumber(e, a, starts) : e).ToList();
        }
        if (last == first) return null;
        // The chain alone, counted from the show's own first entry (a show cut off from its franchise starts at 1).
        var origin = layout.Starts[first] - 1;
        var rebased = starts.Select(s => s - origin).ToHashSet();
        var episodes = new List<FranchiseEpisode>();
        for (var i = first; i <= last; i++)
        {
            var entry = franchise.Entries[i];
            var count = Math.Min(entry.Work.EpisodeCount ?? entry.Work.AiredEpisodeCount ?? 0, TitleExtrasService.AnimeEpisodePlaceholderCap);
            if (i < last) count = Math.Min(count, layout.Starts[i + 1] - layout.Starts[i]);
            var aired = entry.Work.AiredEpisodeCount ?? 0;
            for (var k = 1; k <= count; k++)
            {
                var absolute = layout.Starts[i] - origin + k - 1;
                episodes.Add(Renumber(new(1, k, absolute, k <= aired, entry.Id, k, StillUrl: entry.Work.Metadata.BackdropUrl ?? banner),
                    absolute, rebased));
            }
        }
        return episodes;
    }

    private static FranchiseEpisode Renumber(FranchiseEpisode e, int absolute, HashSet<int> starts)
    {
        var start = starts.Where(s => s <= absolute).DefaultIfEmpty(1).Max();
        return e with { Season = 1 + starts.Count(s => s > 1 && s <= absolute), Episode = absolute - start + 1 };
    }

    /// <summary>
    /// Lays the chain over the listing (<see cref="Layout"/>). An entry marked as a new season or a cour joins as its titles
    /// say; an unmarked one joins as the listing says (a season start within <see cref="Snap"/> episodes: a new season;
    /// listed inside a season: a cour) and, where no listing speaks for it, is cut off as a show of its own.
    /// </summary>
    private static Layout Lay(AniListFranchise franchise, Show? show)
    {
        var count = franchise.Entries.TakeWhile(e => e.Offset is not null).Count();
        var starts = new int[count];
        var joins = new Join[count];
        var uncertain = new List<EpisodeRange>();
        var listed = show?.Episodes.Select((e, i) => (e.Episode, Absolute: i + 1)).Where(x => x.Episode == 1).Select(x => x.Absolute).ToList() ?? [];
        var shift = 0;
        var agreed = 1;
        var cut = false;
        for (var i = 0; i < count; i++)
        {
            var entry = franchise.Entries[i];
            var start = entry.Offset!.Value + 1 + shift;
            starts[i] = start;
            if (i == 0) continue;
            var mark = SeasonMark(entry.Work.Metadata, franchise.Entries[i - 1].Work.Metadata);
            // The listing speaks only for episodes it lists, and only for the show it was matched to (nothing after a cut).
            var covered = show is not null && !cut && start <= show.Episodes.Count;
            int? near = covered ? listed.Where(s => s > starts[i - 1] && Math.Abs(s - start) <= Snap).OrderBy(s => Math.Abs(s - start))
                .Cast<int?>().FirstOrDefault() : null;
            var join = mark switch
            {
                false => Join.Cour,
                true => Join.Season,
                null => !covered ? Join.Cut : near is not null ? Join.Season : Join.Cour,
            };
            if (join == Join.Season && near is { } listedStart)
            {
                if (listedStart != start)
                {
                    // AniList and the listing count an episode differently somewhere since the last season start they agree
                    // on (Mushoku Tensei II's episode 0): the season starts where the listing starts it, the later entries
                    // move with it, and which entry the episodes in between belong to is not certain.
                    uncertain.Add(new(agreed, listedStart - 1));
                    shift += listedStart - start;
                    start = listedStart;
                    starts[i] = start;
                }
                agreed = start;
            }
            if (join == Join.Cut) cut = true;
            joins[i] = join;
        }
        return new(starts, joins, uncertain);
    }

    /// <summary>The entry and its own episode number for an absolute episode of the show made of entries 0 to <paramref name="last"/>.</summary>
    private static (AniListFranchiseEntry Entry, int Episode)? Locate(AniListFranchise franchise, Layout layout, int last, int absolute)
    {
        for (var i = Math.Min(last, layout.Count - 1); i >= 0; i--)
        {
            if (absolute < layout.Starts[i]) continue;
            var episode = absolute - layout.Starts[i] + 1;
            return franchise.Entries[i].Work.EpisodeCount is { } count && episode > count ? null : (franchise.Entries[i], episode);
        }
        return null;
    }

    /// <summary>How many of the show's episodes AniList says have aired, counted along the laid-out starts.</summary>
    private static int AiredThrough(AniListFranchise franchise, Layout layout, int last) =>
        Enumerable.Range(0, Math.Min(last + 1, layout.Count)).Select(i => layout.Starts[i] - 1 + (franchise.Entries[i].Work.AiredEpisodeCount ?? 0))
            .DefaultIfEmpty(0).Max();

    /// <summary>
    /// What an entry's titles say: true for a new season ("Season 2", "2nd Season", "Final Season", a roman numeral
    /// like "II" or "XIV"), false for a split cour ("Cour 2", "2nd Cour", or "Part 2" / "2nd Part" on the prequel's own
    /// title, like "Final Season Part 2"), null when they say neither. A numbered franchise part ("JoJo Part 5") whose
    /// base title differs from its prequel is not a cour.
    /// </summary>
    internal static bool? SeasonMark(TorrentFlow.Core.Contracts.Metadata.MediaMetadata metadata, TorrentFlow.Core.Contracts.Metadata.MediaMetadata? prequel)
    {
        var titles = Titles(metadata);
        if (titles.Any(t => Cour().IsMatch(t))) return false;
        if (prequel is not null)
        {
            // Both titles lose their part marker first, so "Final Season Part 2" continues "Final Season Part 1" (BEASTARS)
            // as it continues a plain "Final Season".
            var bases = Titles(prequel).Select(t => ArtworkMatching.NormalizeTitleForMatch(AnyPart().Replace(t, " ")))
                .Where(n => n.Length > 0).ToHashSet();
            if (titles.Any(t => Part().IsMatch(t) && bases.Contains(ArtworkMatching.NormalizeTitleForMatch(AnyPart().Replace(t, " ")))))
                return false;
        }
        if (titles.Any(t => NewSeason().IsMatch(t) || HasRomanSequel(t))) return true;
        return null;
    }

    private static List<string> Titles(TorrentFlow.Core.Contracts.Metadata.MediaMetadata metadata) =>
        WorkNames.Of(metadata).All.Where(n => n.Kind != WorkNameKind.Native).Select(n => n.Text).Prepend(metadata.Title).Distinct().ToList();

    /// <summary>A standalone uppercase roman numeral of 2 or more ending the title or its main part ("Overlord IV", "Mushoku Tensei II: ...").</summary>
    private static bool HasRomanSequel(string title) =>
        Roman().Matches(title).Any(m => m.Value != "X" && RomanValue(m.Value) >= 2);

    private static int RomanValue(string roman)
    {
        static int Of(char c) => c switch { 'I' => 1, 'V' => 5, 'X' => 10, _ => 0 };
        var total = 0;
        for (var i = 0; i < roman.Length; i++)
            total += i + 1 < roman.Length && Of(roman[i]) < Of(roman[i + 1]) ? -Of(roman[i]) : Of(roman[i]);
        return total;
    }

    [System.Text.RegularExpressions.GeneratedRegex(@"\bCour\s*(?:\d{1,2}|II|III|IV)\b|\b(?:2nd|3rd|[4-9]th|second|third)\s+(?:Cour|Half)\b",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant, 1000)]
    private static partial System.Text.RegularExpressions.Regex Cour();

    [System.Text.RegularExpressions.GeneratedRegex(@"\bPart\s*(?:[2-9]|\d{2}|II|III|IV)\b|\b(?:2nd|3rd|[4-9]th|second|third)\s+Part\b",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant, 1000)]
    private static partial System.Text.RegularExpressions.Regex Part();

    /// <summary>Any part marker, the first included ("Part 1", "1st Part"), stripped before two titles are compared.</summary>
    [System.Text.RegularExpressions.GeneratedRegex(@"\bPart\s*(?:\d{1,2}|I{1,3}|IV)\b|\b(?:1st|2nd|3rd|[4-9]th|first|second|third)\s+Part\b",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant, 1000)]
    private static partial System.Text.RegularExpressions.Regex AnyPart();

    [System.Text.RegularExpressions.GeneratedRegex(@"\bSeason\s*\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)\s+Season\b|\bFinal\s+Season\b|\bS\d{1,2}\b",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant, 1000)]
    private static partial System.Text.RegularExpressions.Regex NewSeason();

    [System.Text.RegularExpressions.GeneratedRegex(@"(?<=\s)X{0,3}(?:IX|IV|V?I{0,3})(?=\s*[:\-(]|\s*$)",
        System.Text.RegularExpressions.RegexOptions.CultureInvariant, 1000)]
    private static partial System.Text.RegularExpressions.Regex Roman();

    private static List<FranchiseEpisode> ShowPage(AniListFranchise franchise, Layout layout, int last, Show show, string? banner)
    {
        var airedThrough = AiredThrough(franchise, layout, last);
        var episodes = new List<FranchiseEpisode>(show.Episodes.Count);
        foreach (var (e, absolute) in show.Episodes.Select((e, i) => (e, i + 1)))
        {
            var at = Locate(franchise, layout, last, absolute);
            episodes.Add(e with { Absolute = absolute, Aired = e.Aired || e.AirDate is null && absolute <= airedThrough,
                AniListId = at?.Entry.Id, AniListEpisode = at?.Episode, StillUrl = e.StillUrl ?? banner, ListedSeason = e.Season,
                ListedEpisode = e.Episode });
        }
        // AniList can know an aired cour of this show the listing has not added yet: it continues the show's last season.
        if (show.Episodes.Count > 0)
        {
            var tail = show.Episodes[^1];
            for (var absolute = show.Episodes.Count + 1; absolute <= airedThrough &&
                absolute <= TitleExtrasService.AnimeEpisodePlaceholderCap; absolute++)
            {
                var at = Locate(franchise, layout, last, absolute);
                episodes.Add(new(tail.Season, tail.Episode + absolute - show.Episodes.Count, absolute, true, at?.Entry.Id, at?.Episode,
                    StillUrl: banner, ListedSeason: tail.Season, ListedEpisode: tail.Episode + absolute - show.Episodes.Count));
            }
        }
        return episodes;
    }

    private static FranchiseView EntryPage(AniListFranchise franchise, Show? show, string? banner)
    {
        var entry = franchise.Requested;
        var count = Math.Min(entry.Work.EpisodeCount ?? entry.Work.AiredEpisodeCount ?? 0, TitleExtrasService.AnimeEpisodePlaceholderCap);
        var aired = entry.Work.AiredEpisodeCount ?? 0;
        var episodes = Enumerable.Range(1, Math.Max(0, count)).Select(i =>
        {
            int? absolute = entry.Offset is { } offset ? offset + i : null;
            var meta = absolute is { } a && show is not null && a <= show.Episodes.Count ? show.Episodes[a - 1] : null;
            return new FranchiseEpisode(1, i, absolute, i <= aired || meta?.Aired == true, entry.Id, i, meta?.Name, meta?.Overview,
                meta?.AirDate, meta?.AirStamp, meta?.RuntimeMin, meta?.StillUrl ?? banner);
        }).ToList();
        return new("anilist", episodes, banner, Chained: false);
    }

    /// <summary>A non-AniList anime work's franchise: the one AniList first season with exactly this title and year.</summary>
    private async Task<AniListFranchise?> FindFranchiseAsync(FranchiseQuery q, CancellationToken ct)
    {
        var wanted = ArtworkMatching.NormalizeTitleForMatch(q.Title);
        if (wanted.Length == 0) return null;
        var hits = (await anilist.SearchWorksAsync(q.Title, 8, ct).ConfigureAwait(false))
            .Where(w => w.IsSeries && (q.Year is null || w.Metadata.Year == q.Year) &&
                (w.Metadata.Aliases ?? []).Any(a => ArtworkMatching.NormalizeTitleForMatch(a) == wanted))
            .DistinctBy(w => w.Metadata.ExternalId).ToList();
        if (hits.Count != 1) return null;
        return await anilist.GetFranchiseAsync(hits[0].Metadata.ExternalId, ct).ConfigureAwait(false) is { RequestedIndex: 0 } franchise
            ? franchise : null;
    }

    /// <summary>
    /// The show listing the chain is laid over: the work's own TMDB or TVmaze show, else the one show matching the first
    /// season's title and premiere. Null when there is none; throws when a listing site did not answer, so a busy site is
    /// never read as "no listing".
    /// </summary>
    private async Task<Show?> ShowAsync(FranchiseQuery q, TorrentFlow.Core.Contracts.Metadata.MediaMetadata root, CancellationToken ct)
    {
        if (q.Provider == "tmdb" && int.TryParse(q.ProviderId, NumberStyles.None, CultureInfo.InvariantCulture, out var tmdbId))
            return tmdb.HasKey ? await TmdbShowAsync(tmdbId, null, ct).ConfigureAwait(false) : null;
        if (q.Provider == "tvmaze" && int.TryParse(q.ProviderId, NumberStyles.None, CultureInfo.InvariantCulture, out var tvmazeId))
            return await TvmazeShowAsync(tvmazeId, ct).ConfigureAwait(false);
        var names = (root.Aliases ?? []).Prepend(root.Title).Select(n => Apostrophes.Normalize(n).Trim())
            .Where(n => ArtworkMatching.NormalizeTitleForMatch(n).Length > 0)
            .DistinctBy(ArtworkMatching.NormalizeTitleForMatch).ToList();
        if (names.Count == 0) return null;
        if (tmdb.HasKey && await MatchTmdbAsync(names, root, ct).ConfigureAwait(false) is { } match &&
            await TmdbShowAsync(match.Id, match.Detail, ct).ConfigureAwait(false) is { } fromTmdb) return fromTmdb;
        return await MatchTvmazeAsync(names, root, ct).ConfigureAwait(false) is { } showId
            ? await TvmazeShowAsync(showId, ct).ConfigureAwait(false) : null;
    }

    private async Task<(int Id, JsonElement Detail)?> MatchTmdbAsync(IReadOnlyList<string> names, TorrentFlow.Core.Contracts.Metadata.MediaMetadata root,
        CancellationToken ct)
    {
        var keys = names.Select(ArtworkMatching.NormalizeTitleForMatch).ToHashSet(StringComparer.Ordinal);
        foreach (var name in names.Take(2))
        {
            var hits = (await tmdb.SearchCandidatesAsync("tv", name, root.Year, 10, TimeoutMs, ct, strict: true).ConfigureAwait(false))
                .Where(c => keys.Contains(ArtworkMatching.NormalizeTitleForMatch(c.Title)) && c.Year == root.Year)
                .DistinctBy(c => c.Id).ToList();
            if (hits.Count > 1) return null;
            if (hits.Count == 0) continue;
            if (await tmdb.FetchDetailAsync("tv", hits[0].Id, TimeoutMs, ct, strict: true).ConfigureAwait(false) is not { } detail) return null;
            var animation = detail.TryGetProperty("genres", out var genres) && genres.ValueKind == JsonValueKind.Array &&
                genres.EnumerateArray().Any(g => TmdbClient.Int(g, "id") == 16);
            return animation && SameStart(TmdbClient.Str(detail, "first_air_date"), root) ? (hits[0].Id, detail) : null;
        }
        return null;
    }

    private async Task<int?> MatchTvmazeAsync(IReadOnlyList<string> names, TorrentFlow.Core.Contracts.Metadata.MediaMetadata root, CancellationToken ct)
    {
        var keys = names.Select(ArtworkMatching.NormalizeTitleForMatch).ToHashSet(StringComparer.Ordinal);
        foreach (var name in names.Take(2))
        {
            var hits = (await keyless.SearchTvmazeAsync(name, 10, TimeoutMs, ct, strict: true).ConfigureAwait(false))
                .Where(s => s.Type == "Animation" && keys.Contains(ArtworkMatching.NormalizeTitleForMatch(s.Title)) && SameStart(s.Premiered, root))
                .DistinctBy(s => s.Id).ToList();
            if (hits.Count > 1) return null;
            if (hits.Count == 1) return hits[0].Id;
        }
        return null;
    }

    /// <summary>The show premiered when the first AniList season did: the same year, or within a week across New Year.</summary>
    private static bool SameStart(string? premiered, TorrentFlow.Core.Contracts.Metadata.MediaMetadata root)
    {
        if (!DateOnly.TryParse(premiered?.Length >= 10 ? premiered[..10] : premiered, CultureInfo.InvariantCulture, DateTimeStyles.None, out var day))
            return false;
        if (day.Year == root.Year) return true;
        return DateOnly.TryParse(root.ReleaseDate, CultureInfo.InvariantCulture, DateTimeStyles.None, out var start) &&
            Math.Abs(day.DayNumber - start.DayNumber) <= 7;
    }

    private async Task<Show?> TmdbShowAsync(int id, JsonElement? known, CancellationToken ct)
    {
        if ((known ?? await tmdb.FetchDetailAsync("tv", id, TimeoutMs, ct, strict: true).ConfigureAwait(false)) is not { } detail ||
            !detail.TryGetProperty("seasons", out var seasons) || seasons.ValueKind != JsonValueKind.Array) return null;
        var numbers = seasons.EnumerateArray().Select(s => TmdbClient.Int(s, "season_number")).OfType<int>()
            .Where(n => n >= 1).Distinct().Order().Take(MaxSeasons).ToList();
        var now = time.GetUtcNow();
        var episodes = new List<FranchiseEpisode>();
        foreach (var number in numbers)
        {
            // A season that cannot be read would shift every later absolute number, so the show is not used.
            if (await tmdb.FetchSeasonAsync(id, number, TimeoutMs, ct, strict: true).ConfigureAwait(false) is not { } season ||
                !season.TryGetProperty("episodes", out var rows) || rows.ValueKind != JsonValueKind.Array) return null;
            foreach (var row in rows.EnumerateArray())
            {
                if (TmdbClient.Int(row, "episode_number") is not { } episode || episode < 1) continue;
                var airDate = CatalogText.ParseReleaseDate(TmdbClient.Str(row, "air_date"));
                episodes.Add(new(number, episode, null, FranchiseView.HasAired(airDate, null, now), null, null,
                    TmdbClient.Str(row, "name"), TmdbClient.Str(row, "overview").OrEmpty(null), airDate, null,
                    TmdbClient.Int(row, "runtime"), tmdb.ImageUrl(TmdbClient.Str(row, "still_path"), Artwork.ArtRole.Thumb)));
            }
        }
        return Regular("tmdb", id, episodes);
    }

    private async Task<Show?> TvmazeShowAsync(int id, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var episodes = (await keyless.GetTvmazeEpisodesAsync(id, TimeoutMs, ct, strict: true).ConfigureAwait(false))
            .Select(e => new FranchiseEpisode(e.Season, e.Episode, null, FranchiseView.HasAired(e.AirDate, e.AirStamp, now), null, null,
                e.Name, e.Overview, e.AirDate, e.AirStamp, e.RuntimeMin, e.StillUrl)).ToList();
        return Regular("tvmaze", id, episodes);
    }

    /// <summary>Regular episodes only (specials have no place in the absolute order), each season and episode once, in order.</summary>
    private static Show? Regular(string source, int id, IEnumerable<FranchiseEpisode> episodes)
    {
        var regular = episodes.Where(e => e.Season >= 1 && e.Episode >= 1).DistinctBy(e => (e.Season, e.Episode))
            .OrderBy(e => e.Season).ThenBy(e => e.Episode).ToList();
        return regular.Count == 0 ? null : new(source, $"{source}:{id.ToString(CultureInfo.InvariantCulture)}", regular);
    }
}
