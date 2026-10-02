using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;
using TorrentFlow.Metadata.Title;

namespace TorrentFlow.Api.Requests;

/// <summary>What one approval did: the transfers it started, that it queued the work, or why nothing could be queued.</summary>
/// <param name="Partial">True when some but not all wanted episodes started (storage/cap/miss).</param>
/// <param name="Queued">True when the work went to the wanted queue, which starts and retries it in the background.</param>
public sealed record RequestGrabOutcome(IReadOnlyList<string> Hashes, string? Problem, bool Partial = false, bool Queued = false);

/// <summary>Turns an approved request into downloads; a seam so tests never search indexers.</summary>
public interface IRequestGrabber
{
    Task<RequestGrabOutcome> GrabAsync(MediaRequest request, CancellationToken ct);

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

    public async Task<RequestGrabOutcome> GrabAsync(MediaRequest request, CancellationToken ct)
    {
        var workId = await EnsureWorkAsync(request, ct);
        if (request.Scope == MediaRequestScope.Movie)
        {
            await wanted.EnqueueAsync(new(request.WorkKey, workId, null, [], Lane: TorrentLane.Request), ct);
            return new([], null, Queued: true);
        }

        var seasons = await SeasonsAsync(request, ct);
        if (seasons.Count == 0) return new([], "No seasons were found for this series.");

        var queued = 0;
        foreach (var season in seasons)
        {
            var shape = await seasonShapes.GetSeasonAsync(new(request.WorkKey, request.Title, request.Year, request.MediaType,
                request.Provider, request.ProviderId, season), ct);
            var aired = shape?.AiredEpisodes ?? [];
            if (aired.Count == 0) continue;
            await wanted.EnqueueAsync(new(request.WorkKey, workId, season, aired, Lane: TorrentLane.Request), ct);
            queued += aired.Count;
        }
        return queued == 0 ? new([], "No aired episodes were found for those seasons.") : new([], null, Queued: true);
    }

    /// <summary>
    /// A season request means the whole season as it airs. Approval queues the episodes aired then; this queues every
    /// episode aired since that no target covers yet, on the same request lane, so status and fulfilment count one set.
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
        var queued = 0;
        foreach (var season in await SeasonsAsync(request, ct))
        {
            var shape = await seasonShapes.GetSeasonAsync(new(request.WorkKey, request.Title, request.Year, request.MediaType,
                request.Provider, request.ProviderId, season), ct);
            var have = known.Where(k => k.Item1 == season).Select(k => k.Item2).ToList();
            // A fulfilled request takes only episodes that aired after everything it had, so one the owner deleted stays deleted.
            var missing = request.Status == MediaRequestStatus.Fulfilled
                ? have.Count == 0 ? [] : (shape?.AiredEpisodes ?? []).Where(e => e > have.Max()).ToList()
                : (shape?.AiredEpisodes ?? []).Where(e => !have.Contains(e)).ToList();
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
