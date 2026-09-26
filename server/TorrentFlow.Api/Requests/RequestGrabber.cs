using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;
using TorrentFlow.Metadata.Title;

namespace TorrentFlow.Api.Requests;

/// <summary>What one approval started: the transfers to watch, or why nothing started.</summary>
public sealed record RequestGrabOutcome(IReadOnlyList<string> Hashes, string? Problem);

/// <summary>Turns an approved request into downloads; a seam so tests never search indexers.</summary>
public interface IRequestGrabber
{
    Task<RequestGrabOutcome> GrabAsync(MediaRequest request, CancellationToken ct);
}

/// <summary>
/// Uses the owner's own grab path (<see cref="GrabService"/>) on the request lane: one release for a film, one
/// exact release per aired episode for the chosen seasons of a series.
/// </summary>
public sealed class RequestGrabber(GrabService grabs, TitleExtrasService extras, TimeProvider time) : IRequestGrabber
{
    private const int MaxSeriesSeasons = 30;

    public async Task<RequestGrabOutcome> GrabAsync(MediaRequest request, CancellationToken ct)
    {
        var input = new GrabInput(request.Title, request.MediaType, Year: request.Year, WorkKey: request.WorkKey, Lane: TorrentLane.Request);
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
        var hashes = new List<string>();
        string? lastProblem = null;
        foreach (var season in seasons)
        {
            var payload = await Extras(request, season, ct);
            foreach (var episode in payload.Episodes.Where(e => Aired(e.AirDate, today)).Select(e => e.Episode).Distinct().Order())
            {
                var result = await grabs.Grab(input with { Cursor = new EpisodeCursor(season, episode) }, ct);
                if (result.Ok && result.InfoHash is { } hash) { if (!hashes.Contains(hash)) hashes.Add(hash); }
                else lastProblem = result.Message;
            }
        }
        return hashes.Count > 0 ? new(hashes, null) : new([], lastProblem ?? "No aired episodes were found for those seasons.");
    }

    private Task<TitleExtrasPayload> Extras(MediaRequest r, int? season, CancellationToken ct) =>
        extras.GetAsync(new TitleExtrasQuery(r.WorkKey, r.Title, r.Year, r.MediaType, season, r.Provider, r.ProviderId, null, SeriesHint: true), ct);

    private static bool Aired(string? airDate, DateOnly today) =>
        DateOnly.TryParse(airDate?.Length >= 10 ? airDate[..10] : airDate, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out var aired) && aired <= today;
}
