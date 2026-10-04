using System.Text.Json;
using TorrentFlow.Domain;

namespace TorrentFlow.Api.Catalog;

internal static class CatalogProjection
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    internal static string Title(WorkSnapshot w) => w.Names.FirstOrDefault(n => n.Label == NameLabel.English)?.Value
        ?? w.Names.FirstOrDefault()?.Value ?? w.Work.WorkKey;
    internal static bool Series(WorkSnapshot w) => w.Work.Kind == WorkKind.Series;
    internal static string Type(WorkSnapshot w) => w.Work.Anime == true ? "anime" : Series(w) ? "tv" : "movie";
    internal static string TitleType(WorkSnapshot w) => Series(w) ? Type(w) : "movie";
    internal static string? Format(WorkSnapshot w) => w.Work.Format == WorkFormat.Unknown ? null :
        w.Work.Format.ToString().ToLowerInvariant();
    internal static string? PresentationLanguage(WorkSnapshot w) =>
        w.Work.RatingSource == "anilist" ? null : w.Work.OriginalLanguage;
    internal static WorkLinkRow? Primary(WorkSnapshot w) =>
        w.Links.FirstOrDefault(l => l.IsPrimary && l.Status == LinkStatus.Verified)
        ?? w.Links.FirstOrDefault(l => l.Status == LinkStatus.Verified);
    internal static string? Provider(WorkSnapshot w) => Primary(w)?.Provider is "imdb" ? "cinemeta" : Primary(w)?.Provider;
    internal static string? Release(WorkSnapshot w) =>
        (w.PremiereAt ?? w.Work.TheatricalAt ??
            w.Episodes.Where(e => e.AirAt is not null && w.Seasons.Any(s => s.Id == e.SeasonId && s.Number > 0))
                .MinBy(e => e.AirAt)?.AirAt)?.ToString("yyyy-MM-dd");
    internal static IEnumerable<SeasonRow> TitleSeasons(WorkSnapshot w) =>
        w.Seasons.Where(s => s.Number > 0 && w.Episodes.Any(e => e.SeasonId == s.Id &&
            e.MappingStatus != MappingStatus.Unavailable)).OrderBy(s => s.Number);
    internal static string[] Aliases(WorkSnapshot w) =>
        [.. w.Names.Select(n => n.Value).Where(n => n != Title(w)).Distinct(StringComparer.OrdinalIgnoreCase)];
    internal static string Href(WorkSnapshot w)
    {
        var link = Primary(w);
        return "/title/" + Uri.EscapeDataString(w.Work.WorkKey) + "?t=" + Uri.EscapeDataString(Title(w))
            + "&type=" + TitleType(w) + (w.Work.Year is { } y ? "&y=" + y : "")
            + (link is null ? "" : "&provider=" + Uri.EscapeDataString(Provider(w)!)
                + "&providerId=" + Uri.EscapeDataString(link.ExternalId));
    }
    internal static object Hit(WorkSnapshot w, CatalogCardAction action) => new
    {
        w.Work.WorkKey, title = Title(w), w.Work.Year,
        category = w.Work.Anime == true ? "anime" : Series(w) ? "series" : "movies",
        provider = Provider(w), providerId = Primary(w)?.ExternalId, aliases = Aliases(w),
        mediaType = Type(w), titleMediaType = TitleType(w), isSeries = Series(w), format = w.ProviderFormat,
        w.Work.PosterUrl, overview = w.Work.Synopsis, releaseDate = Release(w), href = Href(w),
        action,
        externalIds = w.Links.Where(l => l.Status == LinkStatus.Verified).DistinctBy(l => l.Provider)
            .ToDictionary(l => l.Provider, l => l.ExternalId),
    };
    internal static object Card(WorkSnapshot w, CatalogCardAction action, bool inCinemas = false) => new
    {
        id = w.Work.Id, workId = w.Work.Id, w.Work.WorkKey, title = Title(w), w.Work.Year,
        subtitle = w.Work.Year?.ToString(System.Globalization.CultureInfo.InvariantCulture),
        w.Work.PosterUrl, w.Work.BackdropUrl, availability = (string?)null,
        infoHash = (string?)null, filePath = (string?)null, watchListItemId = (string?)null, mediaType = TitleType(w),
        href = Href(w), action,
        releaseDate = Release(w), overview = w.Work.Synopsis, season = (int?)null, episode = (int?)null,
        provider = Provider(w), providerId = Primary(w)?.ExternalId,
        inTheatricalWindow = inCinemas,
        nextHomeReleaseAt = inCinemas ? new[] { w.Work.DigitalAt, w.Work.PhysicalAt }
            .OfType<DateTimeOffset>().Order().Cast<DateTimeOffset?>().FirstOrDefault()?.ToString("yyyy-MM-dd") : null,
    };
    internal static object AddPayload(WorkSnapshot w, string key) => new
    {
        mediaType = TitleType(w), externalId = Primary(w)?.ExternalId ?? "work:" + key, title = Title(w),
        w.Work.PosterUrl, synopsis = w.Work.Synopsis, w.Work.Rating, workKey = key,
        provider = Provider(w), providerId = Primary(w)?.ExternalId, format = w.Work.Format.ToString(),
    };
    internal static object Watch(WatchItemRow item, WorkSnapshot w, bool ready, FollowRow? follow = null,
        WorkPreferenceRow? preference = null) => new
    {
        item.Id, item.UserId, workId = item.WorkId, w.Work.WorkKey, mediaType = TitleType(w),
        externalId = Primary(w)?.ExternalId ?? "work:" + w.Work.WorkKey, provider = Provider(w) ?? "",
        title = Title(w), w.Work.PosterUrl, synopsis = w.Work.Synopsis, w.Work.Rating,
        status = item.Status.ToString().ToLowerInvariant(), monitored = follow?.Enabled ?? false,
        lastChecked = item.UpdatedAt, nextCheckAt = (string?)null, nextCheckReason = (string?)null,
        lastEpisode = (string?)null, fromSeason = Coordinate(w, follow)?.Season, fromEpisode = Coordinate(w, follow)?.Episode,
        cursorSeason = Coordinate(w, follow)?.Season, cursorEpisode = Coordinate(w, follow)?.Episode, cursorMisses = 0,
        monitorMode = follow is { NewEpisodesSince: var since } && since > DateTimeOffset.UnixEpoch ? "new" : "ongoing",
        newEpisodesSince = follow is { NewEpisodesSince: var date } && date > DateTimeOffset.UnixEpoch ? (DateTimeOffset?)date : null,
        latestReleaseTitle = (string?)null, latestReleaseAt = (string?)null,
        latestReleaseMagnet = (string?)null, nextEpisodeHint = (string?)null, item.CreatedAt, item.UpdatedAt,
        seederWaitSince = (string?)null, preferredResolution = preference?.PreferredResolution, ready,
    };
    internal static EpisodeCoordinate? Coordinate(WorkSnapshot w, FollowRow? follow)
    {
        var episode = w.Episodes.FirstOrDefault(e => e.Id == follow?.FromEpisodeId);
        var season = w.Seasons.FirstOrDefault(s => s.Id == episode?.SeasonId);
        return episode is not null && season is not null ? new(season.Number, episode.Number, episode.AbsoluteNumber) : null;
    }
}
