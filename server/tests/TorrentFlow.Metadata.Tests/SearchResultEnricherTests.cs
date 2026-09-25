using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Metadata.Enrichment;

namespace TorrentFlow.Metadata.Tests;

public sealed class SearchResultEnricherTests
{
    private sealed class FixedResolver(params MediaMetadata?[] answers) : IMetadataResolver
    {
        public Task<MediaMetadata?> ResolveMetadataAsync(string rawTitle, string? category, CancellationToken cancellationToken = default) =>
            Task.FromResult<MediaMetadata?>(null);
        public Task<IReadOnlyList<MediaMetadata?>> EnrichAsync(IReadOnlyList<MetadataEnrichmentInput> inputs, string query, string? category,
            MediaMetadata? primary = null, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<MediaMetadata?>>(answers);
        public Task<MediaMetadata?> GetAniListByIdAsync(string id, CancellationToken cancellationToken = default) => Task.FromResult<MediaMetadata?>(null);
        public Task<MediaMetadata?> GetTmdbByIdAsync(string mediaType, string id, CancellationToken cancellationToken = default) => Task.FromResult<MediaMetadata?>(null);
    }

    private static MediaMetadata Meta(string title) => new() { Source = "tmdb", MediaType = "movie", ExternalId = title, Title = title };

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
