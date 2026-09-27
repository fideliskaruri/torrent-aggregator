using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Metadata.Enrichment;
using TorrentFlow.Metadata.Artwork;
using TorrentFlow.Metadata.Providers;
using TorrentFlow.Metadata.Search;

namespace TorrentFlow.Metadata.Tests;

public sealed class SearchResultEnricherTests
{
    private sealed class FixedResolver(params MediaMetadata?[] answers) : IMetadataResolver
    {
        public int InputCount;
        public Task<IReadOnlyList<MediaMetadata?>>? Work;
        public Task<MediaMetadata?> ResolveMetadataAsync(string rawTitle, string? category, CancellationToken cancellationToken = default) =>
            Task.FromResult<MediaMetadata?>(null);
        public Task<IReadOnlyList<MediaMetadata?>> EnrichAsync(IReadOnlyList<MetadataEnrichmentInput> inputs, string query, string? category,
            MediaMetadata? primary = null, CancellationToken cancellationToken = default)
        {
            InputCount = inputs.Count;
            return Work ?? Task.FromResult<IReadOnlyList<MediaMetadata?>>(answers);
        }
        public Task<MediaMetadata?> GetAniListByIdAsync(string id, CancellationToken cancellationToken = default) => Task.FromResult<MediaMetadata?>(null);
        public Task<MediaMetadata?> GetTmdbByIdAsync(string mediaType, string id, CancellationToken cancellationToken = default) => Task.FromResult<MediaMetadata?>(null);
    }

    private static MediaMetadata Meta(string title) => new() { Source = "tmdb", MediaType = "movie", ExternalId = title, Title = title };
    private static TorrentResult Row(string title) => new() { Id = title, Title = title, Source = "nyaa", SourceUrl = "" };

    [Theory]
    [InlineData("Sintel (2010) [1080p]", "sintel 2010")]
    [InlineData("2001.A.Space.Odyssey.(1968).1080p", "2001 a space odyssey 1968")]
    [InlineData("  SINTEL.2010.720p ", "sintel 2010")]
    public void Normalized_lookup_preserves_bracketed_years(string raw, string expected) =>
        Assert.Equal(expected, MetadataResolver.LookupTitle(raw));

    private static MetadataResolver Resolver(WorkSearchProvider provider, ManualTime? time = null)
    {
        time ??= new();
        var http = new FakeHttpFactory(FakeHandler.Always("{}"));
        var options = Fixtures.Options();
        var tmdb = new TmdbClient(http, options, time);
        var anilist = new AniListClient(http, time);
        var artwork = new ArtworkResolver(tmdb, anilist, new KeylessClients(http), options, time);
        var search = new WorkSearchService(new Dictionary<string, WorkSearchProvider> { ["movies"] = provider }, time);
        return new(tmdb, anilist, artwork, null, time, workSearch: search);
    }

    [Fact]
    public async Task Interactive_enrichment_returns_when_resolver_ignores_cancellation()
    {
        var gate = new TaskCompletionSource<IReadOnlyList<MediaMetadata?>>(TaskCreationOptions.RunContinuationsAsynchronously);
        var resolver = new FixedResolver { Work = gate.Task };
        var enricher = new SearchResultEnricher(resolver, NullLogger<SearchResultEnricher>.Instance);
        var input = new[] { Row("Sintel") };
        try
        {
            Assert.Same(input, await enricher.EnrichAsync("Sintel", "movies", input).WaitAsync(TimeSpan.FromSeconds(2)));
        }
        finally { gate.TrySetResult([]); }
    }

    [Fact]
    public async Task Enrichment_caps_rows_without_dropping_results()
    {
        var resolver = new FixedResolver();
        var enricher = new SearchResultEnricher(resolver, NullLogger<SearchResultEnricher>.Instance);
        var input = Enumerable.Range(0, 200).Select(i => Row($"Movie {i}")).ToArray();
        Assert.Equal(200, (await enricher.EnrichAsync("Movie", "movies", input)).Count);
        Assert.Equal(SearchResultEnricher.MaxEnrichedResults, resolver.InputCount);
    }

    [Fact]
    public async Task Caller_cancellation_is_not_swallowed()
    {
        var gate = new TaskCompletionSource<IReadOnlyList<MediaMetadata?>>(TaskCreationOptions.RunContinuationsAsynchronously);
        var resolver = new FixedResolver { Work = gate.Task };
        var enricher = new SearchResultEnricher(resolver, NullLogger<SearchResultEnricher>.Instance);
        using var cancellation = new CancellationTokenSource();
        var work = enricher.EnrichAsync("Sintel", "movies", [Row("Sintel")], cancellation.Token);
        cancellation.Cancel();
        try { await Assert.ThrowsAnyAsync<OperationCanceledException>(() => work); }
        finally { gate.TrySetResult([]); }
    }

    [Fact]
    public async Task Normalized_lookups_share_a_flight_and_cache_but_years_do_not()
    {
        var calls = 0;
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resolver = Resolver(async (q, _, _) =>
        {
            Interlocked.Increment(ref calls);
            await gate.Task;
            return [WorkSearchService.HitFromMetadata(Meta(q), "movies")!];
        });
        var a = resolver.ResolveMetadataAsync("Sintel (2010) [1080p]", "movies");
        var b = resolver.ResolveMetadataAsync("  SINTEL.2010.720p ", "movies");
        Assert.Equal(1, calls);
        gate.SetResult();
        Assert.Equal(await a, await b);
        await resolver.ResolveMetadataAsync("sintel 2010", "movies");
        Assert.Equal(1, calls);
        await resolver.ResolveMetadataAsync("Sintel (2011)", "movies");
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task Empty_catalog_answers_are_cached_and_expire()
    {
        var calls = 0;
        var time = new ManualTime();
        var resolver = Resolver((_, _, _) => { calls++; return Task.FromResult(new List<WorkSearchHit>()); }, time);
        Assert.Null(await resolver.ResolveMetadataAsync("Sintel", "movies"));
        Assert.Null(await resolver.ResolveMetadataAsync("sintel", "movies"));
        Assert.Equal(1, calls);
        time.Advance(TimeSpan.FromMinutes(4));
        Assert.Null(await resolver.ResolveMetadataAsync("Sintel", "movies"));
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task Shared_lookups_stay_capped_after_waiters_time_out_and_warm_cache_later()
    {
        var calls = 0;
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resolver = Resolver(async (q, _, _) =>
        {
            Interlocked.Increment(ref calls);
            await gate.Task;
            return [WorkSearchService.HitFromMetadata(Meta(q), "movies")!];
        });
        var input = Enumerable.Range(0, 20).Select(i => new MetadataEnrichmentInput($"Sintel episode {i}")).ToArray();
        try
        {
            var output = await resolver.EnrichAsync(input, "Sintel", "movies").WaitAsync(TimeSpan.FromSeconds(2));
            Assert.Equal(20, output.Count);
            Assert.All(output, Assert.Null);
            Assert.Equal(MetadataResolver.MaxConcurrentLookups, calls);
            await resolver.EnrichAsync(input, "Sintel", "movies").WaitAsync(TimeSpan.FromSeconds(2));
            Assert.Equal(MetadataResolver.MaxConcurrentLookups, calls);
        }
        finally { gate.TrySetResult(); }
        var warmed = await resolver.ResolveMetadataAsync("Sintel", "movies");
        Assert.NotNull(warmed);
    }

    [Fact]
    public async Task Fast_release_metadata_survives_a_slow_primary_query()
    {
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resolver = Resolver(async (q, _, _) =>
        {
            if (q == "sintel") await gate.Task;
            return [WorkSearchService.HitFromMetadata(Meta("Sintel") with { Year = 2010 }, "movies")!];
        });
        try
        {
            var result = await resolver.EnrichAsync([new("Sintel (2010) 1080p")], "Sintel", "movies").WaitAsync(TimeSpan.FromSeconds(2));
            Assert.Equal("Sintel", Assert.Single(result)?.Title);
        }
        finally { gate.TrySetResult(); }
    }

    [Fact]
    public async Task Duplicate_releases_only_lookup_once_and_unique_release_work_is_bounded()
    {
        var calls = 0;
        var resolver = Resolver((q, _, _) =>
        {
            calls++;
            return Task.FromResult(new List<WorkSearchHit> { WorkSearchService.HitFromMetadata(Meta(q), "movies")! });
        });
        var duplicates = new[] { new MetadataEnrichmentInput("Sintel (2010) 1080p"), new MetadataEnrichmentInput("SINTEL.2010.720p") };
        await resolver.EnrichAsync(duplicates, "Sintel (2010)", "movies");
        Assert.Equal(1, calls);
        calls = 0;
        await resolver.EnrichAsync(Enumerable.Range(0, 20).Select(i => new MetadataEnrichmentInput($"Other title {i}")).ToArray(),
            "Primary query", "movies");
        Assert.Equal(7, calls); // One query and at most six distinct release identities.
    }

    [Fact]
    public async Task Unmatched_rows_drop_adapter_metadata_like_typescript()
    {
        // YTS attaches its own catalog card to every row; enrichResultsWithMetadata replaces it with the identity-checked
        // answer, so an unrelated film (Suna no onna for "dune") ends with metadata null.
        TorrentResult Row(string id, string title, MediaMetadata? metadata) => new() { Id = id, Title = title, Source = "yts", SourceUrl = "", Metadata = metadata };
        var input = new[] { Row("a", "Dune (2021) [1080p] [web] [YTS]", Meta("Dune")), Row("b", "Suna no onna (1964) [720p] [bluray] [YTS]", Meta("Suna no onna")) };
        var enricher = new SearchResultEnricher(new FixedResolver(Meta("Dune (resolved)"), null), NullLogger<SearchResultEnricher>.Instance);

        var output = await enricher.EnrichAsync("dune", "all", input);

        Assert.Equal("Dune (resolved)", output[0].Metadata?.Title);
        Assert.Null(output[1].Metadata);
    }
}
