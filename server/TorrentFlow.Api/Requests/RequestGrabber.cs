using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;
using TorrentFlow.Metadata.Title;

namespace TorrentFlow.Api.Requests;

/// <summary>What one approval started: the transfers to watch, or why nothing started.</summary>
/// <param name="Partial">True when some but not all wanted episodes started (storage/cap/miss).</param>
public sealed record RequestGrabOutcome(IReadOnlyList<string> Hashes, string? Problem, bool Partial = false);

/// <summary>Turns an approved request into downloads; a seam so tests never search indexers.</summary>
public interface IRequestGrabber
{
    Task<RequestGrabOutcome> GrabAsync(MediaRequest request, CancellationToken ct);
}

/// <summary>
/// Uses the owner's own grab path (<see cref="GrabService"/>) on the request lane: one release for a film, one
/// exact release per aired episode for the chosen seasons of a series.
/// </summary>
public sealed class RequestGrabber(GrabService grabs, TitleExtrasService extras, TimeProvider time,
    IDbContextFactory<TorrentFlowDbContext> factory) : IRequestGrabber
{
    private const int MaxSeriesSeasons = 30;

    public async Task<RequestGrabOutcome> GrabAsync(MediaRequest request, CancellationToken ct)
    {
        var workId = await EnsureWorkAsync(request, ct);
        var input = new GrabInput(request.Title, request.MediaType, WorkId: workId,
            Year: request.Year, WorkKey: request.WorkKey, Lane: TorrentLane.Request, Provider: request.Provider, ProviderId: request.ProviderId);
        if (request.Scope == MediaRequestScope.Movie)
        {
            var film = await grabs.Grab(input, ct);
            return film.Ok && film.InfoHash is { } hash ? new([hash], null) : new([], film.Message);
        }

        var seasons = RequestRules.ParseSeasons(request.Seasons);
        if (request.Scope == MediaRequestScope.Series || seasons.Count == 0)
            seasons = (await Extras(request, null, ct)).Seasons.Where(s => s >= 1).Distinct().Order().Take(MaxSeriesSeasons).ToList();
        if (seasons.Count == 0) return new([], "No seasons were found for this series.");

        var today = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);
        await using var read = await factory.CreateDbContextAsync(ct);
        var existing = await read.EngineTorrents.AsNoTracking().Where(t => t.UserId == LocalUser.Id &&
            t.WorkId == workId && t.Origin == TorrentOrigin.User && t.Status != EngineTorrentStatus.Error &&
            t.Status != EngineTorrentStatus.Removed && t.QueueKey != null)
            .Select(t => new { t.Hash, t.QueueKey }).ToListAsync(ct);
        var byEpisode = existing.GroupBy(t => t.QueueKey!).ToDictionary(g => g.Key, g => g.First().Hash);
        var hashes = new List<string>();
        string? lastProblem = null;
        var wanted = 0;
        var failed = 0;
        foreach (var season in seasons)
        {
            var payload = await Extras(request, season, ct);
            var aired = payload.Episodes.Where(e => Aired(e.AirDate, today) ||
                request.Provider == "anilist" && e.AirDate == null && e.HasAired == true).Select(e => e.Episode).ToList();
            wanted += aired.Count;
            var result = await SeasonFanout.Run(aired,
                (episode, before) => byEpisode.TryGetValue(new EpisodeCursor(season, episode).QueueKey, out var existingHash)
                    ? Task.FromResult(new GrabResult(true, "Already started") { InfoHash = existingHash })
                    : grabs.Grab(input with { Cursor = new EpisodeCursor(season, episode) }, ct, before), ct);
            foreach (var transfer in result.Transfers)
            {
                if (transfer.InfoHash is { } hash) { if (!hashes.Contains(hash)) hashes.Add(hash); }
                else { failed++; lastProblem = transfer.Error; }
            }
        }
        if (hashes.Count == 0)
            return new([], lastProblem ?? "No aired episodes were found for those seasons.");
        // Some episodes started but others failed (storage, no release): report honestly instead of a silent full approve.
        if (wanted > 0 && (failed > 0 || hashes.Count < wanted))
        {
            var reason = lastProblem is { Length: > 0 }
                ? $"Only {hashes.Count} of {wanted} episodes could be started. {lastProblem}"
                : $"Only {hashes.Count} of {wanted} episodes could be started.";
            return new(hashes, reason, Partial: true);
        }
        return new(hashes, null);
    }

    private Task<TitleExtrasPayload> Extras(MediaRequest r, int? season, CancellationToken ct) =>
        extras.GetAsync(new TitleExtrasQuery(r.WorkKey, r.Title, r.Year, r.MediaType, season, r.Provider, r.ProviderId, null, SeriesHint: true), ct);

    private async Task<string> EnsureWorkAsync(MediaRequest request, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var existing = await db.Works.AsNoTracking().FirstOrDefaultAsync(w => w.WorkKey == request.WorkKey, ct);
        if (existing is not null) return existing.Id;
        var now = time.GetUtcNow().UtcDateTime;
        var work = new Work { Id = Ids.New(), WorkKey = request.WorkKey, CanonicalTitle = request.Title,
            MediaType = request.MediaType, Year = request.Year, PosterUrl = request.PosterUrl,
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

    private static bool Aired(string? airDate, DateOnly today) =>
        DateOnly.TryParse(airDate?.Length >= 10 ? airDate[..10] : airDate, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out var aired) && aired <= today;
}
