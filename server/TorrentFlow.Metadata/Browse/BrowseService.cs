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
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public double? ProgressFraction { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public double? ResumePositionSec { get; init; }
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

/// <summary>Continue Watching / Ready to Play cards also name the catalog work they belong to (explicit nulls).</summary>
public sealed record WorkRailItem : RailItem
{
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? WorkId { get; init; }
    /// <summary>Next-episode cards only: "ready" (on disk), "downloading" or "missing". Omitted elsewhere.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? NextState { get; init; }
    /// <summary>0-1 download progress of that next episode while it is downloading.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? NextProgress { get; init; }
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
}

public sealed record BrowsePayload(IReadOnlyList<Rail> Rails, string GeneratedAt);

/// <summary>seed.ts CatalogSeed.</summary>
public sealed record CatalogSeed(string Title, string? MediaType);

/// <summary>
/// Two personal rails first (Continue watching, then Downloaded) with no work shown twice, then the discovery
/// rails; empty rails dropped.
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
    public const int RailArtworkBudgetMs = 8_000;
    public const string TrendingRailId = "trending-now";
    public const string PopularRailId = "popular-series";
    public const string BecauseRailId = "because-you-are-watching";

    [GeneratedRegex(@"(^|[^a-z])(tv|anime|series|show|episode|season)([^a-z]|$)")] private static partial Regex SeriesGroup();
    [GeneratedRegex(@"(^|[^a-z])(movie|film|feature)([^a-z]|$)")] private static partial Regex MovieGroup();

    public async Task<BrowsePayload> BuildAsync(string userId, CancellationToken ct = default)
    {
        var inProgressTask = BuildContinueWatchingAsync(userId, ct);
        var nextUpTask = BuildNextUpAsync(userId, ct);
        var libraryTask = BuildYourLibraryAsync(userId, ct);
        var discoveryTask = BuildDiscoveryRailsAsync(userId, ct);
        await Task.WhenAll(inProgressTask, nextUpTask, libraryTask).ConfigureAwait(false);
        var discovery = await discoveryTask.ConfigureAwait(false);

        var personal = OrganizePersonalRails(inProgressTask.Result, nextUpTask.Result, libraryTask.Result);
        var rails = personal.Concat(discovery).Where(r => r.Items.Count > 0).ToList();
        return new BrowsePayload(rails, time.GetUtcNow().UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
    }

    public const string ContinueWatchingRailId = "continue-watching";
    public const string YourLibraryRailId = "your-library";

    /// <summary>
    /// The downloaded rail's heading. Its id predates the name: in the UI "Library" is the list of titles you
    /// add and track, so a rail of files on disk calling itself "Your library" said a downloaded film was in
    /// the Library while its own page offered "Add to library".
    /// </summary>
    public const string DownloadedRailTitle = "Downloaded";

    /// <summary>
    /// The two personal rails, with no work shown twice. Continue watching is one card per show: a part-watched
    /// episode or movie wins, otherwise the show's next episode (downloaded or not). Downloaded is every
    /// ready work that is not already in Continue watching.
    /// </summary>
    public static List<Rail> OrganizePersonalRails(Rail? inProgress, Rail? nextUp, Rail? library)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        bool Claim(RailItem item)
        {
            var keys = PersonalWorkKeys(item);
            if (keys.Any(seen.Contains)) return false;
            seen.UnionWith(keys);
            return true;
        }

        var continuing = (inProgress?.Cards ?? []).Concat(nextUp?.Cards ?? []).Where(Claim).Cast<object>().ToList();
        var owned = (library?.Cards ?? []).Where(Claim).Cast<object>().ToList();
        var rails = new List<Rail>();
        if (continuing.Count > 0) rails.Add(new Rail(ContinueWatchingRailId, "Continue watching", continuing));
        if (owned.Count > 0) rails.Add(new Rail(YourLibraryRailId, DownloadedRailTitle, owned));
        return rails;
    }

    private static List<string> PersonalWorkKeys(RailItem item)
    {
        var keys = new List<string>();
        if (item is WorkRailItem { WorkId: { Length: > 0 } workId }) keys.Add($"work:{workId}");
        if (item is WorkRailItem { WorkKey: { Length: > 0 } workKey }) keys.Add($"key:{workKey}");
        if (!string.IsNullOrEmpty(item.WatchListItemId)) keys.Add($"watch:{item.WatchListItemId}");
        var title = RailItemWorkKey(item);
        if (title.Length > 0) keys.Add($"title:{title}");
        return keys;
    }

    // ------------------------------------------------------------------ Continue Watching

    public sealed record ProgressWork(string Id, string WorkKey, string CanonicalTitle, string MediaType, string? PosterUrl);

    public sealed record ContinueValue(PlaybackProgress Progress, ProgressWork? Work, EngineTorrent? Torrent, WatchListItem? WatchItem, string ReleaseName);

    private async Task<Rail?> BuildContinueWatchingAsync(string userId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var rows = await db.PlaybackProgresses.AsNoTracking().Where(p => p.UserId == userId && p.CompletedAt == null)
            .OrderByDescending(p => p.UpdatedAt).Take(60).ToListAsync(ct).ConfigureAwait(false);
        if (rows.Count == 0) return null;

        var workIds = rows.Select(r => r.WorkId).OfType<string>().Distinct().ToList();
        var works = workIds.Count == 0 ? [] : await db.Works.AsNoTracking().Where(w => workIds.Contains(w.Id))
            .ToDictionaryAsync(w => w.Id, ct).ConfigureAwait(false);
        var hashes = rows.Select(r => r.InfoHash.Trim().ToLowerInvariant()).Distinct().ToList();
        var watchIds = rows.Select(r => r.WatchListItemId).Where(id => !string.IsNullOrEmpty(id)).Distinct().ToList();
        var torrents = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == userId && hashes.Contains(t.Hash)).ToListAsync(ct).ConfigureAwait(false);
        var watchItems = watchIds.Count == 0 ? [] : await db.WatchListItems.AsNoTracking()
            .Where(w => w.UserId == userId && watchIds.Contains(w.Id)).ToListAsync(ct).ConfigureAwait(false);

        ProgressWork? WorkOf(PlaybackProgress p) =>
            p.WorkId is { Length: > 0 } id && works.TryGetValue(id, out var w) && w.WorkKey is { Length: > 0 } && w.CanonicalTitle is { Length: > 0 } && w.MediaType is { Length: > 0 }
                ? new ProgressWork(w.Id, w.WorkKey, w.CanonicalTitle, w.MediaType, w.PosterUrl) : null;

        var collapsed = ContinueWatchingWorksFromRows(rows.Select(p => (p, WorkOf(p))).ToList(), torrents, watchItems).Take(20).ToList();
        var art = await ResolveArtworkForReleasesAsync(collapsed.Select(c => c.ArtworkName).ToList()).ConfigureAwait(false);
        return ContinueWatchingRailFromWorks(collapsed, art, h => presence.Presence(userId, h), files.Lookup(torrents));
    }

    /// <summary>rails.ts continueWatchingRailFromWorks: cards in collapse order; artwork is index-aligned with works.</summary>
    public static Rail? ContinueWatchingRailFromWorks(IReadOnlyList<ContinueWork> works, IReadOnlyList<ArtworkResult> art,
        Func<string, TorrentPresence> presence, Func<string, LocalFilePresence>? filePresence = null)
    {
        var items = works.Select((work, i) =>
        {
            var r = work.Value.Progress;
            var a = i < art.Count ? art[i] : ArtworkResult.None;
            return (object)new WorkRailItem
            {
                Id = r.Id,
                WorkId = r.WorkId,
                WorkKey = work.WorkKey,
                Title = work.Title,
                Subtitle = FormatEpisodeSubtitle(r.Season, r.Episode),
                PosterUrl = r.PosterUrl ?? work.Value.Work?.PosterUrl ?? work.Value.WatchItem?.PosterUrl ?? a.PosterUrl,
                BackdropUrl = a.BackdropUrl,
                Availability = EngineAvailability(work.Value.Torrent, presence, filePresence),
                ProgressFraction = r.DurationSec is > 0 and var d ? Math.Min(r.PositionSec / d, 1) : null,
                ResumePositionSec = r.PositionSec,
                InfoHash = r.InfoHash,
                FilePath = r.FilePath,
                WatchListItemId = r.WatchListItemId,
                MediaType = work.Value.Work?.MediaType ?? work.Value.WatchItem?.MediaType,
                Season = r.Season,
                Episode = r.Episode,
            };
        }).ToList();
        return items.Count == 0 ? null : new Rail("continue-watching", "Continue Watching", items);
    }

    public sealed record ContinueWork(string WorkKey, string Title, string ArtworkName, ContinueValue Value, int ReleaseCount);

    public static List<ContinueWork> ContinueWatchingWorksFromRows(IReadOnlyList<(PlaybackProgress Progress, ProgressWork? Work)> rows,
        IEnumerable<EngineTorrent> torrents, IEnumerable<WatchListItem> watchItems)
    {
        var byHash = new Dictionary<string, EngineTorrent>(StringComparer.Ordinal);
        foreach (var t in torrents) byHash[t.Hash.Trim().ToLowerInvariant()] = t;
        var byWatchItem = watchItems.ToDictionary(w => w.Id, StringComparer.Ordinal);
        var collapsed = WorkCollapse.CollapseReleasesByWork(rows.Select(row =>
        {
            var r = row.Progress;
            var torrent = byHash.GetValueOrDefault(r.InfoHash.Trim().ToLowerInvariant());
            var watchItem = r.WatchListItemId is { } wid ? byWatchItem.GetValueOrDefault(wid) : null;
            var releaseName = torrent?.Name ?? ProgressIdentityName(r, watchItem);
            var workTitle = NonEmpty(row.Work?.CanonicalTitle.Trim()) ?? NonEmpty(watchItem?.Title?.Trim());
            return new CollapsibleRelease<ContinueValue>(releaseName, r.UpdatedAt, new ContinueValue(r, row.Work, torrent, watchItem, releaseName))
            {
                WorkTitle = workTitle,
                WorkKey = row.Work?.WorkKey,
                IdentityKey = NonEmpty(r.WorkId?.Trim()) is { } id ? $"work:{id}" : null,
                HasArtwork = r.PosterUrl != null || row.Work?.PosterUrl != null || watchItem?.PosterUrl != null,
                Prefer = workTitle != null,
            };
        }));
        return collapsed.Where(w => w.Title != WorkCollapse.UnknownWorkTitle).Select(w => new ContinueWork(w.WorkKey, w.Title,
            NonEmpty(w.Value.WatchItem?.Title?.Trim()) ?? NonEmpty(w.Value.ReleaseName) ?? w.Title, w.Value, w.ReleaseCount)).ToList();
    }

    private static string? NonEmpty(string? value) => string.IsNullOrEmpty(value) ? null : value;

    private static string ProgressIdentityName(PlaybackProgress row, WatchListItem? watchItem)
    {
        var title = NonEmpty(watchItem?.Title?.Trim());
        var episode = FormatEpisodeSubtitle(row.Season, row.Episode);
        return title != null && episode != null ? $"{title} {episode}" : title ?? row.Title;
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

    // ------------------------------------------------------------------ Next Up

    /// <summary>
    /// The next episode of every monitored show; merged into Continue watching, never shown as its own rail. Whether
    /// that episode is on disk comes from the library's own episode records for the work (acquisition targets, then
    /// the season/episode of the files in torrents linked to it), never from matching release names to the title.
    /// </summary>
    private async Task<Rail?> BuildNextUpAsync(string userId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var rows = await db.WatchListItems.AsNoTracking()
            .Where(w => w.UserId == userId && w.Monitored == true && w.CursorSeason != null && w.CursorEpisode != null)
            .OrderByDescending(w => w.UpdatedAt).Take(20).ToListAsync(ct).ConfigureAwait(false);
        if (rows.Count == 0) return null;

        var workIds = rows.Select(w => w.WorkId).OfType<string>().Where(id => id.Length > 0).Distinct().ToList();
        var works = await db.Works.AsNoTracking().Where(w => workIds.Contains(w.Id))
            .Select(w => new { w.Id, w.WorkKey, w.PosterUrl }).ToListAsync(ct).ConfigureAwait(false);
        var workKeys = works.Select(w => w.WorkKey).ToList();
        var targets = await db.AcquisitionTargets.AsNoTracking()
            .Where(a => a.UserId == userId && a.Scope == "episode" && a.Season != null && a.Episode != null
                && ((a.WorkId != null && workIds.Contains(a.WorkId)) || workKeys.Contains(a.WorkKey)))
            .OrderByDescending(a => a.UpdatedAt).ToListAsync(ct).ConfigureAwait(false);
        var targetHashes = targets.Select(a => a.InfoHash).OfType<string>().Select(h => h.ToLowerInvariant()).Distinct().ToList();
        var torrents = await db.EngineTorrents.AsNoTracking()
            .Where(t => t.UserId == userId && t.Status != "removed" && t.Status != "error"
                && ((t.WorkId != null && workIds.Contains(t.WorkId)) || targetHashes.Contains(t.Hash.ToLower())))
            .ToListAsync(ct).ConfigureAwait(false);
        var filePresence = files.Lookup(torrents);
        var torrentByHash = torrents.GroupBy(t => t.Hash.ToLowerInvariant()).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var workKeyById = works.ToDictionary(w => w.Id, w => w.WorkKey, StringComparer.Ordinal);

        var states = rows.Select(w =>
        {
            var workKey = w.WorkId is { } id ? workKeyById.GetValueOrDefault(id) : null;
            var mine = targets.Where(a => (w.WorkId != null && a.WorkId == w.WorkId) || (workKey != null && a.WorkKey == workKey));
            var linked = torrents.Where(t => w.WorkId != null && t.WorkId == w.WorkId);
            return ResolveNextEpisode(w.CursorSeason!.Value, w.CursorEpisode!.Value, mine, linked, torrentByHash,
                h => presence.Presence(userId, h), filePresence);
        }).ToList();

        var posterByWork = works.Where(w => !string.IsNullOrEmpty(w.PosterUrl)).ToDictionary(w => w.Id, w => w.PosterUrl, StringComparer.Ordinal);
        var needsArt = rows.Where(w => string.IsNullOrEmpty(w.PosterUrl) && (w.WorkId is null || !posterByWork.ContainsKey(w.WorkId))).ToList();
        var art = needsArt.Count == 0 ? [] : await ResolveArtworkForReleasesAsync(needsArt.Select(w => w.Title).ToList()).ConfigureAwait(false);
        var artByRow = needsArt.Select((w, i) => (w.Id, art[i].PosterUrl)).ToDictionary(x => x.Id, x => x.PosterUrl, StringComparer.Ordinal);

        var items = rows.Select((w, i) => (object)new WorkRailItem
        {
            Id = $"next-{w.Id}", WorkId = w.WorkId, WorkKey = w.WorkId is { } id ? workKeyById.GetValueOrDefault(id) : null, Title = w.Title,
            Subtitle = FormatEpisodeSubtitle(w.CursorSeason, w.CursorEpisode) is { } code ? $"Next · {code}" : null,
            PosterUrl = NonEmpty(w.PosterUrl) ?? (w.WorkId is { } wid ? posterByWork.GetValueOrDefault(wid) : null) ?? artByRow.GetValueOrDefault(w.Id),
            Availability = states[i].State == NextEpisodeState.Ready ? "ready" : null,
            NextState = states[i].State switch { NextEpisodeState.Ready => "ready", NextEpisodeState.Downloading => "downloading", _ => "missing" },
            NextProgress = states[i].State == NextEpisodeState.Downloading ? states[i].Progress : null,
            InfoHash = states[i].State == NextEpisodeState.Ready ? states[i].InfoHash : null,
            FilePath = states[i].State == NextEpisodeState.Ready ? states[i].FilePath : null,
            WatchListItemId = w.Id, MediaType = w.MediaType, Season = w.CursorSeason, Episode = w.CursorEpisode,
        }).ToList();
        return new Rail("next-up", "Next Up", items);
    }

    public enum NextEpisodeState { Missing, Downloading, Ready }

    public sealed record NextEpisode(NextEpisodeState State, double? Progress = null, string? InfoHash = null, string? FilePath = null);

    /// <summary>
    /// One show's next episode against the library's records. An episode-scope acquisition target for that season and
    /// episode decides first; otherwise a video file in a torrent linked to the work whose own name is that episode.
    /// On disk is Ready, still arriving is Downloading, anything else is Missing.
    /// </summary>
    public static NextEpisode ResolveNextEpisode(int season, int episode, IEnumerable<AcquisitionTarget> targets, IEnumerable<EngineTorrent> linked,
        IReadOnlyDictionary<string, EngineTorrent> torrentByHash, Func<string, TorrentPresence> presence, Func<string, LocalFilePresence> filePresence)
    {
        var downloading = (NextEpisode?)null;
        foreach (var target in targets.Where(a => a.Season == season && a.Episode == episode))
        {
            var torrent = target.InfoHash is { } hash ? torrentByHash.GetValueOrDefault(hash.ToLowerInvariant()) : null;
            if (target.Status == "downloaded" && EngineAvailability(torrent, presence, filePresence) == "ready")
                return new NextEpisode(NextEpisodeState.Ready, 1, torrent!.Hash, target.FilePath);
            if (target.Status is "queued" or "downloading" && torrent is not null)
                downloading ??= new NextEpisode(NextEpisodeState.Downloading, Math.Clamp(Math.Max(target.Progress, torrent.Progress), 0, 1), torrent.Hash, target.FilePath);
        }

        foreach (var torrent in linked)
        {
            var file = EpisodeFiles(torrent).FirstOrDefault(f => f.Season == season && f.Episode == episode);
            if (file is null) continue;
            if (EngineAvailability(torrent, presence, filePresence) == "ready")
                return new NextEpisode(NextEpisodeState.Ready, 1, torrent.Hash, file.Path);
            if (torrent.Progress < 1 && torrent.Origin is not ("stream" or "prewarm"))
                downloading ??= new NextEpisode(NextEpisodeState.Downloading, Math.Clamp(torrent.Progress, 0, 1), torrent.Hash, file.Path);
        }
        return downloading ?? new NextEpisode(NextEpisodeState.Missing);
    }

    private sealed record EpisodeFile(int? Season, int Episode, string? Path);

    [GeneratedRegex(@"\bS(\d{1,2})\s*-\s*(\d{1,4})\b", RegexOptions.IgnoreCase)] private static partial Regex SeasonDashEpisode();

    /// <summary>Season/episode of each single-episode video file; a torrent with no recorded files stands for its own name.</summary>
    private static IEnumerable<EpisodeFile> EpisodeFiles(EngineTorrent torrent)
    {
        var fallbackSeason = EpisodeCoordinates(torrent.Name).Season;
        var videos = LocalFiles.RecordedFilePaths(torrent.VerifiedFilesJson).Where(ReleaseNames.IsSupportedVideoFileName).ToList();
        if (videos.Count == 0)
        {
            var own = EpisodeCoordinates(torrent.Name);
            if (own.Episode is int single) yield return new EpisodeFile(own.Season ?? fallbackSeason ?? 1, single, null);
            yield break;
        }
        foreach (var path in videos)
        {
            var parsed = EpisodeCoordinates(Path.GetFileNameWithoutExtension(path.Replace('\\', '/').Split('/')[^1]));
            if (parsed.Episode is int ep) yield return new EpisodeFile(parsed.Season ?? fallbackSeason ?? 1, ep, path);
        }
    }

    /// <summary>ParseEpisode, plus the fansub "S2 - 03" form it reads as a season range.</summary>
    private static (int? Season, int? Episode) EpisodeCoordinates(string name)
    {
        var parsed = ReleaseNames.ParseEpisode(name);
        if (parsed.Episode is int ep) return (parsed.Season, ep);
        var dash = SeasonDashEpisode().Match(name);
        if (dash.Success) return (int.Parse(dash.Groups[1].Value, CultureInfo.InvariantCulture), int.Parse(dash.Groups[2].Value, CultureInfo.InvariantCulture));
        return (parsed.Season, null);
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

    /// <summary>discovery.ts buildDiscoveryRails. Never throws.</summary>
    public async Task<List<Rail>> BuildDiscoveryRailsAsync(string userId, CancellationToken ct = default)
    {
        try { await catalog.EnsureFreshAsync(ct).ConfigureAwait(false); }
        catch (Exception e) when (e is not OperationCanceledException) { logger.LogError(e, "[discovery] catalog refresh unavailable"); }

        var trending = await SafeRowsAsync("trending", null, ct).ConfigureAwait(false);
        var popular = await SafeRowsAsync("popular", null, ct).ConfigureAwait(false);
        var chartRows = trending.Concat(popular).ToList();
        var signals = await homeReleases.ReadSignalsAsync(chartRows, ct).ConfigureAwait(false);
        homeReleases.ScheduleRefresh(chartRows, signals);

        var now = time.GetUtcNow();
        var rails = new List<Rail>();
        var because = await BuildBecauseRailAsync(userId, NewestOf(chartRows), ct).ConfigureAwait(false);
        if (because is not null) rails.Add(because);
        if (trending.Count > 0)
            rails.Add(new Rail(TrendingRailId, "Trending now", trending.Select(r => (object)ToRailItem(r, signals.GetValueOrDefault(r.WorkKey), now)).ToList()));
        if (popular.Count > 0)
            rails.Add(new Rail(PopularRailId, "Popular series", popular.Select(r => (object)ToRailItem(r, signals.GetValueOrDefault(r.WorkKey), now)).ToList()));
        return rails;
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

    /// <summary>seed.ts readWatchSeed: the newest unfinished playback's work, else the newest library title.</summary>
    public async Task<CatalogSeed?> ReadWatchSeedAsync(string userId, CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct).ConfigureAwait(false);
        var watching = await db.PlaybackProgresses.AsNoTracking().Where(p => p.UserId == userId && p.CompletedAt == null)
            .OrderByDescending(p => p.UpdatedAt)
            .Select(p => new { p.Title, p.Season, p.Episode, p.WatchListItemId, p.FilePath, p.InfoHash })
            .FirstOrDefaultAsync(ct).ConfigureAwait(false);
        if (watching is not null)
        {
            var title = await ResolveProgressSeedTitleAsync(db, watching.Title, watching.FilePath, watching.InfoHash, watching.WatchListItemId, ct).ConfigureAwait(false);
            if (title is not null)
            {
                string? mediaType = null;
                if (watching.Season is not null || watching.Episode is not null) mediaType = MediaTypes.Normalize("tv");
                else if (watching.WatchListItemId is { } wid)
                    mediaType = MediaTypes.Normalize(await db.WatchListItems.AsNoTracking().Where(w => w.Id == wid).Select(w => w.MediaType)
                        .FirstOrDefaultAsync(ct).ConfigureAwait(false));
                return new CatalogSeed(title, mediaType);
            }
        }
        var library = await db.WatchListItems.AsNoTracking().Where(w => w.UserId == userId).OrderByDescending(w => w.UpdatedAt)
            .Select(w => new { w.Title, w.MediaType }).FirstOrDefaultAsync(ct).ConfigureAwait(false);
        if (!string.IsNullOrWhiteSpace(library?.Title) && UsableSeedTitle(library.Title) is { } libraryTitle)
            return new CatalogSeed(libraryTitle, MediaTypes.Normalize(library.MediaType));
        return null;
    }

    private static async Task<string?> ResolveProgressSeedTitleAsync(TorrentFlowDbContext db, string? title, string? filePath, string infoHash,
        string? watchListItemId, CancellationToken ct)
    {
        var candidates = new List<string>();
        if (!string.IsNullOrWhiteSpace(title)) candidates.Add(title);
        if (!string.IsNullOrWhiteSpace(filePath))
        {
            if (filePath.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() is { } leaf) candidates.Add(leaf);
            candidates.Add(filePath);
        }
        foreach (var raw in candidates)
            if (UsableSeedTitle(raw) is { } usable) return usable;

        if (!string.IsNullOrEmpty(watchListItemId))
        {
            var linked = await db.WatchListItems.AsNoTracking().Where(w => w.Id == watchListItemId).Select(w => w.Title).FirstOrDefaultAsync(ct).ConfigureAwait(false);
            if (UsableSeedTitle(linked) is { } usable) return usable;
        }
        var hash = infoHash?.Trim().ToLowerInvariant();
        if (!string.IsNullOrEmpty(hash))
        {
            var name = await db.EngineTorrents.AsNoTracking().Where(t => t.Hash == hash).Select(t => t.Name).FirstOrDefaultAsync(ct).ConfigureAwait(false);
            if (UsableSeedTitle(name) is { } usable) return usable;
        }
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

    /// <summary>rails.ts railItemWorkKey: workIdentity(title).key.</summary>
    public static string RailItemWorkKey(RailItem item) => ReleaseNames.WorkIdentity(item.Title).Key;

    public static string? FormatEpisodeSubtitle(int? season, int? episode) =>
        season is not null && episode is not null ? $"S{season:D2}E{episode:D2}"
        : season is not null ? $"Season {season}"
        : episode is not null ? $"Episode {episode}"
        : null;
}
