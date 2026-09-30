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
