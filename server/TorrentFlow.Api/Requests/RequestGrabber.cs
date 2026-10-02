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

    /// <summary>The owner's Retry: what the request still owes, never an episode the owner deleted (see <see cref="RequestGrabber.RetryAsync"/>).</summary>
    Task<RequestGrabOutcome> RetryAsync(MediaRequest request, CancellationToken ct) => GrabAsync(request, ct);

    /// <summary>Queues the aired episodes of a season request that nothing wants yet; returns how many.</summary>
    Task<int> ReconcileAsync(MediaRequest request, CancellationToken ct) => Task.FromResult(0);
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

    public Task<RequestGrabOutcome> GrabAsync(MediaRequest request, CancellationToken ct) => QueueAsync(request, null, ct);

    /// <summary>
    /// Retry looks for what the request still owes: above its mark once it was fulfilled. While other transfers of
    /// the request still run, an episode the owner deleted (downloaded and since removed, or its file gone) is left
    /// alone; a request with nothing left looks for all of it again.
    /// </summary>
    public async Task<RequestGrabOutcome> RetryAsync(MediaRequest request, CancellationToken ct)
    {
        if (request.Scope == MediaRequestScope.Movie) return await QueueAsync(request, null, ct);
        HashSet<(int, int)> settled = [];
        await using (var db = await factory.CreateDbContextAsync(ct))
        {
            if ((await RequestHealth.HealthyAsync(db, RequestHealth.Hashes(request.GrabbedHashes), ct)).Count > 0)
                settled = (await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkKey == request.WorkKey &&
                        t.Scope == "episode" && t.Season != null && t.Episode != null &&
                        (t.Status == "downloaded" || t.Status == "downloading" || t.Status == "failed" && t.Error == TitleService.FileGoneError))
                    .Select(t => new { t.Season, t.Episode }).ToListAsync(ct)).Select(t => (t.Season!.Value, t.Episode!.Value)).ToHashSet();
        }
        return await QueueAsync(request, settled, ct);
    }

    private async Task<RequestGrabOutcome> QueueAsync(MediaRequest request, IReadOnlySet<(int, int)>? skip, CancellationToken ct)
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
        var queued = 0;
        var owed = false;
        foreach (var season in seasons)
        {
            var shape = await seasonShapes.GetSeasonAsync(new(request.WorkKey, request.Title, request.Year, request.MediaType,
                request.Provider, request.ProviderId, season), ct);
            var aired = (shape?.AiredEpisodes ?? []).Where(e => RequestMarks.Counts(marks, season, e)).ToList();
            if (aired.Count == 0) continue;
            owed = true;
            var episodes = skip is null ? aired : aired.Where(e => !skip.Contains((season, e))).ToList();
            if (episodes.Count == 0) continue;
            await wanted.EnqueueAsync(new(request.WorkKey, workId, season, episodes, Lane: TorrentLane.Request), ct);
            queued += episodes.Count;
        }
        // Nothing has aired yet (an upcoming season): approved and waiting; the airing check queues it when it starts.
        return owed ? new([], null, Queued: true) : new([], null, Waiting: true);
    }

    /// <summary>
    /// A season request means the whole season as it airs. Approval queues the episodes aired then; this queues every
    /// episode aired since that no target covers yet, on the same request lane, so status and fulfilment count one set.
    /// Once fulfilled, only episodes above the request's mark count: an episode the owner deleted stays deleted, and a
    /// named season that had not aired then (mark 0) is queued whole once it starts.
    /// </summary>
    public async Task<int> ReconcileAsync(MediaRequest request, CancellationToken ct)
    {
        if (request.Scope == MediaRequestScope.Movie) return 0;
        string? workId;
        HashSet<(int, int)> known;
        await using (var db = await factory.CreateDbContextAsync(ct))
        {
            workId = await db.Works.AsNoTracking().Where(w => w.WorkKey == request.WorkKey).Select(w => w.Id).FirstOrDefaultAsync(ct);
            if (workId is null) return 0;
            known = (await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkKey == request.WorkKey &&
                    t.Scope == "episode" && t.Season != null && t.Episode != null)
                .Select(t => new { t.Season, t.Episode }).ToListAsync(ct)).Select(t => (t.Season!.Value, t.Episode!.Value)).ToHashSet();
        }
        var marks = RequestMarks.Parse(request.FulfilledThrough);
        var queued = 0;
        foreach (var season in await SeasonsAsync(request, ct))
        {
            var shape = await seasonShapes.GetSeasonAsync(new(request.WorkKey, request.Title, request.Year, request.MediaType,
                request.Provider, request.ProviderId, season), ct);
            var missing = (shape?.AiredEpisodes ?? []).Where(e => RequestMarks.Counts(marks, season, e) && !known.Contains((season, e))).ToList();
            if (missing.Count == 0) continue;
            await wanted.EnqueueAsync(new(request.WorkKey, workId, season, missing, Lane: TorrentLane.Request), ct);
            queued += missing.Count;
        }
        return queued;
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
