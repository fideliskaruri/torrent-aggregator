using System.Globalization;
using TorrentFlow.Core.Contracts.Metadata;

namespace TorrentFlow.Metadata.Title;

public sealed class AirDateLookup(TitleExtrasService extras) : IAirDateLookup
{
    public async Task<DateTime?> GetAirDateAsync(string title, string mediaType, string externalId, int season, int episode, CancellationToken ct)
    {
        // Numeric watchlist ids are TMDB for TV and AniList for anime; keyless titles use slugs.
        var provider = externalId.Length > 0 && externalId.All(char.IsAsciiDigit)
            ? mediaType == "anime" ? "anilist" : "tmdb" : null;
        var payload = await extras.GetAsync(new(externalId, title, null, mediaType, season, provider,
            provider == null ? null : externalId, null, true), ct);
        return Parse(payload.Episodes.FirstOrDefault(x => x.Episode == episode)?.AirDate);
    }

    public static DateTime? Parse(string? value) =>
        DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)
            ? parsed.UtcDateTime : null;
}
