using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Titles;

/// <param name="Provider">The provider record the link's id resolved to (verified).</param>
/// <param name="Claimed">The provider id the link carried when it could not be verified.</param>
/// <param name="FindIdentity">Look up the provider id of a title nothing names yet (the page GET only; a download never waits on it).</param>
public sealed record TitleQuery(string WorkKey, string? Title = null, int? Year = null, string? MediaType = null,
    int? Season = null, int? Remembered = null, MediaMetadata? Provider = null, TitleIdentity? Claimed = null, bool FindIdentity = false);

/// <summary>A title at a metadata provider: what a request names.</summary>
public sealed record TitleIdentity(string Provider, string ProviderId)
{
    /// <summary>The identity when both parts are present and requests accept the provider, else null.</summary>
    public static TitleIdentity? From(string? provider, string? providerId) =>
        provider?.Trim().ToLowerInvariant() is { Length: > 0 } p && IMetadataResolver.SupportsProvider(p) &&
        providerId?.Trim() is { Length: > 0 } id ? new(p, id) : null;

    /// <summary>Whether a provider's own record is the title this work key names (by its title or an alias, and its year).</summary>
    public static bool Matches(string workKey, MediaMetadata resolved) =>
        (resolved.Aliases ?? []).Prepend(resolved.Title).Any(title =>
            ReleaseSelection.MatchesWork(workKey.Trim().ToLowerInvariant(), title, resolved.Year));
}

public sealed class TitleService(IDbContextFactory<TorrentFlowDbContext> factory, ICatalogLookup catalog, ILibraryArtworkResolver artwork, ITorrentEngine engine,
    IMetadataResolver metadata)
{
    private static readonly TimeSpan ArtworkBudget = TimeSpan.FromMilliseconds(1200);
    private static readonly TimeSpan IdentityBudget = TimeSpan.FromMilliseconds(2500);

    /// <summary>
    /// The one transfer shape of a title payload. <c>status</c> is the acquisition row's own status; <c>state</c> splits its
    /// "queued" in two: "looking" (no release found yet) and "queued" (a release waits for a download slot, with the engine's
    /// <c>queuePosition</c> and <c>waitReason</c>). Requesters get only <c>state</c> (RequesterCatalogProjectionMiddleware).
    /// </summary>
    internal static Dictionary<string, object?> Transfer(AcquisitionTarget target, IReadOnlyDictionary<string, EngineTorrentInfo> queue) =>
        Transfer(target.Status, target.Status == "queued" && target.InfoHash == null ? "looking" : target.Status, target.Progress,
            target.InfoHash, target.FilePath, target.Error, target.InfoHash is { } hash ? queue.GetValueOrDefault(hash) : null);

    private static Dictionary<string, object?> Transfer(string status, string state, double progress, string? infoHash, string? filePath, string? error, EngineTorrentInfo? slot) =>
        LibraryJson.Object(("status", status), ("state", state), ("progress", Math.Clamp(progress, 0, 1)),
            ("infoHash", infoHash), ("filePath", filePath), ("error", error),
            ("queuePosition", slot?.QueuePosition), ("waitReason", slot?.WaitReason));

    /// <summary>Queue slots by hash, read from the engine's own list (as the Downloads page shows them) only when something here waits for one.</summary>
    private async Task<IReadOnlyDictionary<string, EngineTorrentInfo>> QueueAsync(bool anyQueued, CancellationToken ct)
    {
        var slots = new Dictionary<string, EngineTorrentInfo>(StringComparer.OrdinalIgnoreCase);
        if (!anyQueued) return slots;
        foreach (var row in await engine.ListAsync(ct))
            if (row.QueuePosition != null) slots.TryAdd(row.Hash, row);
        return slots;
    }

    internal static bool FilesAbsent(EngineTorrent row)
    {
        var located = (VerifiedFiles.Read(row.VerifiedFilesJson) ?? []).Select(f => f.Path).OfType<string>().ToList();
        return located.Count > 0 && located.All(VerifiedFiles.ConfirmedMissing);
    }
    internal static void Reconcile(AcquisitionTarget target, EngineTorrent? row)
    {
        target.Progress = Math.Clamp(target.Progress, 0, 1);
        if (target.InfoHash == null) return;
        if (row == null || FilesAbsent(row) || InvalidMedia(row))
        {
            // A season pack that failed as a whole hands its episodes back to the wanted queue.
            target.Status = target.FileIndex != null ? "queued" : "failed"; target.Progress = 0; target.InfoHash = null; target.FilePath = null;
            target.FileIndex = null;
            target.Error = "The requested file is no longer available.";
        }
        else if (row.Status.ToLowerInvariant() is "error" or "missingfiles")
        {
            target.Status = target.FileIndex != null ? "queued" : "failed"; target.Progress = 0; target.InfoHash = null; target.FilePath = null;
            target.FileIndex = null;
            target.Error ??= "The downloaded release could not be used. TorrentFlow will choose another release.";
        }
        else
        {
            target.Progress = Math.Clamp(row.Progress, 0, 1);
            // An engine row waiting in the built-in download queue is admitted but not moving (TS 446bff0).
            target.Status = row.Progress >= 1 || row.Status.Equals("seeding", StringComparison.OrdinalIgnoreCase) ? "downloaded" : target.Status == "failed" ? "failed" :
                row.Status.Equals("queued", StringComparison.OrdinalIgnoreCase) ? "queued" : "downloading";
            if (target.Status == "downloaded") target.Progress = 1;
        }
    }
    public async Task<object> Progress(string key, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var targets = await db.AcquisitionTargets.Where(x => x.UserId == LocalUser.Id && x.WorkKey == key && (x.Status == "queued" || x.Status == "downloading")).ToListAsync(ct);
        var hashes = targets.Select(x => x.InfoHash).OfType<string>().ToArray();
        var engines = await db.EngineTorrents.Where(x => x.UserId == LocalUser.Id && x.Status != "removed" && hashes.Contains(x.Hash)).ToListAsync(ct);
        var episodes = new Dictionary<string, object?>();
        var seasons = new Dictionary<string, object?>();
        object? transfer = null;
        foreach (var target in targets)
            Reconcile(target, engines.FirstOrDefault(x => x.Hash.Equals(target.InfoHash, StringComparison.OrdinalIgnoreCase)));
        var queue = await QueueAsync(targets.Any(x => x.Status == "queued" && x.InfoHash != null), ct);
        foreach (var target in targets)
        {
            if (target.Status is not ("queued" or "downloading")) continue;
            if (target.Scope == "title") transfer = Transfer(target, queue);
            else if (target.Scope == "season" && target.Season != null) seasons[target.Season.ToString()!] = Transfer(target, queue);
            else if (target.Season != null && target.Episode != null) episodes[new EpisodeCursor(target.Season.Value, target.Episode.Value).Label] = Transfer(target, queue);
        }
        await db.SaveChangesAsync(ct);
        return LibraryJson.Object(("workKey", key), ("transfer", transfer), ("seasonTransfers", seasons), ("episodeTransfers", episodes), ("generatedAt", LibraryJson.Iso(DateTime.UtcNow)));
    }
    public async Task<Dictionary<string, object?>> Detail(TitleQuery query, CancellationToken ct)
    {
        var key = query.WorkKey.Trim().ToLowerInvariant();
        await using var db = await factory.CreateDbContextAsync(ct);
        var cat = await catalog.FindByWorkKeyAsync(key, ct);
        // A link without an id still names a requestable title: the work's own id, else the chart row's, else the link's unverified claim.
        var work = await db.Works.AsNoTracking().Where(x => x.WorkKey == key).Select(x => new { x.Provider, x.ProviderId }).FirstOrDefaultAsync(ct);
        var identity = TitleIdentity.From(query.Provider?.Source, query.Provider?.ExternalId) ?? TitleIdentity.From(work?.Provider, work?.ProviderId)
            ?? TitleIdentity.From(cat?.Provider, cat?.ProviderId) ?? query.Claimed;
        var watches = await db.WatchListItems.AsNoTracking().Where(x => x.UserId == LocalUser.Id).OrderByDescending(x => x.UpdatedAt).Take(400).ToListAsync(ct);
        var watch = watches.FirstOrDefault(x => ReleaseSelection.MatchesWork(key, x.Title));
        var engineRows = await db.EngineTorrents.AsNoTracking().Where(x => x.UserId == LocalUser.Id && x.Status != "removed").OrderByDescending(x => x.UpdatedAt).Take(400).ToListAsync(ct);
        var targets = await db.AcquisitionTargets.Where(x => x.UserId == LocalUser.Id && x.WorkKey == key).OrderByDescending(x => x.UpdatedAt).Take(400).ToListAsync(ct);
        // TS missingLinkedHashes: a linked torrent older than the scan window is still this work's torrent, not a lost one.
        var scanned = engineRows.Select(x => x.Hash.Trim().ToLowerInvariant()).ToHashSet(StringComparer.Ordinal);
        var missingLinked = targets.Select(x => x.InfoHash?.Trim().ToLowerInvariant()).OfType<string>().Where(x => x.Length > 0 && !scanned.Contains(x)).Distinct().ToArray();
        if (missingLinked.Length > 0)
            engineRows.AddRange(await db.EngineTorrents.AsNoTracking().Where(x => x.UserId == LocalUser.Id && x.Status != "removed" &&
                (missingLinked.Contains(x.Hash) || missingLinked.Contains(x.Hash.ToLower()))).ToListAsync(ct));
        var local = engineRows.Where(x => ReleaseSelection.MatchesWork(key, ReleaseSelection.CleanTitle(x.Name), ReleaseYear(x.Name))).ToList();
        foreach (var target in targets) Reconcile(target, engineRows.FirstOrDefault(x => x.Hash.Equals(target.InfoHash, StringComparison.OrdinalIgnoreCase)));
        await db.SaveChangesAsync(ct);
        var queue = await QueueAsync(targets.Any(x => x.Status == "queued" && x.InfoHash != null) || local.Any(x => x.Status == EngineTorrentStatus.Queued), ct);
        var title = query.Provider?.Title ?? cat?.Title ?? (query.Title != null && ReleaseSelection.MatchesWork(key, query.Title, query.Year) ? query.Title : null) ??
            watch?.Title ?? (local.FirstOrDefault() is { } first ? ReleaseSelection.CleanTitle(first.Name) : null) ?? TorrentFlow.Core.Text.WorkKeySlug.DisplayTitle(key);
        var type = query.Provider?.MediaType ?? cat?.MediaType ?? query.MediaType ?? watch?.MediaType;
        var year = query.Provider?.Year ?? cat?.Year ?? query.Year;
        var isSeries = type != "movie" && (EpisodeCursor.IsSeries(type) || local.Any(x => EpisodeCursor.Parse(x.Name) != null || PackSeason(x.Name) != null || MultiSeason(x.Name)) || watch?.CursorSeason != null);
        if (identity == null && query.FindIdentity && type != "anime") identity = await FindIdentityAsync(key, title, year, isSeries, ct);
        var cached = (await db.CachedMetadata.AsNoTracking().OrderByDescending(x => x.UpdatedAt).Take(200).ToListAsync(ct))
            .FirstOrDefault(x => ReleaseSelection.Normalize(x.Title) == ReleaseSelection.Normalize(title) && (type == null || x.MediaType == type) &&
                (year == null || x.Year == null || (type == "tv" ? x.Year - year < 2 : Math.Abs(x.Year.Value - year.Value) < 2)));
        var poster = query.Provider?.PosterUrl ?? cat?.PosterUrl ?? cached?.PosterUrl;
        var backdrop = query.Provider?.BackdropUrl ?? cat?.BackdropUrl ?? cached?.BackdropUrl;
        if (poster == null && backdrop == null)
        {
            // Nothing local: one budgeted remote attempt (TS ARTWORK_BUDGET_MS). The resolver keeps its own lookup alive to warm its cache.
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(ArtworkBudget);
            try
            {
                var resolved = await artwork.ResolveAsync(title, year, type, budget.Token).WaitAsync(budget.Token);
                poster = resolved.PosterUrl;
                backdrop = resolved.BackdropUrl;
            }
            catch (Exception) when (!ct.IsCancellationRequested) { }
        }
        poster = await WorkPosters.ResolveAsync(db, key, poster, ct);
        var overview = query.Provider?.Synopsis ?? cat?.Overview ?? cached?.Synopsis;
        // The rating travels with the provider that supplied it, so the page never labels one provider's score with another's name.
        var (rating, ratingSource) = query.Provider?.Rating is { } providerRating ? (providerRating, query.Provider.Source)
            : cat?.Rating is { } catalogRating ? (catalogRating, cat.RatingSource)
            : cached?.Rating is { } cachedRating ? (cachedRating, cached.Source) : ((double?)null, (string?)null);
        if (ratingSource != null && !IMetadataResolver.SupportsProvider(ratingSource)) ratingSource = null;
        var release = query.Provider?.ReleaseDate ?? cat?.ReleaseDate ?? (cached?.ReleaseDate is { } date ? LibraryJson.Iso(date) : null);
        var searchRows = await db.SearchCaches.AsNoTracking().OrderByDescending(x => x.CreatedAt).Take(80).ToListAsync(ct);
        SearchResponse? cachedSearch = null;
        foreach (var row in searchRows)
        {
            try
            {
                var data = JsonSerializer.Deserialize<SearchResponse>(row.Payload, new JsonSerializerOptions(JsonSerializerDefaults.Web));
                if (data != null && ReleaseSelection.Normalize(ReleaseSelection.CleanTitle(data.Query)) == ReleaseSelection.Normalize(title)) { cachedSearch = data; break; }
            }
            catch (JsonException) { }
        }
        var releases = cachedSearch?.Results.Where(x => ReleaseSelection.SameWork(x, title, query.Provider?.Aliases ?? [])).ToArray() ?? [];
        var onDisk = local.Where(x => x.Status is not ("error" or "missingfiles") && !FilesAbsent(x) && !InvalidMedia(x)).OrderByDescending(x => x.Progress).ToList();
        var best = onDisk.FirstOrDefault(x => x.Progress > 0);
        string? State(EngineTorrent? row) => row == null ? null : row.Progress >= 1 ? "ready" : row.Progress > 0 ? "warm" : null;
        double? Fraction(EngineTorrent? row) => row != null && row.Progress > 0 && row.Progress < 1 ? row.Progress : null;
        var availability = State(best) ?? (releases.Any(x => ReleaseSeeders.IsViable(x.Seeders)) ? "fetchable" : cachedSearch != null ? "unavailable" : null);
        var knownCoordinates = local.Select(x => EpisodeCursor.Parse(x.Name)).Concat(releases.Select(x => EpisodeCursor.Parse(x.Title)))
            .OfType<EpisodeCursor>().ToArray();
        var coordinates = knownCoordinates.Select(x => (EpisodeCursor?)x).Concat(targets.Where(x => x.Season != null && x.Episode != null).Select(x => (EpisodeCursor?)new EpisodeCursor(x.Season!.Value, x.Episode!.Value)))
            .Concat(watch?.CursorSeason != null && watch.CursorEpisode != null ? [new EpisodeCursor(watch.CursorSeason.Value, watch.CursorEpisode.Value)] : []).OfType<EpisodeCursor>().ToArray();
        var seasonNumbers = isSeries ? coordinates.Select(x => x.Season)
            .Concat(local.Select(x => PackSeason(x.Name)).Concat(releases.Select(x => PackSeason(x.Title))).OfType<int>())
            .Concat(targets.Where(x => x.Season != null).Select(x => x.Season!.Value)).Distinct().Order().ToArray() : [];
        int? selected = isSeries && seasonNumbers.Length > 0 ? query.Season ?? query.Remembered ?? watch?.CursorSeason ?? seasonNumbers[0] : null;
        var seasons = seasonNumbers.Select(s =>
        {
            var pack = onDisk.FirstOrDefault(x => PackSeason(x.Name) == s && x.Progress > 0);
            // Same evidence the episode rows use: an exact finished target, a finished episode file, or a verified pack file.
            var downloaded = targets.Where(t => t.Scope == "episode" && t.Season == s && t.Episode != null && t.Status == "downloaded").Select(t => t.Episode!.Value)
                .Concat(onDisk.Where(x => x.Progress >= 1 && EpisodeCursor.Parse(x.Name) is { } c && c.Season == s).Select(x => EpisodeCursor.Parse(x.Name)!.Value.Episode))
                .Concat(PackCoverage(onDisk, s).Keys).Where(e => e >= 1).ToHashSet();
            var downloading = targets.Where(t => t.Scope == "episode" && t.Season == s && t.Episode != null && t.Status is "queued" or "downloading").Select(t => t.Episode!.Value)
                .Concat(onDisk.Where(x => x.Progress < 1 && EpisodeCursor.Parse(x.Name) is { } c && c.Season == s).Select(x => EpisodeCursor.Parse(x.Name)!.Value.Episode))
                .Where(e => e >= 1 && !downloaded.Contains(e)).Distinct().Count();
            return LibraryJson.Object(("season", s), ("knownEpisodes", knownCoordinates.Where(c => c.Season == s).Select(c => c.Episode).Distinct().Count()),
                ("downloadedEpisodes", downloaded.Count), ("downloadingEpisodes", downloading),
                ("pack", pack == null ? null : LibraryJson.Object(("name", pack.Name), ("availability", State(pack)), ("infoHash", pack.Hash), ("downloadFraction", Fraction(pack)))),
                ("transfer", targets.FirstOrDefault(t => t.Scope == "season" && t.Season == s) is { } target ? Transfer(target, queue) : null));
        }).ToList();
        var coverage = selected is { } selectedSeason ? PackCoverage(onDisk, selectedSeason) : [];
        var maxEpisode = coordinates.Where(x => x.Season == selected).Select(x => x.Episode).Concat(coverage.Keys).DefaultIfEmpty(0).Max();
        var episodes = new List<object>();
        var episodeLimit = type == "anime" ? 5000 : 200;
        for (var ep = 1; ep <= Math.Min(episodeLimit, maxEpisode); ep++)
        {
            var cursor = new EpisodeCursor(selected!.Value, ep);
            var t = targets.FirstOrDefault(x => x.Scope == "episode" && x.Season == cursor.Season && x.Episode == ep);
            var linkedHash = t?.InfoHash;
            var row = linkedHash != null ? onDisk.FirstOrDefault(x => x.Hash.Equals(linkedHash, StringComparison.OrdinalIgnoreCase)) :
                onDisk.FirstOrDefault(x => EpisodeCursor.Parse(x.Name) == cursor && x.Progress > 0);
            var state = t?.Status == "downloaded" ? "ready" : t?.Status == "downloading" && t.Progress > 0 ? "warm" :
                State(row) ?? (releases.Any(x => ReleaseSeeders.IsViable(x.Seeders) && (ReleaseSelection.ExactEpisode(x, cursor) || PackSeason(x.Title) == cursor.Season)) ? "fetchable" : null);
            var hash = t?.InfoHash ?? row?.Hash;
            var file = t?.FilePath;
            var fromPack = t?.InfoHash != null && row != null && (PackSeason(row.Name) != null || MultiSeason(row.Name));
            if (state != "ready" && coverage.TryGetValue(ep, out var cover))
            {
                state = State(cover.Row); hash = cover.Row.Hash; file = cover.Path; fromPack = true;
            }
            object? transfer = t == null ? null : Transfer(t, queue);
            double? fraction = t?.Status == "downloading" ? t.Progress : Fraction(row);
            if (t == null)
            {
                var downloading = row?.Progress > 0 && row.Progress < 1 ? row :
                    row == null ? onDisk.FirstOrDefault(x => EpisodeCursor.Parse(x.Name) == cursor && x.Progress < 1) : null;
                if (downloading != null)
                {
                    // A download started outside this page still says whether it waits for a slot.
                    transfer = queue.GetValueOrDefault(downloading.Hash) is { } slot
                        ? Transfer("queued", "queued", downloading.Progress, downloading.Hash, null, null, slot)
                        : Transfer("downloading", "downloading", downloading.Progress, downloading.Hash, null, null, null);
                    hash = downloading.Hash; fraction = downloading.Progress;
                    if (downloading.Progress > 0) state = "warm";
                }
            }
            episodes.Add(LibraryJson.Object(("season", cursor.Season), ("episode", ep), ("label", cursor.Label),
                ("availability", state), ("infoHash", hash), ("filePath", file), ("downloadFraction", fraction),
                ("nextUp", watch?.CursorSeason == cursor.Season && watch?.CursorEpisode == ep), ("fromPack", fromPack), ("transfer", transfer)));
        }
        var library = LibraryJson.Object(("inLibrary", watch != null), ("watchListItemId", watch?.Id), ("monitored", watch?.Monitored ?? false),
            ("status", watch?.Status), ("cursorSeason", watch?.CursorSeason), ("cursorEpisode", watch?.CursorEpisode),
            ("addPayload", LibraryJson.Object(("mediaType", type ?? (isSeries ? "tv" : "movie")), ("externalId", query.Provider?.ExternalId ?? cached?.ExternalId ?? $"work:{key}"),
                ("title", title), ("posterUrl", poster), ("synopsis", overview), ("rating", rating))));
        return LibraryJson.Object(("workKey", key), ("title", title), ("aliases", query.Provider?.Aliases?.Where(x => !x.Equals(title, StringComparison.OrdinalIgnoreCase)).ToArray() ?? []),
            ("provider", identity?.Provider), ("providerId", identity?.ProviderId),
            ("year", year), ("mediaType", type), ("isSeries", isSeries), ("overview", overview), ("rating", rating), ("ratingSource", ratingSource), ("posterUrl", poster), ("backdropUrl", backdrop),
            ("releaseDate", release), ("availability", availability), ("infoHash", best?.Hash), ("downloadFraction", Fraction(best)),
            ("transfer", targets.FirstOrDefault(x => x.Scope == "title") is { } tt ? Transfer(tt, queue) : null),
            ("seasons", seasons), ("season", selected), ("episodes", episodes), ("episodesTruncated", maxEpisode > episodeLimit),
            ("library", library), ("known", cat != null || query.Provider != null || watch != null || local.Count > 0 || releases.Length > 0 || cached != null),
            ("generatedAt", LibraryJson.Iso(DateTime.UtcNow)));
    }
    private static bool MultiSeason(string name) => Regex.IsMatch(name, @"(?i)\bS\d+\s*[-–]\s*S?\d+\b|\bcomplete\s+(?:series|collection)\b");

    /// <summary>
    /// The provider id of a title only its name reaches (a Downloaded rail card, a typed link): the TMDB match the page's
    /// details come from, kept only when TMDB's own record is this title, the same check the title POST applies.
    /// </summary>
    private async Task<TitleIdentity?> FindIdentityAsync(string key, string title, int? year, bool isSeries, CancellationToken ct)
    {
        var kind = isSeries ? "tv" : "movie";
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(IdentityBudget);
        try
        {
            if (await artwork.ResolveIdentityAsync(title, year, kind, budget.Token).WaitAsync(budget.Token) is not { } found) return null;
            var record = await metadata.GetByIdAsync(found.Provider, kind, found.ProviderId, budget.Token).WaitAsync(budget.Token);
            return record != null && TitleIdentity.Matches(key, record) ? TitleIdentity.From(found.Provider, found.ProviderId) : null;
        }
        catch (Exception) when (!ct.IsCancellationRequested) { return null; }
    }
    private static bool InvalidMedia(EngineTorrent row)
    {
        if (row.Progress < .9999 || string.IsNullOrWhiteSpace(row.VerifiedBitfield)) return false;
        var paths = (VerifiedFiles.Read(row.VerifiedFilesJson) ?? []).Select(x => x.Name).OfType<string>().ToArray();
        return paths.Length > 0 && !paths.Any(MediaFileRules.IsVideo);
    }
    private static int? PackSeason(string name)
    {
        if (EpisodeCursor.Parse(name) != null || MultiSeason(name)) return null;
        var match = Regex.Match(name, @"(?i)\b(?:S|Season[ ._-]+)(\d{1,3})\b");
        return match.Success ? int.Parse(match.Groups[1].Value) : null;
    }
    private static Dictionary<int, (EngineTorrent Row, string Path)> PackCoverage(IEnumerable<EngineTorrent> rows, int season)
    {
        var result = new Dictionary<int, (EngineTorrent, string)>();
        foreach (var row in rows.Where(x => PackSeason(x.Name) == season || MultiSeason(x.Name))
            .OrderBy(x => MultiSeason(x.Name)).ThenByDescending(x => x.Progress))
        {
            if (row.Progress < .9999 || string.IsNullOrWhiteSpace(row.VerifiedBitfield)) continue;
            var best = new Dictionary<int, (string Path, long Size)>();
            foreach (var file in VerifiedFiles.Read(row.VerifiedFilesJson) ?? [])
            {
                if (file.Path is not { } path || !Regex.IsMatch(path, @"(?i)\.(?:mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg|vob)$")) continue;
                if (path.Split(['\\', '/']).Any(part => Regex.IsMatch(Regex.Replace(part, "[._-]", " "), @"(?i)\b(?:featurettes?|extras?|specials?|samples?|behind the scenes|animatics?)\b"))) continue;
                var fileName = path.Split(['\\', '/'])[^1];
                if (EpisodeCursor.Parse(fileName) is not { } coordinate || coordinate.Season != season ||
                    Regex.IsMatch(fileName, @"(?i)E\d+\s*(?:-E?|E)\d+")) continue;
                var size = Math.Max(0, file.Size);
                if (!best.TryGetValue(coordinate.Episode, out var current) || size > current.Size) best[coordinate.Episode] = (path, size);
            }
            foreach (var (episode, file) in best) result.TryAdd(episode, (row, file.Path));
        }
        return result;
    }
    /// <summary>A film release's year; episodes carry none.</summary>
    private static int? ReleaseYear(string name) =>
        EpisodeCursor.Parse(name) != null ? null : TorrentFlow.Core.ReleaseNames.ReleaseYear(name);
}
