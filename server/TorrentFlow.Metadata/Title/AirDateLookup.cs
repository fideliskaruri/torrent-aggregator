using System.Globalization;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Title;

public sealed class AirDateLookup(TitleExtrasService extras, AniListClient anilist) : IAirDateLookup
{
    public async Task<DateTime?> GetAirDateAsync(string title, string mediaType, string externalId, int season, int episode, CancellationToken ct)
    {
        var provider = Provider(mediaType, externalId);
        // One AniList id is one season, so its airing schedule answers season 1 of that entry exactly.
        if (provider == "anilist" && season == 1 && int.TryParse(externalId, NumberStyles.None, CultureInfo.InvariantCulture, out var id) &&
            await anilist.GetEpisodeAiringAsync(id, episode, ct).ConfigureAwait(false) is { } airs)
            return airs;
        var payload = await Extras(title, mediaType, externalId, provider, season, ct).ConfigureAwait(false);
        return Parse(payload.Episodes.FirstOrDefault(x => x.Episode == episode)?.AirDate);
    }

    /// <summary>
    /// Walks seasons from the newest back until one has already started airing, so a show between seasons answers
    /// with the next season premiere. An undated episode ahead of the aired ones makes the answer unknown.
    /// </summary>
    public async Task<NewEpisodeLookup> GetFirstEpisodeAfterAsync(string title, string mediaType, string externalId, DateTime after, CancellationToken ct)
    {
        after = DateTime.SpecifyKind(after, DateTimeKind.Utc);
        var provider = Provider(mediaType, externalId);
        if (provider == "anilist" && int.TryParse(externalId, NumberStyles.None, CultureInfo.InvariantCulture, out var id))
        {
            var (answered, airing) = await anilist.GetFirstAiringAfterAsync(id, after, ct).ConfigureAwait(false);
            if (!answered) return NewEpisodeLookup.Unknown;
            return airing is null ? NewEpisodeLookup.NoneAnnounced : NewEpisodeLookup.Found(1, airing.Episode, airing.AiringAt);
        }
        var overview = await Extras(title, mediaType, externalId, provider, null, ct).ConfigureAwait(false);
        if (overview.Seasons.Count == 0) return NewEpisodeLookup.Unknown;
        var result = NewEpisodeLookup.NoneAnnounced;
        foreach (var season in overview.Seasons.Where(s => s >= 1).OrderDescending())
        {
            var payload = overview.Season == season ? overview : await Extras(title, mediaType, externalId, provider, season, ct).ConfigureAwait(false);
            if (payload.Episodes.Count == 0) { result = NewEpisodeLookup.Unknown; continue; }
            NewEpisodeLookup? first = null;
            var started = false;
            foreach (var episode in payload.Episodes.Where(e => e.Episode >= 1).OrderBy(e => e.Episode))
            {
                var (airs, dateOnly) = When(episode);
                var aired = airs is { } at && (dateOnly ? at < after.Date : at <= after);
                if (aired) { started = true; first = null; }
                else first ??= airs is { } next ? NewEpisodeLookup.Found(season, episode.Episode, next) : NewEpisodeLookup.Unknown;
            }
            if (first != null) result = first;
            if (started) break;
        }
        return result;
    }

    /// <summary>
    /// Fails closed: finished only when every listed episode has a past air date, the numbers run 1..N with no gap,
    /// and the provider announces nothing further for this season (a later season exists, or nothing airs after now).
    /// </summary>
    public async Task<bool?> SeasonFinishedAsync(string title, string mediaType, string externalId, int season, DateTime now, CancellationToken ct)
    {
        now = DateTime.SpecifyKind(now, DateTimeKind.Utc);
        var provider = Provider(mediaType, externalId);
        if (provider == null) return null;
        var anilistId = 0;
        // One AniList id is one season; any other season number on an AniList id cannot be proven.
        if (provider == "anilist" && (season != 1 || !int.TryParse(externalId, NumberStyles.None, CultureInfo.InvariantCulture, out anilistId))) return null;
        if (provider == "anilist")
        {
            // AniList states it directly: FINISHED with an episode count, and nothing on the airing schedule after now.
            var work = await anilist.GetWorkByIdAsync(externalId, ct).ConfigureAwait(false);
            if (work?.Status is "RELEASING" or "NOT_YET_RELEASED") return false;
            if (work is not { Status: "FINISHED", EpisodeCount: > 0 }) return null;
            var (answered, airing) = await anilist.GetFirstAiringAfterAsync(anilistId, now, ct).ConfigureAwait(false);
            return !answered ? null : airing is null;
        }
        var payload = await Extras(title, mediaType, externalId, provider, season, ct).ConfigureAwait(false);
        var episodes = payload.Episodes.Where(e => e.Episode >= 1).OrderBy(e => e.Episode).ToList();
        if (episodes.Count == 0 || episodes.Select(e => e.Episode).Distinct().Count() != episodes.Count || episodes[^1].Episode != episodes.Count) return null;
        foreach (var episode in episodes)
        {
            var (airs, dateOnly) = When(episode);
            if (airs is not { } at) return null;
            if (dateOnly ? at >= now.Date : at > now) return false;
        }
        if (payload.AiredEpisodes.TryGetValue(season, out var aired) && aired != episodes.Count) return null;
        if (payload.Seasons.Any(s => s > season)) return true;
        var next = await GetFirstEpisodeAfterAsync(title, mediaType, externalId, now, ct).ConfigureAwait(false);
        return next.Status switch { NewEpisodeStatus.NoneAnnounced => true, NewEpisodeStatus.Found => next.Season > season ? true : false, _ => null };
    }

    // Numeric watchlist ids are TMDB for TV and AniList for anime; keyless titles use slugs.
    private static string? Provider(string mediaType, string externalId) =>
        externalId.Length > 0 && externalId.All(char.IsAsciiDigit) ? mediaType == "anime" ? "anilist" : "tmdb" : null;

    private Task<TitleExtrasPayload> Extras(string title, string mediaType, string externalId, string? provider, int? season, CancellationToken ct) =>
        extras.GetAsync(new(externalId, title, null, mediaType, season, provider, provider == null ? null : externalId, null, true), ct);

    private static (DateTime? At, bool DateOnly) When(TitleEpisodeMeta episode) =>
        Parse(episode.AirStamp) is { } stamp ? (stamp, false) : (Parse(episode.AirDate), true);

    public static DateTime? Parse(string? value) =>
        DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)
            ? parsed.UtcDateTime : null;
}
