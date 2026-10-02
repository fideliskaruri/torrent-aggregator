using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Titles;
using TorrentFlow.Library.Features.Watchlist;
using TorrentFlow.Metadata.Title;

namespace TorrentFlow.Api.Requests;

/// <summary>What one approval did: the transfers it started, that it queued the work, or why nothing could be queued.</summary>
/// <param name="Partial">True when some but not all wanted episodes started (storage/cap/miss).</param>
/// <param name="Queued">True when the work went to the wanted queue, which starts and retries it in the background.</param>
/// <param name="Waiting">True when no asked season has aired yet: approved, and queued by the airing check once it does.</param>
public sealed record RequestGrabOutcome(IReadOnlyList<string> Hashes, string? Problem, bool Partial = false, bool Queued = false, bool Waiting = false);

/// <summary>Turns an approved request into downloads; a seam so tests never search indexers.</summary>
public interface IRequestGrabber
{
    Task<RequestGrabOutcome> GrabAsync(MediaRequest request, CancellationToken ct);

    /// <summary>The owner's Retry: what the request still owes, never an episode the owner removed unless the request
    /// failed because of that removal (<paramref name="removed"/>; see <see cref="RequestGrabber.RetryAsync"/>).</summary>
    Task<RequestGrabOutcome> RetryAsync(MediaRequest request, bool removed, CancellationToken ct) => GrabAsync(request, ct);

    /// <summary>Queues the aired episodes of a season request that nothing wants yet; returns how many. <paramref name="beforeQueue"/>
    /// runs once, before anything is queued, so the request can reopen before a find is reported.</summary>
    Task<int> ReconcileAsync(MediaRequest request, CancellationToken ct, Func<Task>? beforeQueue = null) => Task.FromResult(0);

    /// <summary>Per season (<paramref name="only"/>, else every season in scope), the last episode that had aired by
    /// <paramref name="when"/>, as a mark ("6:3"); null when the title or its seasons could not be read.</summary>
    Task<string?> AiredByAsync(MediaRequest request, DateTime when, IReadOnlyCollection<int>? only, CancellationToken ct) =>
        Task.FromResult<string?>("");
}

/// <summary>
/// Queues an approved request on the owner's own path (<see cref="WantedQueue"/>, on the request lane): the film, or
/// every aired episode of the chosen seasons. Each episode goes through the single-episode grab; the queue keeps retrying
/// what is not found yet; what it starts joins the request through <see cref="RequestWantedObserver"/>.
/// </summary>
public sealed class RequestGrabber(WantedQueue wanted, TitleExtrasService extras, ISeasonShapeLookup seasonShapes, TimeProvider time,
    IDbContextFactory<TorrentFlowDbContext> factory) : IRequestGrabber
{
    private const int MaxSeriesSeasons = 30;

    public Task<RequestGrabOutcome> GrabAsync(MediaRequest request, CancellationToken ct) => QueueAsync(request, fresh: false, ct);

    /// <summary>
    /// Retry looks again only for episodes the request already has a wanted row for, above its mark once fulfilled: rows
    /// still looking, and rows handed back as failed (a stopped transfer). A row whose file the owner removed stays
    /// removed, unless the request failed because of that removal (<paramref name="removed"/>). Retry never adds a row,
    /// so an episode the owner stopped looking for never comes back; newly aired ones are the airing check's. A request
    /// without any row yet (approval found nothing) is grabbed as on approval.
    /// </summary>
    public async Task<RequestGrabOutcome> RetryAsync(MediaRequest request, bool removed, CancellationToken ct)
    {
        if (request.Scope == MediaRequestScope.Movie) return await QueueAsync(request, fresh: false, ct);
        var seasons = await SeasonsAsync(request, ct);
        var marks = RequestMarks.Parse(request.FulfilledThrough);
        List<(int Season, int Episode, string Status, string? Error)> rows;
        await using (var db = await factory.CreateDbContextAsync(ct))
            rows = (await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkKey == request.WorkKey &&
                    t.Scope == "episode" && t.Season != null && t.Episode != null && seasons.Contains(t.Season.Value))
                .Select(t => new { t.Season, t.Episode, t.Status, t.Error }).ToListAsync(ct))
                .Select(t => (t.Season!.Value, t.Episode!.Value, t.Status, t.Error)).ToList();
        if (rows.Count == 0)
        {
            // Nothing was ever wanted (approval found no episodes): grabbed as on approval. A request the owner stopped,
            // or that had a transfer or a fulfilment, never gets rows back here; what the owner stopped stays stopped.
            return string.IsNullOrEmpty(request.GrabbedHashes) && request.FulfilledThrough is null &&
                   !RequestWantedObserver.OwnerStopped(request.DecisionReason)
                ? await QueueAsync(request, fresh: true, ct) : new([], null, Queued: true);
        }
        var workId = await EnsureWorkAsync(request, ct);
        foreach (var season in rows.Where(r => RequestMarks.Counts(marks, r.Season, r.Episode) &&
                     (r.Status == "queued" || r.Status == "failed" && (removed || r.Error != TitleService.FileGoneError)))
                 .GroupBy(r => r.Season))
            await wanted.EnqueueAsync(new(request.WorkKey, workId, season.Key, season.Select(r => r.Episode).ToList(), Lane: TorrentLane.Request), ct);
        return new([], null, Queued: true);
    }

    /// <param name="fresh">A request that never wanted anything: nothing of it can have been stopped, so its covered mark
    /// (an upgrade backfill from air dates) holds nothing back.</param>
    private async Task<RequestGrabOutcome> QueueAsync(MediaRequest request, bool fresh, CancellationToken ct)
    {
        var workId = await EnsureWorkAsync(request, ct);
        if (request.Scope == MediaRequestScope.Movie)
        {
            await wanted.EnqueueAsync(new(request.WorkKey, workId, null, [], Lane: TorrentLane.Request), ct);
            return new([], null, Queued: true);
        }

        var seasons = await SeasonsAsync(request, ct);
        if (seasons.Count == 0) return new([], "No seasons were found for this series.");

        var marks = RequestMarks.Parse(request.FulfilledThrough);
        var known = await KnownEpisodesAsync(request, ct);
        var queued = new List<(int Season, int Episode)>();
        var owed = false;
        var covered = false;
        var upcoming = false;
        foreach (var season in seasons)
        {
            var shape = await seasonShapes.GetSeasonAsync(new(request.WorkKey, request.Title, request.Year, request.MediaType,
                request.Provider, request.ProviderId, season), ct);
            var all = shape?.AiredEpisodes ?? [];
            var aired = all.Where(e => RequestMarks.Counts(marks, season, e)).ToList();
            if (aired.Count == 0)
            {
                // Aired but all within the mark: nothing new to get. Nothing aired: maybe a season still to come.
                if (all.Count > 0) covered = true;
                else upcoming |= await AirsLaterAsync(request, season, ct);
                continue;
            }
            owed = true;
            // Grabbed again (a restart before anything started): what the owner removed or stopped looking for stays so.
            var wantedNow = aired.Where(e => fresh || !Stopped(request, known, season, e)).ToList();
            if (wantedNow.Count == 0) continue;
            await wanted.EnqueueAsync(new(request.WorkKey, workId, season, wantedNow, Lane: TorrentLane.Request), ct);
            queued.AddRange(wantedNow.Select(e => (season, e)));
        }
        // Always written, even empty: a request with a covered mark has been through approval, so it is never backfilled.
        await CoverAsync(request, queued, ct);
        if (owed || covered) return new([], null, Queued: true);
        // Waiting only for a season whose first episode is dated in the future; an aired season whose episodes never
        // resolved fails as before, so the owner gets Retry and Pick a release.
        return upcoming ? new([], null, Waiting: true) : new([], "No aired episodes were found for those seasons.");
    }

    /// <summary>The season is listed with an episode dated after today: it has not started airing yet.</summary>
    private async Task<bool> AirsLaterAsync(MediaRequest request, int season, CancellationToken ct)
    {
        var payload = await Extras(request, season, ct);
        var today = time.GetUtcNow().UtcDateTime.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        return payload.Resolved && payload.Season == season &&
            payload.Episodes.Any(e => e.AirDate is { Length: >= 10 } date && string.CompareOrdinal(date[..10], today) > 0);
    }

    /// <summary>
    /// A season request means the whole season as it airs. Approval queues the episodes aired then; this queues every
    /// episode aired since that no target covers yet, on the same request lane, so status and fulfilment count one set.
    /// Once fulfilled, only episodes above the request's mark count: an episode the owner deleted stays deleted, and a
    /// named season that had not aired then (mark 0) is queued whole once it starts. An episode at or below what the
    /// request already covered whose wanted row is gone was removed or stopped by the owner, and is never queued again.
    /// </summary>
    public async Task<int> ReconcileAsync(MediaRequest request, CancellationToken ct, Func<Task>? beforeQueue = null)
    {
        if (request.Scope == MediaRequestScope.Movie || RequestMarks.AwaitsCover(request)) return 0;
        string? workId;
        await using (var db = await factory.CreateDbContextAsync(ct))
            workId = await db.Works.AsNoTracking().Where(w => w.WorkKey == request.WorkKey).Select(w => w.Id).FirstOrDefaultAsync(ct);
        if (workId is null) return 0;
        var known = await KnownEpisodesAsync(request, ct);
        var marks = RequestMarks.Parse(request.FulfilledThrough);
        var missing = new List<(int Season, List<int> Episodes)>();
        // Every aired episode that already has a wanted row is the request's too, whoever made the row (another ask, the
        // owner's own season download): recorded now, so a later Remove of that row is never undone from this request.
        var seen = new List<(int Season, int Episode)>();
        foreach (var season in await SeasonsAsync(request, ct))
        {
            var shape = await seasonShapes.GetSeasonAsync(new(request.WorkKey, request.Title, request.Year, request.MediaType,
                request.Provider, request.ProviderId, season), ct);
            var aired = shape?.AiredEpisodes ?? [];
            seen.AddRange(aired.Where(e => known.Contains((season, e))).Select(e => (season, e)));
            var episodes = aired.Where(e => RequestMarks.Counts(marks, season, e) && !known.Contains((season, e)) &&
                !Stopped(request, known, season, e)).ToList();
            if (episodes.Count > 0) missing.Add((season, episodes));
        }
        if (missing.Count == 0)
        {
            await CoverAsync(request, seen, ct);
            return 0;
        }
        // The request reopens first, so a find the queue reports at once already has an approved row to join.
        if (beforeQueue != null) await beforeQueue();
        foreach (var (season, episodes) in missing)
            await wanted.EnqueueAsync(new(request.WorkKey, workId, season, episodes, Lane: TorrentLane.Request), ct);
        await CoverAsync(request, seen.Concat(missing.SelectMany(m => m.Episodes.Select(e => (m.Season, e)))), ct);
        return missing.Sum(m => m.Episodes.Count);
    }

    public async Task<string?> AiredByAsync(MediaRequest request, DateTime when, IReadOnlyCollection<int>? only, CancellationToken ct)
    {
        if (request.Scope == MediaRequestScope.Movie) return null;
        var seasons = only?.ToList() ?? await SeasonsAsync(request, ct);
        if (seasons.Count == 0) return null;
        var day = when.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        var marks = new Dictionary<int, int>();
        foreach (var season in seasons)
        {
            var payload = await Extras(request, season, ct);
            if (!payload.Resolved) return null;
            marks[season] = payload.Season != season ? 0 : payload.Episodes
                .Where(e => e.AirDate is { Length: >= 10 } date && string.CompareOrdinal(date[..10], day) <= 0)
                .Select(e => e.Episode).DefaultIfEmpty(0).Max();
        }
        return RequestMarks.Format(marks);
    }

    /// <summary>Every episode of the work that has a wanted row (any status).</summary>
    private async Task<HashSet<(int, int)>> KnownEpisodesAsync(MediaRequest request, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return (await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkKey == request.WorkKey &&
                t.Scope == "episode" && t.Season != null && t.Episode != null)
            .Select(t => new { t.Season, t.Episode }).ToListAsync(ct)).Select(t => (t.Season!.Value, t.Episode!.Value)).ToHashSet();
    }

    /// <summary>
    /// The request covered this episode before (<see cref="MediaRequest.CoveredThrough"/>) and its wanted row is gone: the
    /// owner removed it or stopped looking for it (Remove on a looking row), so it is never brought back.
    /// </summary>
    private static bool Stopped(MediaRequest request, IReadOnlySet<(int, int)> known, int season, int episode) =>
        RequestMarks.Parse(request.CoveredThrough) is { } covered && episode <= covered.GetValueOrDefault(season) && !known.Contains((season, episode));

    /// <summary>
    /// Raises the covered mark of every row that shares this request's ask to <paramref name="episodes"/>, writing only
    /// what changes. Called with nothing, it still gives a row without a mark an empty one: through approval, never backfilled.
    /// </summary>
    private async Task CoverAsync(MediaRequest request, IEnumerable<(int Season, int Episode)> episodes, CancellationToken ct)
    {
        var list = episodes.ToList();
        await using var db = await factory.CreateDbContextAsync(ct);
        var key = RequestRules.SameAskKey(request);
        var rows = (await db.MediaRequests.Where(r => r.WorkKey == request.WorkKey && r.Status != MediaRequestStatus.Cancelled &&
                r.Status != MediaRequestStatus.Declined).ToListAsync(ct))
            .Where(r => r.Id == request.Id || RequestRules.SameAskKey(r) == key).ToList();
        var changed = false;
        foreach (var row in rows)
        {
            var next = RequestMarks.Advance(row.CoveredThrough, list);
            if (next == row.CoveredThrough) continue;
            row.CoveredThrough = next;
            changed = true;
        }
        if (changed) await db.SaveChangesAsync(ct);
        request.CoveredThrough = RequestMarks.Advance(request.CoveredThrough, list);
    }

    private async Task<List<int>> SeasonsAsync(MediaRequest request, CancellationToken ct)
    {
        var seasons = RequestRules.ParseSeasons(request.Seasons).ToList();
        if (request.Scope == MediaRequestScope.Series || seasons.Count == 0)
            seasons = (await Extras(request, null, ct)).Seasons.Where(s => s >= 1).Distinct().Order().Take(MaxSeriesSeasons).ToList();
        return seasons;
    }

    private Task<TitleExtrasPayload> Extras(MediaRequest r, int? season, CancellationToken ct) =>
        extras.GetAsync(new TitleExtrasQuery(r.WorkKey, r.Title, r.Year, r.MediaType, season, r.Provider, r.ProviderId, null, SeriesHint: true), ct);

    private async Task<string> EnsureWorkAsync(MediaRequest request, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var existing = await db.Works.FirstOrDefaultAsync(w => w.WorkKey == request.WorkKey, ct);
        if (existing is not null)
        {
            // The queue searches with the work's identity; a request's provider id brings that provider's aliases.
            if (existing.ProviderId == null && request.ProviderId != null)
            {
                existing.Provider = request.Provider;
                existing.ProviderId = request.ProviderId;
                existing.UpdatedAt = time.GetUtcNow().UtcDateTime;
                await db.SaveChangesAsync(ct);
            }
            return existing.Id;
        }
        var now = time.GetUtcNow().UtcDateTime;
        var work = new Work { Id = Ids.New(), WorkKey = request.WorkKey, CanonicalTitle = request.Title,
            MediaType = request.MediaType, Year = request.Year, PosterUrl = request.PosterUrl, Format = WorkFormats.FromMediaType(request.MediaType),
            Provider = request.Provider, ProviderId = request.ProviderId, CreatedAt = now, UpdatedAt = now };
        db.Works.Add(work);
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException)
        {
            // Another request for the same title may have established its identity first.
            var winner = await db.Works.AsNoTracking().FirstOrDefaultAsync(w => w.WorkKey == request.WorkKey, ct);
            if (winner is null) throw;
            return winner.Id;
        }
        return work.Id;
    }
}
