using System.Globalization;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Title;

public sealed class AirDateLookup(TitleExtrasService extras, AniListClient anilist, AnimeFranchiseService franchises) : IAirDateLookup
{
    public async Task<DateTime?> GetAirDateAsync(string title, string mediaType, string externalId, int season, int episode, CancellationToken ct)
    {
        var provider = Provider(mediaType, externalId);
        // One AniList id is one entry, so its airing schedule answers the entry's own episodes exactly: the page's episode
        // is asked by its number in the entry (a later cour's Season 1 episode 13 is its episode 1).
        if (provider == "anilist" && int.TryParse(externalId, NumberStyles.None, CultureInfo.InvariantCulture, out var id) &&
            await EntryEpisodeAsync(title, mediaType, externalId, season, episode, ct).ConfigureAwait(false) is { } own &&
            await anilist.GetEpisodeAiringAsync(id, own, ct).ConfigureAwait(false) is { } airs)
            return airs;
        var payload = await Extras(title, mediaType, externalId, provider, season, ct).ConfigureAwait(false);
        return Parse(payload.Episodes.FirstOrDefault(x => x.Episode == episode)?.AirDate);
    }

    /// <summary>
    /// Walks seasons from the newest back until one has already started airing, so a show between seasons answers
    /// with the next season premiere. An undated episode ahead of the aired ones makes the answer unknown. An AniList
    /// entry answers from its airing schedule, as its page numbers the episode (<see cref="PageEpisodeAsync"/>).
    /// </summary>
    public async Task<NewEpisodeLookup> GetFirstEpisodeAfterAsync(string title, string mediaType, string externalId, DateTime after, CancellationToken ct)
    {
        after = DateTime.SpecifyKind(after, DateTimeKind.Utc);
        var provider = Provider(mediaType, externalId);
        if (provider == "anilist" && int.TryParse(externalId, NumberStyles.None, CultureInfo.InvariantCulture, out var id))
        {
            var (answered, airing) = await anilist.GetFirstAiringAfterAsync(id, after, ct).ConfigureAwait(false);
            if (!answered) return NewEpisodeLookup.Unknown;
            if (airing is null) return NewEpisodeLookup.NoneAnnounced;
            return await PageEpisodeAsync(title, mediaType, externalId, airing.Episode, ct).ConfigureAwait(false) is { } shown
                ? NewEpisodeLookup.Found(shown.Season, shown.Episode, airing.AiringAt) : NewEpisodeLookup.Unknown;
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

    /// <summary>
    /// Where a later entry's page lists the entry's own episode <paramref name="own"/> (Bleach: Thousand-Year Blood War -
    /// The Calamity's 9th is Season 1 episode 48 of its show); Season 1 episode <paramref name="own"/> for a first season or
    /// an entry in no chain, as its page numbers it. Null while the franchise is not confirmed, or does not list it yet:
    /// a cursor is never pinned to the entry's own number on a page that numbers its show.
    /// </summary>
    private async Task<(int Season, int Episode)?> PageEpisodeAsync(string title, string mediaType, string externalId, int own, CancellationToken ct)
    {
        var (view, failed) = await franchises.LookupAsync(new(title, null, mediaType, "anilist", externalId), ct).ConfigureAwait(false);
        if (failed || view is { Provisional: true }) return null;
        if (view is not { Chained: true, Show: not null }) return (1, own);
        return view.Episodes.FirstOrDefault(e => e.AniListId == externalId && e.AniListEpisode == own) is { } listed ? (listed.Season, listed.Episode) : null;
    }

    /// <summary>
    /// The entry's own number (its airing schedule's) of the page's <paramref name="season"/> and <paramref name="episode"/>:
    /// the episode a later entry's page lists there, or the Season 1 episode of a first season or an entry in no chain.
    /// Null while the franchise is not confirmed, or for an episode the entry does not have.
    /// </summary>
    private async Task<int?> EntryEpisodeAsync(string title, string mediaType, string externalId, int season, int episode, CancellationToken ct)
    {
        var (view, failed) = await franchises.LookupAsync(new(title, null, mediaType, "anilist", externalId), ct).ConfigureAwait(false);
        if (failed || view is { Provisional: true }) return null;
        if (view is not { Chained: true, Show: not null }) return season == 1 ? episode : null;
        return view.Episodes.FirstOrDefault(e => e.Season == season && e.Episode == episode && e.AniListId == externalId)?.AniListEpisode;
    }

    private Task<TitleExtrasPayload> Extras(string title, string mediaType, string externalId, string? provider, int? season, CancellationToken ct) =>
        extras.GetAsync(new(externalId, title, null, mediaType, season, provider, provider == null ? null : externalId, null, true), ct);

    private static (DateTime? At, bool DateOnly) When(TitleEpisodeMeta episode) =>
        Parse(episode.AirStamp) is { } stamp ? (stamp, false) : (Parse(episode.AirDate), true);

    public static DateTime? Parse(string? value) =>
        DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)
            ? parsed.UtcDateTime : null;
}
