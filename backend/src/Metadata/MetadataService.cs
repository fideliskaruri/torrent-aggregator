using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed partial class MetadataService(CatalogStore store, TmdbClient tmdb, AniListClient anilist,
    CinemetaClient cinemeta, FribbMap map) : IMetadata
{
    private readonly SemaphoreSlim commits = new(1);
    private readonly ConcurrentDictionary<string, Lazy<Task<MetadataResult>>> resolutions = new();
    private readonly ConcurrentDictionary<string, (MetadataResult Result, DateTimeOffset Until)> partialAnswers = new();
    private readonly ConcurrentDictionary<string, (string WorkId, DateTimeOffset Until)> resolvedQueries = new();

    public async Task<MetadataResult> ResolveAsync(MetadataQuery query, CancellationToken cancellationToken)
    {
        if (query.Identity is { } identity)
            return await ResolveIdentityAsync(identity.ProviderKind is null && query.Kind != WorkKind.Unknown &&
                identity.Provider is "tmdb" or "imdb" or "cinemeta"
                ? identity with { ProviderKind = JsonFacts.Kind(query.Kind) } : identity, false, cancellationToken);
        var title = JsonFacts.Term(query.Title ?? "");
        if (title.Length is < 1 or > 200 || JsonFacts.Fold(title).Length == 0)
            return Missing("invalid_query", "Enter a title or choose a catalog entry.", true);
        var queryKey = JsonFacts.Fold(title) + ":" + query.Year + ":" + query.Kind;
        if (resolvedQueries.TryGetValue(queryKey, out var remembered) && remembered.Until > DateTimeOffset.UtcNow)
        {
            var existing = await GetWorkAsync(remembered.WorkId, false, cancellationToken);
            if (existing.Work is not null && SearchText.MatchScore(title, existing.Work.Names.Select(n => n.Value), false) >= 0.6)
                return existing;
            resolvedQueries.TryRemove(queryKey, out _);
        }
        var found = await SearchAsync(new(title, query.Kind switch
        {
            WorkKind.Film => "films", WorkKind.Series => "series", _ => "all",
        }, 30), cancellationToken);
        var ranked = found.Works.Where(w => query.Kind == WorkKind.Unknown || w.Work.Kind == query.Kind)
            .Where(w => query.Year is null || w.Work.Year == query.Year)
            .Select(w => (Work: w, Score: SearchText.MatchScore(title, w.Names.Select(n => n.Value), false)))
            .Where(w => w.Score >= 0.6).OrderByDescending(w => w.Score)
            .ThenByDescending(w => w.Work.Work.Year is not null).ToArray();
        if (ranked.Length == 0)
            return Missing(found.Partial ? "provider_unavailable" : "not_found",
                found.Partial ? "Some catalogs did not answer. Try this title again later." :
                    "No matching catalog entry was found. Check the title and year.", !found.Partial);
        if (query.Year is null && ranked.Where(w => w.Score == ranked[0].Score)
            .Select(w => w.Work.Work.Year).OfType<int>().Distinct().Take(2).Count() > 1)
            return Missing("ambiguous", "Several titles match. Choose a catalog entry or include its year.", true);
        var primary = ranked[0].Work.Links.First(l => l.IsPrimary && l.Status == LinkStatus.Verified);
        var resolved = await ResolveIdentityAsync(new(primary.Provider, primary.ExternalId,
            primary.ProviderKind ?? JsonFacts.Kind(ranked[0].Work.Work.Kind)), false, cancellationToken);
        if (resolved.Work is not null)
        {
            if (resolvedQueries.Count >= 500) resolvedQueries.TryRemove(resolvedQueries.MinBy(p => p.Value.Until).Key, out _);
            resolvedQueries[queryKey] = (resolved.Work.Work.Id, DateTimeOffset.UtcNow +
                (resolved.Complete ? TimeSpan.FromMinutes(30) : TimeSpan.FromMinutes(1)));
        }
        return resolved;
    }

    public async Task<MetadataResult> GetWorkAsync(string workId, bool refresh, CancellationToken cancellationToken)
    {
        var cached = await store.SnapshotAsync(workId, cancellationToken);
        if (cached is null)
        {
            var parts = workId.Split(':');
            if (parts.Length is 2 or 3)
                return await ResolveIdentityAsync(new(parts[0], parts[^1], parts.Length == 3 ? parts[1] : null),
                    refresh, cancellationToken);
            return Missing("not_found", "This title is not in the catalog. Search for it again.", true);
        }
        if (!refresh && CurrentPresentation(cached) && cached.Work.RefreshedAt > DateTimeOffset.UtcNow.AddHours(-1) && !cached.Seasons.Any(s =>
            s.MappingStatus != MappingStatus.Confirmed)) return new(await WithPremiereAsync(cached, cancellationToken), null, true, false);
        var primary = cached.Links.FirstOrDefault(l => l.IsPrimary && l.Status == LinkStatus.Verified);
        if (primary is null) return new(cached, null, false, true);
        var resolved = await ResolveIdentityAsync(new(primary.Provider, primary.ExternalId,
            primary.ProviderKind ?? JsonFacts.Kind(cached.Work.Kind)), refresh, cancellationToken);
        return resolved.Work is null ? new(cached, resolved.Failure, false, true) : resolved;
    }

    private async Task<MetadataResult> ResolveIdentityAsync(ProviderId identity, bool refresh, CancellationToken ct)
    {
        identity = identity with { Provider = identity.Provider.ToLowerInvariant() };
        if (!ValidIdentity(identity)) return Missing("invalid_identity", "Choose a valid catalog entry.", true);
        if (identity.Provider is "imdb" or "cinemeta" && identity.ProviderKind is null)
        {
            var suggestion = await cinemeta.SuggestAsync(identity.ExternalId, ct);
            var item = suggestion.Json?.Obj("d").Items().FirstOrDefault(e => e.Text("id") == identity.ExternalId);
            if (item?.Text("qid") is not { } type)
                return Missing("unknown_kind", "The catalog has not confirmed this title's type. Choose it from search.", false);
            identity = identity with { ProviderKind = type is "tvSeries" or "tvMiniSeries" ? "tv" : "movie" };
        }
        var key = identity.Provider + ":" + identity.ProviderKind + ":" + identity.ExternalId + ":" + refresh;
        if (!refresh && partialAnswers.TryGetValue(key, out var cachedPartial) && cachedPartial.Until > DateTimeOffset.UtcNow)
            return cachedPartial.Result;
        var flight = resolutions.GetOrAdd(key, _ => new Lazy<Task<MetadataResult>>(
            () => SafeBuildAsync(identity, refresh), LazyThreadSafetyMode.ExecutionAndPublication));
        try
        {
            var result = await flight.Value.WaitAsync(ct);
            if (!refresh && !result.Complete && result.Work is not null)
            {
                if (partialAnswers.Count >= 200) partialAnswers.TryRemove(partialAnswers.MinBy(p => p.Value.Until).Key, out _);
                partialAnswers[key] = (result, DateTimeOffset.UtcNow.AddMinutes(1));
            }
            return result;
        }
        finally
        {
            if (flight.IsValueCreated && flight.Value.IsCompleted)
                resolutions.TryRemove(new KeyValuePair<string, Lazy<Task<MetadataResult>>>(key, flight));
            else _ = flight.Value.ContinueWith(_ => resolutions.TryRemove(
                new KeyValuePair<string, Lazy<Task<MetadataResult>>>(key, flight)),
                CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        }

    }

    private async Task<MetadataResult> SafeBuildAsync(ProviderId identity, bool refresh)
    {
        try { return await BuildAsync(identity, refresh, CancellationToken.None); }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or OperationCanceledException or IOException)
        {
            var link = (await store.AllAsync<WorkLinkRow>(null, CancellationToken.None))
                .FirstOrDefault(l => l.Status == LinkStatus.Verified && SameId(l, identity));
            var previous = link is null ? null : await store.SnapshotAsync(link.WorkId, CancellationToken.None);
            return new(previous, new("provider_unavailable", "The catalog could not be reached. Try again later.", null, false),
                false, previous is not null);
        }
    }

    private async Task<MetadataResult> BuildAsync(ProviderId identity, bool refresh, CancellationToken ct)
    {
        var priorLinks = await store.AllAsync<WorkLinkRow>(null, ct);
        var known = priorLinks.FirstOrDefault(l => l.Status == LinkStatus.Verified && SameId(l, identity));
        if (!refresh && known is not null)
        {
            var knownWork = await store.SnapshotAsync(known.WorkId, ct);
            if (knownWork is not null && (identity.ProviderKind is null ||
                knownWork.Work.Kind == (identity.ProviderKind is "tv" or "series" ? WorkKind.Series : WorkKind.Film))
                && CurrentPresentation(knownWork) && knownWork.Work.RefreshedAt > DateTimeOffset.UtcNow.AddHours(-1)
                && (knownWork.Work.Kind == WorkKind.Film || !knownWork.Seasons.IsEmpty)
                && knownWork.Seasons.All(s => s.MappingStatus == MappingStatus.Confirmed))
                return new(await WithPremiereAsync(knownWork, ct), null, true, false);
        }
        await map.LoadAsync(ct);
        if (map.Version == "none") await map.RefreshAsync(DateTimeOffset.UtcNow, ct);
        else map.RefreshInBackground();
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
            ApplyMap(builder, mapped);
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
            if (await tmdb.EnabledAsync(ct) && builder.Links.FirstOrDefault(l => l.Provider == "tmdb") is { } linked)
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
                await AnimeSeasonsAsync(builder, media, refresh, ct);
        }
        else if (identity.Provider == "tmdb")
        {
            var kind = identity.ProviderKind is "tv" or "series" ? WorkKind.Series : WorkKind.Film;
            answer = await tmdb.DetailAsync(identity.ExternalId, kind, ct, refresh);
            if (answer.Json is not { ValueKind: JsonValueKind.Object } detail) return FromAnswer(answer);
            MapTmdb(builder, detail, kind);
            ApplyMap(builder, mapped);
            if (kind == WorkKind.Series) await TmdbSeasonsAsync(builder, detail, refresh, ct);
            if (builder.Work.Anime == true && mapped.FirstOrDefault(e => e.AniList is not null)?.AniList is { } animeId)
            {
                var anime = await anilist.DetailAsync(animeId.ToString(), ct, refresh);
                if (anime.Json?.Obj("data").Obj("Media") is { ValueKind: JsonValueKind.Object } media)
                {
                    MapAnime(builder, media, overlay: true);
                    if (kind == WorkKind.Series) await AnimeSeasonsAsync(builder, media, refresh, ct);
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
            ApplyMap(builder, mapped);
            var imdbNames = await cinemeta.NamesAsync(identity.ExternalId, ct);
            if (imdbNames.Json?.Obj("data").Obj("title") is { ValueKind: JsonValueKind.Object } names)
            {
                var link = builder.Links.First(l => l.Provider == "imdb").Id;
                builder.Name(names.Obj("titleText").Text("text"), NameLabel.English, link);
                builder.Name(names.Obj("originalTitleText").Text("text"), NameLabel.Original, link);
                foreach (var name in names.Obj("akas").Obj("edges").Items())
                    builder.Name(name.Obj("node").Text("text"), NameLabel.Synonym, link);
            }
            if (await tmdb.EnabledAsync(ct) && builder.Links.FirstOrDefault(l => l.Provider == "tmdb") is { } linked)
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
                    if (kind == WorkKind.Series) await AnimeSeasonsAsync(builder, media, refresh, ct);
                }
                else builder.Complete = false;
            }
        }
        else if (identity.Provider == "tvmaze")
        {
            answer = await cinemeta.TvmazeAsync("/shows/" + identity.ExternalId + "?embed=episodes", ct);
            if (answer.Json is not { ValueKind: JsonValueKind.Object } show) return FromAnswer(answer);
            MapTvmaze(builder, show, identity.ExternalId);
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

    private static bool ValidIdentity(ProviderId identity) => identity.Provider switch
    {
        "imdb" or "cinemeta" => ImdbId().IsMatch(identity.ExternalId),
        "anilist" or "tmdb" or "mal" or "tvdb" or "tvmaze" or "itunes" =>
            int.TryParse(identity.ExternalId, NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0,
        _ => false,
    };

    private static bool SameId(WorkLinkRow link, ProviderId id) =>
        (link.Provider == id.Provider || id.Provider == "cinemeta" && link.Provider == "imdb") &&
        link.ExternalId == id.ExternalId && (id.ProviderKind is null || link.Provider is "imdb" or "tvmaze"
            || link.ProviderKind == id.ProviderKind
            || id.ProviderKind == "series" && link.ProviderKind == "tv");

    private static MetadataResult Missing(string code, string message, bool complete) =>
        new(null, new(code, message, null, false), complete, false);
    private static MetadataResult FromAnswer(ProviderAnswer answer) =>
        new(null, answer.Failure ?? new("not_found", "This catalog entry was not found.", null, false),
            answer.Complete, answer.Stale);

    [GeneratedRegex(@"^tt[0-9]+$")] private static partial Regex ImdbId();
}
