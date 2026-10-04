using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Metadata;

internal sealed partial class Catalog(IDbContextFactory<TorrentFlowDbContext> dbs, TmdbClient tmdb,
    AniListClient anilist, CinemetaClient cinemeta, FribbMap map, Browse browse, AnimeSeasons animeSeasons) : IMetadata
{
    private static readonly SemaphoreSlim commits = new(1);
    private readonly ConcurrentDictionary<string, Lazy<Task<MetadataResult>>> resolutions = new();
    private readonly ConcurrentDictionary<string, (MetadataResult Result, DateTimeOffset Until)> partialAnswers = new();
    private readonly ConcurrentDictionary<string, (string WorkId, DateTimeOffset Until)> resolvedQueries = new();

    public Task<BrowseResult> BrowseAsync(BrowseQuery query, CancellationToken cancellationToken) => browse.BrowseAsync(query, cancellationToken);
    public Task<MetadataExtras?> ExtrasAsync(MetadataQuery query, int? season, CancellationToken cancellationToken) => browse.ExtrasAsync(query, season, cancellationToken, ResolveAsync, RecommendAsync);
    public Task<BrowseRail?> RecommendAsync(ImmutableArray<string> seedWorkIds, CancellationToken cancellationToken) => browse.RecommendAsync(seedWorkIds, cancellationToken);

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
        // Resolving one exact, typed identity need not wait for every search catalog.
        if (query.Kind != WorkKind.Unknown && await tmdb.EnabledAsync(cancellationToken))
        {
            var answer = await tmdb.SearchAsync(title, query.Kind, query.Year, cancellationToken);
            var exact = (answer.Json?.Obj("results").Items() ?? []).Where(e =>
                new[] { e.Text("title"), e.Text("name"), e.Text("original_title"), e.Text("original_name") }
                    .OfType<string>().Any(n => JsonFacts.Fold(n) == JsonFacts.Fold(title)) &&
                (query.Year is null || JsonFacts.Year(e.Text(query.Kind == WorkKind.Film ?
                    "release_date" : "first_air_date")) == query.Year)).ToArray();
            if (answer.Complete && exact.Length == 1 && exact[0].Text("id") is { } exactId)
            {
                var exactResult = await ResolveIdentityAsync(new("tmdb", exactId, JsonFacts.Kind(query.Kind)),
                    false, cancellationToken);
                if (exactResult.Work is not null)
                {
                    if (resolvedQueries.Count >= 500) resolvedQueries.TryRemove(resolvedQueries.MinBy(p => p.Value.Until).Key, out _);
                    resolvedQueries[queryKey] = (exactResult.Work.Work.Id, DateTimeOffset.UtcNow +
                        (exactResult.Complete ? TimeSpan.FromMinutes(30) : TimeSpan.FromMinutes(1)));
                    return exactResult;
                }
            }
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
        var cached = await SnapshotAsync(workId, cancellationToken);
        if (cached is null)
        {
            var parts = workId.Split(':');
            if (parts.Length is 2 or 3)
                return await ResolveIdentityAsync(new(parts[0], parts[^1], parts.Length == 3 ? parts[1] : null),
                    refresh, cancellationToken);
            return Missing("not_found", "This title is not in the catalog. Search for it again.", true);
        }
        if (!refresh && !HasProviderConflict(cached) && CurrentPresentation(cached) && cached.Work.RefreshedAt > DateTimeOffset.UtcNow.AddHours(-1) && !cached.Seasons.Any(s =>
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
            var link = (await LinksAsync(CancellationToken.None))
                .FirstOrDefault(l => l.Status == LinkStatus.Verified && SameId(l, identity));
            var previous = link is null ? null : await SnapshotAsync(link.WorkId, CancellationToken.None);
            return new(previous, new("provider_unavailable", "The catalog could not be reached. Try again later.", null, false),
                false, previous is not null);
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

    private static bool HasProviderConflict(WorkSnapshot work) =>
        work.Links.Any(l => l.Status == LinkStatus.Suggested && l.Source == "provider");

    private static MetadataResult Missing(string code, string message, bool complete) =>
        new(null, new(code, message, null, false), complete, false);
    private static MetadataResult FromAnswer(ProviderAnswer answer) =>
        new(null, answer.Failure ?? new("not_found", "This catalog entry was not found.", null, false),
            answer.Complete, answer.Stale);

    [GeneratedRegex(@"^tt[0-9]+$")] private static partial Regex ImdbId();
}
