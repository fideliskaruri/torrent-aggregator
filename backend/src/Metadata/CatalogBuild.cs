using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed partial class Catalog
{
    private async Task<MetadataResult> BuildAsync(ProviderId identity, bool refresh, CancellationToken ct)
    {
        var priorLinks = await LinksAsync(ct);
        var known = priorLinks.FirstOrDefault(l => l.Status == LinkStatus.Verified && SameId(l, identity));
        if (!refresh && known is not null)
        {
            var knownWork = await SnapshotAsync(known.WorkId, ct);
            if (knownWork is not null && (identity.ProviderKind is null ||
                knownWork.Work.Kind == (identity.ProviderKind is "tv" or "series" ? WorkKind.Series : WorkKind.Film))
                && !HasProviderConflict(knownWork) && CurrentPresentation(knownWork) && knownWork.Work.RefreshedAt > DateTimeOffset.UtcNow.AddHours(-1)
                && (knownWork.Work.Kind == WorkKind.Film || !knownWork.Seasons.IsEmpty)
                && knownWork.Seasons.All(s => s.MappingStatus == MappingStatus.Confirmed))
                return new(await WithPremiereAsync(knownWork, ct), null, true, false);
        }
        await map.LoadAsync(ct);
        if (map.Version == "none" && identity.Provider is "anilist" or "mal" or "tvdb")
            await map.RefreshAsync(DateTimeOffset.UtcNow, ct);
        else if (identity.Provider is "anilist" or "mal" or "tvdb") map.RefreshInBackground();
        var mapped = AllowedMap(map.Find(identity));
        if (identity.Provider == "tvdb")
        {
            if (mapped.FirstOrDefault(e => e.AniList is not null)?.AniList is { } ani)
                return await BuildAsync(new("anilist", ani.ToString(), null), refresh, ct);
            var lookup = await cinemeta.TvmazeAsync("/lookup/shows?thetvdb=" + identity.ExternalId, ct);
            if (lookup.Json?.Text("id") is { } mazeId)
                return await BuildAsync(new("tvmaze", mazeId, null), refresh, ct);
            return FromAnswer(lookup);
        }
        var builder = new WorkBuilder(identity);
        builder.RejectedAnimeIds.UnionWith(priorLinks.Where(l => l.WorkId == known?.WorkId &&
            l.Provider == "anilist" && l.Status == LinkStatus.Rejected).Select(l => l.ExternalId));
        ProviderAnswer answer;
        if (identity.Provider is "anilist" or "mal")
        {
            var aniId = identity.Provider == "anilist" ? identity.ExternalId : mapped.FirstOrDefault()?.AniList?.ToString();
            if (aniId is null) return Missing("mapping_unavailable", "This anime has no verified catalog link yet.", false);
            answer = await anilist.DetailAsync(aniId, ct, refresh);
            if (answer.Json?.Obj("data").Obj("Media") is not { ValueKind: JsonValueKind.Object } media)
                return FromAnswer(answer);
            MapAnime(builder, media);
            mapped = AllowedMap(map.Find(new("anilist", aniId, null)));
            ApplyMap(builder, mapped, map);
            if (builder.Work.Kind == WorkKind.Series &&
                mapped.SelectMany(e => e.Imdb).FirstOrDefault() is { } imdb)
            {
                var listing = await cinemeta.DetailAsync(imdb, WorkKind.Series, ct, refresh);
                if (listing.Json?.Obj("meta") is { ValueKind: JsonValueKind.Object } show)
                {
                    var animeWork = builder.Work;
                    MapCinemeta(builder, show, WorkKind.Series);
                    builder.Work = builder.Work with { Anime = true, Format = animeWork.Format,
                        RuntimeMinutes = animeWork.RuntimeMinutes ?? builder.Work.RuntimeMinutes,
                        Year = animeWork.Year, ProviderStatus = animeWork.ProviderStatus,
                        Synopsis = animeWork.Synopsis, Rating = animeWork.Rating, RatingSource = animeWork.RatingSource,
                        Genres = animeWork.Genres, PosterUrl = animeWork.PosterUrl, BackdropUrl = animeWork.BackdropUrl };
                }
                else builder.Complete = false;
            }
            if (await tmdb.EnabledAsync(ct) && builder.Links.FirstOrDefault(l => l.Provider == "tmdb") is { } linked &&
                CanUseListing(new("tmdb", linked.ExternalId, JsonFacts.Kind(builder.Work.Kind))))
            {
                var detail = await tmdb.DetailAsync(linked.ExternalId, builder.Work.Kind, ct, refresh);
                if (detail.Json is { ValueKind: JsonValueKind.Object } row)
                {
                    var animeWork = builder.Work;
                    MapTmdb(builder, row, builder.Work.Kind);
                    if (builder.Work.Kind == WorkKind.Series)
                        await TmdbSeasonsAsync(builder, row, refresh, ct);
                    builder.Work = builder.Work with { Anime = true, Format = animeWork.Format,
                        RuntimeMinutes = animeWork.RuntimeMinutes ?? builder.Work.RuntimeMinutes,
                        Synopsis = animeWork.Synopsis, Rating = animeWork.Rating, RatingSource = animeWork.RatingSource,
                        Genres = animeWork.Genres, PosterUrl = animeWork.PosterUrl, BackdropUrl = animeWork.BackdropUrl };
                }
            }
            if (builder.Work.Kind == WorkKind.Series)
                await animeSeasons.BuildAsync(builder, media, refresh, ct);
        }
        else if (identity.Provider == "tmdb")
        {
            var kind = identity.ProviderKind is "tv" or "series" ? WorkKind.Series : WorkKind.Film;
            answer = await tmdb.DetailAsync(identity.ExternalId, kind, ct, refresh);
            if (answer.Json is not { ValueKind: JsonValueKind.Object } detail) return FromAnswer(answer);
            MapTmdb(builder, detail, kind);
            if (builder.Work.Anime == true && map.Version == "none")
            {
                await map.RefreshAsync(DateTimeOffset.UtcNow, ct);
                mapped = AllowedMap(map.Find(identity));
            }
            else if (builder.Work.Anime == true) map.RefreshInBackground();
            ApplyMap(builder, mapped, map);
            if (kind == WorkKind.Series) await TmdbSeasonsAsync(builder, detail, refresh, ct);
            if (builder.Work.Anime == true && mapped.FirstOrDefault(e => e.AniList is not null)?.AniList is { } animeId)
            {
                var anime = await anilist.DetailAsync(animeId.ToString(), ct, refresh);
                if (anime.Json?.Obj("data").Obj("Media") is { ValueKind: JsonValueKind.Object } media)
                {
                    MapAnime(builder, media, overlay: true);
                    if (kind == WorkKind.Series) await animeSeasons.BuildAsync(builder, media, refresh, ct);
                }
                else builder.Complete = false;
            }
        }
        else if (identity.Provider is "imdb" or "cinemeta")
        {
            var kind = identity.ProviderKind is "tv" or "series" ? WorkKind.Series : WorkKind.Film;
            answer = await cinemeta.DetailAsync(identity.ExternalId, kind, ct, refresh);
            if (answer.Json?.Obj("meta") is not { ValueKind: JsonValueKind.Object } detail) return FromAnswer(answer);
            MapCinemeta(builder, detail, kind);
            if (builder.Work.Anime == true && map.Version == "none")
            {
                await map.RefreshAsync(DateTimeOffset.UtcNow, ct);
                mapped = AllowedMap(map.Find(identity));
            }
            else if (builder.Work.Anime == true) map.RefreshInBackground();
            ApplyMap(builder, mapped, map);
            var imdbNames = await cinemeta.NamesAsync(identity.ExternalId, ct);
            if (imdbNames.Json?.Obj("data").Obj("title") is { ValueKind: JsonValueKind.Object } names)
            {
                var link = builder.Links.First(l => l.Provider == "imdb").Id;
                builder.Name(names.Obj("titleText").Text("text"), NameLabel.English, link);
                builder.Name(names.Obj("originalTitleText").Text("text"), NameLabel.Original, link);
                foreach (var name in names.Obj("akas").Obj("edges").Items())
                    builder.Name(name.Obj("node").Text("text"), NameLabel.Synonym, link);
            }
            if (await tmdb.EnabledAsync(ct) && builder.Links.FirstOrDefault(l => l.Provider == "tmdb") is { } linked &&
                CanUseListing(new("tmdb", linked.ExternalId, JsonFacts.Kind(kind))))
            {
                var tmdbAnswer = await tmdb.DetailAsync(linked.ExternalId, kind, ct, refresh);
                if (tmdbAnswer.Json is { ValueKind: JsonValueKind.Object } row)
                {
                    MapTmdb(builder, row, kind);
                    if (kind == WorkKind.Series) await TmdbSeasonsAsync(builder, row, refresh, ct);
                }
                else builder.Complete = false;
            }
            if (kind == WorkKind.Series && builder.Episodes.Count == 0)
                await TvmazeEpisodesAsync(builder, identity.ExternalId, ct);
            if (builder.Work.Anime == true && mapped.FirstOrDefault(e => e.AniList is not null)?.AniList is { } animeId)
            {
                var anime = await anilist.DetailAsync(animeId.ToString(), ct, refresh);
                if (anime.Json?.Obj("data").Obj("Media") is { ValueKind: JsonValueKind.Object } media)
                {
                    MapAnime(builder, media, overlay: true);
                    if (kind == WorkKind.Series) await animeSeasons.BuildAsync(builder, media, refresh, ct);
                }
                else builder.Complete = false;
            }
        }
        else if (identity.Provider == "tvmaze")
        {
            answer = await cinemeta.TvmazeAsync("/shows/" + identity.ExternalId + "?embed=episodes", ct);
            if (answer.Json is not { ValueKind: JsonValueKind.Object } show) return FromAnswer(answer);
            MapTvmaze(builder, show, identity.ExternalId);
            if (builder.Work.Anime == true && map.Version == "none")
            {
                await map.RefreshAsync(DateTimeOffset.UtcNow, ct);
                mapped = AllowedMap(map.Find(identity));
                ApplyMap(builder, mapped, map);
            }
            else if (builder.Work.Anime == true) map.RefreshInBackground();
            var animeLink = priorLinks.FirstOrDefault(l => known is not null && l.WorkId == known.WorkId &&
                l.Provider == "anilist" && l.Status == LinkStatus.Verified && l.SeasonId is null);
            if (builder.Work.Anime == true && animeLink is not null)
                return await BuildAsync(new("anilist", animeLink.ExternalId, null), refresh, ct);
            if (await tmdb.EnabledAsync(ct))
            {
                var tmdbId = priorLinks.FirstOrDefault(l => known is not null && l.WorkId == known.WorkId &&
                    l.Provider == "tmdb" && l.Status == LinkStatus.Verified && l.ProviderKind is "tv" or "series")?.ExternalId;
                if (tmdbId is null && show.Obj("externals").Text("imdb") is { } imdb)
                {
                    var found = await tmdb.GetAsync("/find/" + imdb, "external_source=imdb_id", ct);
                    tmdbId = found.Json?.Obj("tv_results").Items().FirstOrDefault().Text("id");
                }
                if (tmdbId is not null)
                {
                    builder.Link("tmdb", tmdbId, "tv");
                    if (!CanUseListing(new("tmdb", tmdbId, "tv"))) tmdbId = null;
                }
                if (tmdbId is not null)
                {
                    var detail = await tmdb.DetailAsync(tmdbId, WorkKind.Series, ct, refresh);
                    if (detail.Json is { ValueKind: JsonValueKind.Object } row)
                    {
                        MapTmdb(builder, row, WorkKind.Series);
                        await TmdbSeasonsAsync(builder, row, refresh, ct);
                    }
                    else builder.Complete = false;
                }
            }
        }
        else if (identity.Provider == "itunes")
        {
            answer = await cinemeta.ItunesByIdAsync(identity.ExternalId, ct);
            var row = answer.Json?.Obj("results").Items().FirstOrDefault(e => e.Text("trackId") == identity.ExternalId);
            if (row is not { ValueKind: JsonValueKind.Object } movie) return FromAnswer(answer);
            MapItunes(builder, movie);
        }
        else return Missing("unsupported_provider", "Choose a supported catalog entry.", true);
        builder.Complete &= answer.Complete && builder.Seasons.All(s => s.MappingStatus == MappingStatus.Confirmed);
        builder.Stale |= answer.Stale;
        if (builder.Work.Kind == WorkKind.Unknown) return Missing("unknown_kind", "The catalog has not confirmed this title's type.", false);
        await SuggestLinksAsync(builder, ct);
        builder.Work = builder.Work with { NumberingVersion = map.Version,
            RefreshedAt = builder.Complete ? builder.Now : builder.Now.AddHours(-1) };
        var proposal = builder.Build();
        var persisted = await PersistAsync(proposal, ct, anchorWorkId: known?.WorkId);
        if (persisted is null)
            persisted = await PersistAsync(proposal, ct, anchorWorkId: known?.WorkId);
        if (persisted is null) return Missing("catalog_conflict", "This title changed while it was being refreshed. Try again.", false);
        return new(await WithPremiereAsync(persisted, ct), answer.Failure,
            builder.Complete && persisted.Work.RefreshedAt is not null, builder.Stale);

        ImmutableArray<AnimeMapEntry> AllowedMap(ImmutableArray<AnimeMapEntry> entries) => [.. entries.Where(e =>
            !priorLinks.Any(l => l.WorkId == known?.WorkId && l.Status == LinkStatus.Rejected &&
                l.Provider == "anilist" && l.ExternalId == e.AniList?.ToString()))];

        bool CanUseListing(ProviderId listing) => !priorLinks.Any(l =>
            l.Status == LinkStatus.Verified && SameId(l, listing) && l.WorkId != known?.WorkId);
    }

    private async Task SuggestLinksAsync(WorkBuilder builder, CancellationToken ct)
    {
        if (builder.Work.Anime != true) return;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(4));
        var names = builder.Names.Select(n => n.NormalizedValue).ToHashSet();
        var title = builder.Names.OrderBy(n => n.Label == NameLabel.English ? 0 : 1).FirstOrDefault()?.Value;
        if (title is null) return;
        try
        {
            if (!builder.Links.Any(l => l.Provider == "anilist"))
            {
                var answer = await anilist.SearchAsync(title, 5, deadline.Token);
                var candidates = (answer.Json?.Obj("data").Obj("Page").Obj("media").Items() ?? []).Where(e =>
                    (e.Text("format") == "MOVIE" ? WorkKind.Film : WorkKind.Series) == builder.Work.Kind &&
                    CompatibleYear(e.Obj("startDate").Int("year")) &&
                    e.Obj("title").EnumerateObject().Where(p => p.Value.ValueKind == JsonValueKind.String)
                        .Any(p => names.Contains(JsonFacts.Fold(p.Value.GetString()!)))).ToArray();
                if (candidates.Length == 1) Suggest("anilist", candidates[0].Text("id")!, null);
            }
            else if (!builder.Links.Any(l => l.Provider == "tmdb") && await tmdb.EnabledAsync(deadline.Token))
            {
                var answer = await tmdb.SearchAsync(title, builder.Work.Kind, builder.Work.Year, deadline.Token);
                var candidates = (answer.Json?.Obj("results").Items() ?? []).Where(e =>
                    CompatibleYear(JsonFacts.Year(e.Text(builder.Work.Kind == WorkKind.Film ? "release_date" : "first_air_date"))) &&
                    new[] { e.Text("title"), e.Text("name"), e.Text("original_title"), e.Text("original_name") }
                        .OfType<string>().Any(n => names.Contains(JsonFacts.Fold(n)))).ToArray();
                if (candidates.Length == 1) Suggest("tmdb", candidates[0].Text("id")!, JsonFacts.Kind(builder.Work.Kind));
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }

        bool CompatibleYear(int? year) => year is { } y && builder.Work.Year is { } expected && Math.Abs(y - expected) <= 1;
        void Suggest(string provider, string id, string? kind)
        {
            var linkId = builder.Link(provider, id, kind, "name_match");
            var link = builder.Links.Single(l => l.Id == linkId);
            builder.Links[builder.Links.IndexOf(link)] = link with { Status = LinkStatus.Suggested, Confidence = 0.9, IsPrimary = false };
        }
    }

}
