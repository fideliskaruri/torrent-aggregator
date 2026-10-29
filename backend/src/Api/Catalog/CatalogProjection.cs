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
        WorkPreferenceRow? preference = null, IEnumerable<TargetRow>? workTargets = null,
        IEnumerable<OwnedItem>? ownedItems = null)
    {
        var now = DateTimeOffset.UtcNow;
        var targets = (workTargets ?? []).Where(t => t.Kind == TargetKind.Acquire &&
            t.State is not (TargetState.Removed or TargetState.Done)).ToArray();
        var owned = (ownedItems ?? []).ToArray();
        bool HasCopy(TargetRow target) => target.State == TargetState.Waiting &&
            (target.ChosenReleaseHash is not null ||
             target.ReasonCode is WaitReason.DownloadCap or WaitReason.FileBusy or WaitReason.NoDriveSpace or
                 WaitReason.DriveOffline or WaitReason.PlacementBlocked or WaitReason.WaitingForSeeders);
        var storageWait = targets.Where(target => target.State == TargetState.Waiting &&
                target.ReasonCode is WaitReason.DriveOffline or WaitReason.NoDriveSpace or WaitReason.PlacementBlocked)
            .OrderByDescending(target => target.UpdatedAt).FirstOrDefault();
        var downloading = targets.Any(t => t.State is TargetState.Fetching or TargetState.Filing || HasCopy(t));
        var lookingTargets = targets.Where(t =>
            (t.State is TargetState.Wanted or TargetState.Searching) &&
            !HasCopy(t) && t.ReasonCode != WaitReason.PlacementBlocked &&
            (t.ExpectedAt is null || t.ExpectedAt <= now)).ToArray();
        var hasFiles = ready;
        var libraryState = storageWait?.ReasonCode switch
        {
            WaitReason.DriveOffline => "waiting_drive",
            WaitReason.NoDriveSpace => "no_space",
            WaitReason.PlacementBlocked => "needs_you",
            _ => downloading ? "downloading" : lookingTargets.Length > 0 ? "looking" :
            hasFiles ? "downloaded" : follow?.Enabled == true || targets.Any(t => t.ExpectedAt > now)
                ? "coming_up" : "idle",
        };
        var airedEpisodes = Series(w)
            ? w.Episodes.Count(e => e.MappingStatus == MappingStatus.Confirmed &&
                e.AirAt is { } air && air <= now && w.Seasons.Any(s => s.Id == e.SeasonId && s.Number >= 1))
            : 0;
        var ownedEpisodes = Series(w) ? owned.Where(o => o.EpisodeId is not null)
            .Select(o => o.EpisodeId).Distinct(StringComparer.Ordinal).Count() : 0;
        var activeEpisodes = Series(w) ? targets.Count(t => t.EpisodeId is not null) : 0;
        var nextReleaseAt = NextReleaseAt(w, now);
        var latestLooking = lookingTargets.OrderByDescending(t => t.UpdatedAt).FirstOrDefault();
        var earliestLooking = lookingTargets.Length == 0 ? (DateTimeOffset?)null :
            lookingTargets.Min(t => t.CreatedAt);
        return new
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
        libraryState, hasFiles,
        ownedEpisodes = Series(w) ? (int?)ownedEpisodes : null,
        airedEpisodes = Series(w) ? (int?)airedEpisodes : null,
        activeEpisodes, nextReleaseAt,
        lookingReason = latestLooking?.ReasonText, lookingSince = earliestLooking,
        libraryReason = storageWait?.ReasonText,
        };
    }
    private static string? NextReleaseAt(WorkSnapshot w, DateTimeOffset now)
    {
        DateTimeOffset? release = Series(w)
            ? w.Episodes.Where(e => e.AirAt > now && w.Seasons.Any(s => s.Id == e.SeasonId && s.Number >= 1))
                .MinBy(e => e.AirAt)?.AirAt
            : new[] { w.Work.DigitalAt, w.Work.PhysicalAt }.OfType<DateTimeOffset>()
                .Where(at => at > now).Order().Cast<DateTimeOffset?>().FirstOrDefault()
                ?? new[] { w.Work.TheatricalAt, w.PremiereAt }.OfType<DateTimeOffset>()
                    .Where(at => at > now).Order().Cast<DateTimeOffset?>().FirstOrDefault();
        return release?.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
    }
    internal static EpisodeCoordinate? Coordinate(WorkSnapshot w, FollowRow? follow)
    {
        var episode = w.Episodes.FirstOrDefault(e => e.Id == follow?.FromEpisodeId);
        var season = w.Seasons.FirstOrDefault(s => s.Id == episode?.SeasonId);
        return episode is not null && season is not null ? new(season.Number, episode.Number, episode.AbsoluteNumber) : null;
    }
}
