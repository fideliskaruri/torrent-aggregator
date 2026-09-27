using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Metadata.Enrichment;

/// <summary>Attaches catalog metadata to search results (port of enrichResultsWithMetadata's call site in the aggregator).</summary>
internal sealed class SearchResultEnricher(IMetadataResolver resolver, ILogger<SearchResultEnricher> logger) : ISearchResultEnricher
{
    internal const int MaxEnrichedResults = 20;
    public void Prime(string query, string? category)
    {
        // The resolver coalesces identical in-flight lookups and memoizes answers, so starting the query's own
        // lookup here lets it overlap the indexer fan-out; EnrichAsync then joins the same flight.
        _ = resolver.ResolveMetadataAsync(query, category).ContinueWith(
            t => logger.LogDebug(t.Exception, "Primary metadata lookup failed for {Query}", query),
            CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    }

    public async Task<IReadOnlyList<TorrentResult>> EnrichAsync(string query, string? category, IReadOnlyList<TorrentResult> results,
        CancellationToken cancellationToken = default)
    {
        if (results.Count == 0) return results;
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(MetadataResolver.EnrichmentBudgetMs + 50);
        IReadOnlyList<MediaMetadata?> metadata;
        try
        {
            var work = resolver.EnrichAsync(results.Take(MaxEnrichedResults).Select(r => new MetadataEnrichmentInput(r.Title)).ToArray(), query, category,
                cancellationToken: budget.Token);
            _ = work.ContinueWith(t => logger.LogDebug(t.Exception, "Late metadata enrichment failed"),
                CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            metadata = await work.WaitAsync(budget.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogDebug("Search metadata exceeded its interactive budget");
            return results;
        }
        catch (Exception e) when (!cancellationToken.IsCancellationRequested)
        {
            // Enrichment is best effort: a provider outage must not fail the search.
            logger.LogWarning(e, "Metadata enrichment failed for {Query}", query);
            return results;
        }
        // Like enrichResultsWithMetadata, every row takes the resolved answer, including null: adapter-supplied
        // metadata (YTS) that fails the identity check must not survive onto an unrelated release.
        var enriched = new TorrentResult[results.Count];
        for (var i = 0; i < results.Count; i++)
            enriched[i] = i < metadata.Count ? results[i] with { Metadata = metadata[i] } : results[i];
        return enriched;
    }
}
