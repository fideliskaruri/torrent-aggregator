using System.Globalization;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Text;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Metadata.Artwork;
using TorrentFlow.Metadata.Catalog;

namespace TorrentFlow.Metadata.Browse;

/// <summary>src/lib/browse/types.ts RailItem: the always-present fields are serialized even when null.</summary>
public record RailItem
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Subtitle { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? PosterUrl { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? BackdropUrl { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Availability { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? InfoHash { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? FilePath { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? WatchListItemId { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? MediaType { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public int? Season { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public int? Episode { get; init; }
    /// <summary>The title route key the card opens; null when nothing names the work yet.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? WorkKey { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public int? Year { get; init; }
    /// <summary>The title at a metadata provider when the catalog knows it, so the title page can request it.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Provider { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? ProviderId { get; init; }
}

/// <summary>Downloaded cards also name the catalog work they belong to (explicit nulls).</summary>
public sealed record WorkRailItem : RailItem
{
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? WorkId { get; init; }
}

/// <summary>discovery.ts toRailItem: a catalog card also carries overview / releaseDate / theatrical gate explicitly.</summary>
public sealed record CatalogRailItem : RailItem
{
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Overview { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? ReleaseDate { get; init; }
    public bool InTheatricalWindow { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? NextHomeReleaseAt { get; init; }
}

public sealed record Rail(string Id, string Title, IReadOnlyList<object> Items)
{
    [JsonIgnore] public IEnumerable<RailItem> Cards => Items.Cast<RailItem>();
    /// <summary>films | series | anime for a catalog rail (HomeRails); absent on personal rails.</summary>
    public string? Kind { get; init; }
    /// <summary>The genre a genre rail lists, so its heading can link to that genre's page.</summary>
    public string? Genre { get; init; }
}

/// <summary>
/// One home view: <see cref="View"/> is all | films | series | anime, <see cref="Genre"/> is set on a genre page, and
/// <see cref="Genres"/> lists the type's genres for its chips (empty on All).
/// </summary>
public sealed record BrowsePayload(IReadOnlyList<Rail> Rails, string GeneratedAt)
{
    public string View { get; init; } = HomeRails.AllView;
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Genre { get; init; }
    public IReadOnlyList<HomeGenre> Genres { get; init; } = [];
}

/// <summary>seed.ts CatalogSeed.</summary>
public sealed record CatalogSeed(string Title, string? MediaType);

/// <summary>
/// Home: on All, the Downloaded rail first (one card per work), then Because and the featured catalog rails; on a type
/// view that type's featured and genre rails; on a genre page that one rail. No work is shown twice and empty rails are
/// dropped.
/// </summary>
public sealed partial class BrowseService(
    IDbContextFactory<TorrentFlowDbContext> dbFactory,
    CatalogService catalog,
    HomeReleaseCache homeReleases,
    ArtworkResolver artwork,
    ITorrentPresenceProbe presence,
    LocalFilePresenceCache files,
    TimeProvider time,
    ILogger<BrowseService> logger)
{
    public const int DiscoveryRailSize = 24;
    /// <summary>A genre page shows the top of its whole rail.</summary>
    public const int GenrePageSize = 48;
    /// <summary>Only films released this recently can still be in cinemas, so only they need a home-release check.</summary>
    public const int HomeReleaseCheckDays = 180;
    public const int RailArtworkBudgetMs = 8_000;
    public const string BecauseRailId = "because-you-are-watching";

    [GeneratedRegex(@"(^|[^a-z])(tv|anime|series|show|episode|season)([^a-z]|$)")] private static partial Regex SeriesGroup();
    [GeneratedRegex(@"(^|[^a-z])(movie|film|feature)([^a-z]|$)")] private static partial Regex MovieGroup();

    public Task<BrowsePayload> BuildAsync(string userId, CancellationToken ct = default) => BuildAsync(userId, HomeView.All, ct);

    public async Task<BrowsePayload> BuildAsync(string userId, HomeView view, CancellationToken ct = default)
    {
        var all = view.Type == HomeRails.AllView;
        var libraryTask = all ? BuildYourLibraryAsync(userId, ct) : Task.FromResult<Rail?>(null);
        var discoveryTask = BuildDiscoveryRailsAsync(userId, view, ct);
        var library = await libraryTask.ConfigureAwait(false);
        var discovery = await discoveryTask.ConfigureAwait(false);

        var personal = OrganizePersonalRails(library);
        var size = view.GenreRail is null ? DiscoveryRailSize : GenrePageSize;
        // Rails hold more than they show and a rail only claims the cards it shows, so a later rail that overlaps an
        // earlier one still fills from its own spare rows.
        var rails = DistinctAcrossRails(personal.Concat(discovery), rail => rail.Kind is null ? int.MaxValue : size);
        return new BrowsePayload(rails, time.GetUtcNow().UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture))
        {
            View = view.Type,
            Genre = view.GenreRail?.Genre?.Id,
            Genres = all ? [] : HomeRails.GenresOf(view.Type),
        };
    }

    public const string YourLibraryRailId = "your-library";

    /// <summary>
    /// The downloaded rail's heading. Its id predates the name: in the UI "Library" is the list of titles you
    /// add and track, so a rail of files on disk calling itself "Your library" said a downloaded film was in
    /// the Library while its own page offered "Add to library".
    /// </summary>
    public const string DownloadedRailTitle = "Downloaded";

    /// <summary>The personal rail: every ready work. <see cref="DistinctAcrossRails"/> keeps each work once.</summary>
    public static List<Rail> OrganizePersonalRails(Rail? library)
    {
        var rails = new List<Rail>();
        if (library is { Items.Count: > 0 }) rails.Add(new Rail(YourLibraryRailId, DownloadedRailTitle, library.Items));
        return rails;
    }

    /// <summary>
    /// One seen set across the home page, in rail order (personal, because, then the catalog rails): the first card for
    /// a work stays and every later one is dropped, then rails left empty go. Cards are the same work when they share a
    /// provider id, a normalised title + year + type, or a work key (the second guard). The title key applies even
    /// when both cards have ids, since ids from two providers cannot be compared. <paramref name="shown"/> caps each
    /// rail: once it is full it stops claiming, so cards it will not show stay free for the rails below.
    /// </summary>
    public static List<Rail> DistinctAcrossRails(IEnumerable<Rail> rails, Func<Rail, int>? shown = null)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var distinct = new List<Rail>();
        foreach (var rail in rails)
        {
            var cap = shown?.Invoke(rail) ?? int.MaxValue;
            var items = new List<object>();
            foreach (var card in rail.Cards)
            {
                if (items.Count >= cap) break;
                var (check, claim) = SameWorkKeys(card);
                if (check.Any(seen.Contains)) continue;
                seen.UnionWith(claim);
                items.Add(card);
            }
            if (items.Count > 0) distinct.Add(rail with { Items = items });
        }
        return distinct;
    }

    /// <summary>The keys a card is checked against, and the keys it claims once shown.</summary>
    private static (string[] Check, string[] Claim) SameWorkKeys(RailItem card)
    {
        var group = MediaGroupOf(card.MediaType) switch
        {
            "unknown" => card.Season is not null || card.Episode is not null ? "series" : "movie",
            var known => known,
        };
        var exact = new List<string>();
        if (NonEmpty(card.Provider) is { } provider && NonEmpty(card.ProviderId) is { } providerId) exact.Add($"id:{provider}:{group}:{providerId}");
        if (NonEmpty(card.WorkKey) is { } workKey) exact.Add($"key:{workKey}");
        if (card is WorkRailItem { WorkId: { Length: > 0 } workId }) exact.Add($"work:{workId}");
        if (NonEmpty(card.WatchListItemId) is { } watchId) exact.Add($"watch:{watchId}");
        var name = card.Title == WorkCollapse.UnknownWorkTitle ? "" : CatalogText.NormalizeForKey(card.Title);
        if (name.Length == 0) return ([.. exact], [.. exact]);
        if (group == "series") return ([.. exact, $"series:{name}"], [.. exact, $"series:{name}"]);
        // A yearless film cannot contradict a dated one (WorkKeySlug.Matches), so each matches the other.
        var yearless = $"film:{name}:";
        return card.Year is { } year and not 0
            ? ([.. exact, $"film:{name}:{year}", yearless], [.. exact, $"film:{name}:{year}", $"film:{name}:*"])
            : ([.. exact, yearless, $"film:{name}:*"], [.. exact, yearless]);
    }

    /// <summary>
    /// rails.ts engineAvailability: null when the torrent is gone. A completed row is ready only when its file is on
    /// disk or the live engine holds it; a partial one is warm only while live.
    /// </summary>
    public static string? EngineAvailability(EngineTorrent? t, Func<string, TorrentPresence> presence, Func<string, LocalFilePresence>? filePresence = null)
    {
        if (t is null || t.Status == "removed") return null;
        var live = presence(t.Hash);
        if (t.Progress == 1)
            return (filePresence?.Invoke(t.Hash) ?? LocalFilePresence.Unknown) == LocalFilePresence.Present || live == TorrentPresence.Present ? "ready" : null;
        return t.Progress > 0 && t.Status != "error" && live == TorrentPresence.Present ? "warm" : null;
    }

    // ------------------------------------------------------------------ Downloaded

    private sealed record AcquisitionWork(string? InfoHash, string? WorkId, string WorkKey, string? CanonicalTitle, string? MediaType);

    private async Task<Rail?> BuildYourLibraryAsync(string userId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var rows = await db.EngineTorrents.AsNoTracking()
            .Where(t => t.UserId == userId && t.Progress == 1 && t.Status != "removed" && t.Status != "error")
            .OrderByDescending(t => t.CreatedAt).Take(120).ToListAsync(ct).ConfigureAwait(false);
        var filePresence = files.Lookup(rows);
        var torrents = rows.Where(t => LibraryTorrentCanSurface(t)
            && EngineAvailability(t, h => presence.Presence(userId, h), filePresence) == "ready").ToList();
        if (torrents.Count == 0) return null;

        var hashes = torrents.Select(t => t.Hash.ToLowerInvariant()).ToList();
        var acquisitions = await (from a in db.AcquisitionTargets.AsNoTracking()
                                  join w in db.Works.AsNoTracking() on a.WorkId equals w.Id into joined
                                  from w in joined.DefaultIfEmpty()
                                  where a.UserId == userId && a.InfoHash != null && hashes.Contains(a.InfoHash.ToLower())
                                  orderby a.UpdatedAt descending
                                  select new AcquisitionWork(a.InfoHash, a.WorkId, a.WorkKey, w == null ? null : w.CanonicalTitle, w == null ? null : w.MediaType))
            .ToListAsync(ct).ConfigureAwait(false);
        var workByHash = new Dictionary<string, AcquisitionWork>(StringComparer.Ordinal);
        var canonicalByWorkKey = new Dictionary<string, AcquisitionWork>(StringComparer.Ordinal);
        foreach (var work in acquisitions)
        {
            if (!string.IsNullOrEmpty(work.InfoHash)) workByHash.TryAdd(work.InfoHash.ToLowerInvariant(), work);
            if (!string.IsNullOrEmpty(work.WorkId)) canonicalByWorkKey.TryAdd(work.WorkKey, work);
        }

        // Recently added first: a work sorts by its newest release, so a fresh episode lifts the whole show.
        var cards = WorkCollapse.CollapseReleasesByWork(torrents.Select(t =>
        {
            var acquired = workByHash.GetValueOrDefault(t.Hash.ToLowerInvariant());
            return new CollapsibleRelease<EngineTorrent>(t.Name, t.UpdatedAt, t)
            {
                Prefer = LibraryRepresentativePreference(t.Name),
                IdentityKey = acquired?.WorkId,
                WorkKey = acquired?.WorkKey,
                WorkTitle = acquired?.CanonicalTitle,
            };
        })).OrderByDescending(w => w.Members.Max(t => t.CreatedAt)).Take(30).ToList();
        var art = await ResolveArtworkForReleasesAsync(cards.Select(c => c.Name).ToList()).ConfigureAwait(false);

        var items = new List<object>();
        foreach (var (work, i) in cards.Select((c, i) => (c, i)))
        {
            var torrent = work.Value;
            var canonical = canonicalByWorkKey.GetValueOrDefault(work.WorkKey) ?? workByHash.GetValueOrDefault(torrent.Hash.ToLowerInvariant());
            var mediaType = !string.IsNullOrEmpty(canonical?.MediaType) && !canonical.MediaType.Equals("unknown", StringComparison.OrdinalIgnoreCase)
                ? canonical.MediaType : work.Members.Any(t => ReleaseNames.WorkIdentity(t.Name).IsSeries) ? "series" : "movie";
            items.Add(new WorkRailItem
            {
                Id = torrent.Id,
                WorkId = canonical?.WorkId ?? work.Members.Select(t => t.WorkId).FirstOrDefault(id => !string.IsNullOrEmpty(id)),
                WorkKey = canonical?.WorkKey,
                Title = work.Title,
                Subtitle = LibrarySubtitle(mediaType, work.Members),
                PosterUrl = art[i].PosterUrl,
                BackdropUrl = art[i].BackdropUrl,
                Availability = "ready",
                InfoHash = torrent.Hash,
                MediaType = mediaType,
                Year = ReleaseNames.WorkIdentity(torrent.Name).Year,
            });
        }
        return new Rail(YourLibraryRailId, DownloadedRailTitle, items);
    }

    public static bool LibraryTorrentCanSurface(EngineTorrent t) => t.Progress >= 1 && t.Status != "removed" && t.Status != "error";

    /// <summary>A season pack represents the work over single episodes.</summary>
    public static bool LibraryRepresentativePreference(string name) => ReleaseNames.ParseEpisode(name).IsSeasonPack;

    [GeneratedRegex(@"\b(2160p|1080p|720p|576p|480p|4k)\b", RegexOptions.IgnoreCase)] private static partial Regex ResolutionPattern();

    /// <summary>"Series · 9 episodes" / "Movie · 1080p": what the user owns, never how many files it came in.</summary>
    public static string LibrarySubtitle(string? mediaType, IReadOnlyList<EngineTorrent> releases)
    {
        if (MediaGroupOf(mediaType) == "series")
        {
            var count = DownloadedEpisodeCount(releases);
            return count switch { 0 => "Series", 1 => "Series · 1 episode", _ => $"Series · {count} episodes" };
        }
        var resolution = releases.Select(r => ResolutionPattern().Match(r.Name)).Where(m => m.Success)
            .Select(m => m.Value.Equals("4k", StringComparison.OrdinalIgnoreCase) ? "2160p" : m.Value.ToLowerInvariant())
            .OrderByDescending(v => int.Parse(v[..^1], CultureInfo.InvariantCulture)).FirstOrDefault();
        return resolution is null ? "Movie" : $"Movie · {resolution}";
    }

    /// <summary>
    /// Distinct season/episode pairs across the work's video files. A video whose name does not parse as one episode
    /// still counts once, by file name; a release with no recorded files falls back to its own name.
    /// </summary>
    public static int DownloadedEpisodeCount(IReadOnlyList<EngineTorrent> releases)
    {
        var episodes = new HashSet<string>(StringComparer.Ordinal);
        foreach (var release in releases)
        {
            var fallbackSeason = ReleaseNames.ParseEpisode(release.Name).Season;
            var videos = LocalFiles.RecordedFilePaths(release.VerifiedFilesJson).Where(ReleaseNames.IsSupportedVideoFileName)
                .Select(p => Path.GetFileNameWithoutExtension(p.Replace('\\', '/').Split('/')[^1])).ToList();
            if (videos.Count == 0)
            {
                var parsed = ReleaseNames.ParseEpisode(release.Name);
                if (parsed.Episode is int single) episodes.Add($"{parsed.Season ?? fallbackSeason}x{single}");
                continue;
            }
            foreach (var name in videos)
            {
                var parsed = ReleaseNames.ParseEpisode(name);
                episodes.Add(parsed.Episode is int episode ? $"{parsed.Season ?? fallbackSeason}x{episode}" : $"file:{name.ToLowerInvariant()}");
            }
        }
        return episodes.Count;
    }

    // ------------------------------------------------------------------ artwork

    /// <summary>artwork.ts resolveArtworkForReleases: one lookup per distinct work, 8 s budget, order-preserving, never throws.</summary>
    public async Task<IReadOnlyList<ArtworkResult>> ResolveArtworkForReleasesAsync(IReadOnlyList<string> names, int budgetMs = RailArtworkBudgetMs)
    {
        var none = names.Select(_ => ArtworkResult.None).ToList();
        if (names.Count == 0) return none;
        var slotByKey = new Dictionary<string, int>(StringComparer.Ordinal);
        var queries = new List<ArtworkQuery>();
        var slots = new List<int>();
        foreach (var name in names)
        {
            var identity = ReleaseNames.WorkIdentity(name);
            var title = identity.Name.Length > 0 ? identity.Name : name;
            var key = identity.Key.Length > 0 ? identity.Key : title.ToLowerInvariant();
            if (!slotByKey.TryGetValue(key, out var slot))
            {
                slot = queries.Count;
                slotByKey[key] = slot;
                queries.Add(new ArtworkQuery(title, identity.Year, MediaTypes.Normalize(ReleaseNames.DetectContentKind(name))));
            }
            slots.Add(slot);
        }
        try
        {
            var batch = artwork.ResolveBatchAsync(queries);
            if (await Task.WhenAny(batch, Task.Delay(TimeSpan.FromMilliseconds(budgetMs), time)).ConfigureAwait(false) != batch || !batch.IsCompletedSuccessfully)
                return none;
            return slots.Select(s => s < batch.Result.Count ? batch.Result[s] : ArtworkResult.None).ToList();
        }
        catch (Exception e) when (e is not OutOfMemoryException) { return none; }
    }

    // ------------------------------------------------------------------ discovery

    /// <summary>discovery.ts buildDiscoveryRails, over the view's HomeRails. Never throws.</summary>
    public async Task<List<Rail>> BuildDiscoveryRailsAsync(string userId, HomeView view, CancellationToken ct = default)
    {
        var specs = view.Rails;
        try { await catalog.EnsureHomeRailsAsync(specs, ct).ConfigureAwait(false); }
        catch (Exception e) when (e is not OperationCanceledException) { logger.LogError(e, "[discovery] catalog refresh unavailable"); }

        var byRail = await SafeHomeRowsAsync(specs, ct).ConfigureAwait(false);
        var catalogRows = byRail.Values.SelectMany(rows => rows).ToList();
        var now = time.GetUtcNow();
        var recent = now.UtcDateTime.AddDays(-HomeReleaseCheckDays);
        var releaseRows = catalogRows.Where(r => r.ReleaseDate >= recent).ToList();
        var signals = await homeReleases.ReadSignalsAsync(releaseRows, ct).ConfigureAwait(false);
        homeReleases.ScheduleRefresh(releaseRows, signals);

        var rails = new List<Rail>();
        if (view.Type == HomeRails.AllView)
        {
            var because = await BuildBecauseRailAsync(userId, NewestOf(catalogRows), ct).ConfigureAwait(false);
            if (because is not null) rails.Add(because);
        }
        foreach (var spec in specs)
        {
            if (!byRail.TryGetValue(spec.Id, out var rows) || rows.Count == 0) continue;
            rails.Add(new Rail(spec.Id, spec.Title, [.. rows.Select(r => (object)ToRailItem(r, signals.GetValueOrDefault(r.WorkKey), now))])
            {
                Kind = spec.Kind,
                Genre = spec.Genre?.Id,
            });
        }
        return LeadWithAvailable(rails, view, now);
    }

    public const string CinemasRailId = "films-cinemas";
    public const string CinemasRailTitle = "In cinemas";

    /// <summary>
    /// Home rows lead with what can be fetched now, judged by the gate that draws a card's "In cinemas" and "Coming"
    /// chips (<see cref="ReleaseGates.Gate"/>). A film in cinemas leaves its row for one In cinemas row at the end of
    /// All and Films (none on a genre page), and a film not out yet leaves home. A series or anime that has not aired
    /// yet moves to the end of its row, so it never leads.
    /// </summary>
    public static List<Rail> LeadWithAvailable(IReadOnlyList<Rail> rails, HomeView view, DateTimeOffset now)
    {
        var output = new List<Rail>(rails.Count + 1);
        var cinemas = new List<object>();
        foreach (var rail in rails)
        {
            var open = new List<object>();
            var later = new List<object>();
            foreach (var card in rail.Items)
            {
                var gate = card is CatalogRailItem c ? ReleaseGates.Gate(c.ReleaseDate, c.MediaType, c.InTheatricalWindow, c.NextHomeReleaseAt, now) : null;
                if (gate is not { Gated: true }) open.Add(card);
                else if (gate.Reason == "theatrical") cinemas.Add(card);
                else if (!HomeRelease.IsMovie(((RailItem)card).MediaType)) later.Add(card);
            }
            output.Add(rail with { Items = [.. open, .. later] });
        }
        if (cinemas.Count > 0 && view.GenreRail is null && view.Type is HomeRails.AllView or HomeRails.Films)
            output.Add(new Rail(CinemasRailId, CinemasRailTitle, cinemas) { Kind = HomeRails.Films });
        return output;
    }

    private async Task<Rail?> BuildBecauseRailAsync(string userId, DateTime? baseRefreshedAt, CancellationToken ct)
    {
        CatalogSeed? seed;
        try { seed = await ReadWatchSeedAsync(userId, ct).ConfigureAwait(false); }
        catch (Exception e) when (e is not OperationCanceledException) { logger.LogError(e, "[discovery] seed unavailable"); return null; }
        if (seed is null) return null;

        var rows = await SafeRowsAsync("related", seed.Title, ct).ConfigureAwait(false);
        var newest = NewestOf(rows);
        if (rows.Count == 0)
        {
            await catalog.RefreshRelatedForSeedAsync(seed.Title, seed.MediaType).ConfigureAwait(false);
            rows = await SafeRowsAsync("related", seed.Title, ct).ConfigureAwait(false);
        }
        else if (baseRefreshedAt is { } b && newest is { } n && n < b)
        {
            _ = RefreshRelatedInBackgroundAsync(seed);
        }
        if (rows.Count == 0) return null;
        var signals = await homeReleases.ReadSignalsAsync(rows, ct).ConfigureAwait(false);
        homeReleases.ScheduleRefresh(rows, signals);
        var now = time.GetUtcNow();
        return new Rail(BecauseRailId, $"Because you're watching {seed.Title}",
            rows.Select(r => (object)ToRailItem(r, signals.GetValueOrDefault(r.WorkKey), now)).ToList());
    }

    private async Task RefreshRelatedInBackgroundAsync(CatalogSeed seed)
    {
        try { await catalog.RefreshRelatedForSeedAsync(seed.Title, seed.MediaType).ConfigureAwait(false); }
        catch (Exception e) { logger.LogWarning(e, "[discovery] background related refresh failed for {Seed}", seed.Title); }
    }

    // ------------------------------------------------------------------ seed.ts

    /// <summary>seed.ts readWatchSeed: the newest library title.</summary>
    public async Task<CatalogSeed?> ReadWatchSeedAsync(string userId, CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var library = await db.WatchListItems.AsNoTracking().Where(w => w.UserId == userId).OrderByDescending(w => w.UpdatedAt)
            .Select(w => new { w.Title, w.MediaType }).FirstOrDefaultAsync(ct).ConfigureAwait(false);
        if (!string.IsNullOrWhiteSpace(library?.Title) && UsableSeedTitle(library.Title) is { } libraryTitle)
            return new CatalogSeed(libraryTitle, MediaTypes.Normalize(library.MediaType));
        return null;
    }

    /// <summary>seed.ts usableSeedTitle: the work name a raw title/path/release parses to, unless it is slop.</summary>
    public static string? UsableSeedTitle(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var trimmed = raw.Trim();
        var name = ReleaseNames.WorkIdentity(trimmed).Name;
        var title = name.Length > 0 ? name : trimmed;
        return CatalogText.IsSlopTitle(title) ? null : title;
    }

    // ------------------------------------------------------------------ catalog cards

    public static CatalogRailItem ToRailItem(CatalogEntry row, HomeReleaseSignal? homeRelease = null, DateTimeOffset? now = null)
    {
        var releaseDay = row.ReleaseDate?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var gate = HomeRelease.TheatricalGateFromSignal(row.MediaType, releaseDay, homeRelease, now ?? DateTimeOffset.UtcNow);
        return new()
        {
            Id = $"catalog-{row.Id}",
            Title = row.Title,
            Subtitle = row.Year is { } y && y != 0 ? y.ToString(CultureInfo.InvariantCulture) : null,
            PosterUrl = row.PosterUrl,
            BackdropUrl = row.BackdropUrl,
            Overview = row.Overview,
            Availability = null,
            ReleaseDate = releaseDay,
            InTheatricalWindow = gate.InTheatricalWindow,
            NextHomeReleaseAt = gate.NextHomeReleaseAt,
            MediaType = MediaTypes.Normalize(row.MediaType),
            WorkKey = NonEmpty(WorkKeySlug.WorkKeyFor(row.Title, MediaTypes.IsSeries(row.MediaType) ? null : row.Year)),
            Year = row.Year,
            Provider = row.Provider,
            ProviderId = row.ProviderId,
        };
    }

    private async Task<Dictionary<string, List<CatalogEntry>>> SafeHomeRowsAsync(IReadOnlyList<HomeRail> rails, CancellationToken ct)
    {
        try
        {
            var rows = await catalog.ReadHomeRowsAsync([.. rails.Select(r => r.Id)], CatalogService.HomeRailRows, ct).ConfigureAwait(false);
            return rows.ToDictionary(p => p.Key, p => p.Value.Where(r => !CatalogText.IsSlopTitle(r.Title)).ToList(), StringComparer.Ordinal);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogError(e, "[discovery] home rail rows unavailable");
            return [];
        }
    }

    private async Task<List<CatalogEntry>> SafeRowsAsync(string source, string? seed, CancellationToken ct)
    {
        try
        {
            var rows = await catalog.ReadRowsAsync(source, seed, DiscoveryRailSize, ct).ConfigureAwait(false);
            return rows.Where(r => !CatalogText.IsSlopTitle(r.Title)).ToList();
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogError(e, "[discovery] {Source} rows unavailable", source);
            return [];
        }
    }

    private static DateTime? NewestOf(IEnumerable<CatalogEntry> rows) =>
        rows.Select(r => (DateTime?)r.RefreshedAt).DefaultIfEmpty(null).Max();

    // ------------------------------------------------------------------ organization

    public static string MediaGroupOf(string? mediaType)
    {
        var mt = (mediaType ?? "").Trim().ToLowerInvariant();
        if (mt.Length == 0) return "unknown";
        if (SeriesGroup().IsMatch(mt)) return "series";
        return MovieGroup().IsMatch(mt) ? "movie" : "unknown";
    }

    private static string? NonEmpty(string? value) => string.IsNullOrEmpty(value) ? null : value;
}
