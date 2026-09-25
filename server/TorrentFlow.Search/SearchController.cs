using System.Globalization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Search;

[ApiController]
[Route("api/search")]
public sealed class SearchController(ITorrentSearchService service, TorrentSearchService catalog, ILogger<SearchController> logger) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken cancellationToken)
    {
        try
        {
            var q = Text("q", required: true, maxLength: 200)!;
            var category = Text("category", ["all", "anime", "movies", "tv", "music", "apps", "games", "books"]) ?? "all";
            var page = Number("page", 1, 10000) ?? 1;
            var pageSize = Number("pageSize", 1, 200) ?? 20;
            var limit = Number("limit", 1, 200);
            string[]? sources = null;
            if (Request.Query.TryGetValue("sources", out var raw))
            {
                var values = raw.ToString().Split(',').Select(x => x.Trim()).ToArray();
                if (values.Length > 5 || values.Any(string.IsNullOrEmpty)) throw new InvalidQuery("sources", "sources may contain at most 5 non-empty values");
                var valid = new[] { "nyaa", "1337x", "apibay", "torrentscsv", "yts" };
                foreach (var value in values) if (!valid.Contains(value)) throw new InvalidQuery("sources", $"Unknown source `{value}`");
                sources = values.Distinct().ToArray();
            }
            var enrich = Binary("enrich") ?? true;
            var refresh = Binary("refresh") ?? false;
            var hasMagnet = Binary("hasMagnet");
            var filters = new SearchFilters
            {
                MinSeeders = Number("minSeeders"), MaxSeeders = Number("maxSeeders"), MinSizeBytes = Number("minSize"), MaxSizeBytes = Number("maxSize"),
                Season = (int?)Number("season", 1, 10000), Episode = (int?)Number("episode", 1, 100000),
                Resolution = Text("resolution", ["480p", "720p", "1080p", "2160p", "4k"]),
                Codec = Text("codec", ["x264", "h264", "x265", "h265", "hevc", "av1"]),
                ReleaseKind = Text("releaseKind", ["packs", "episodes"]), HasMagnet = hasMagnet == true ? true : null
            };
            if (filters.MinSeeders > filters.MaxSeeders) throw new InvalidQuery("minSeeders", "minSeeders cannot exceed maxSeeders");
            if (filters.MinSizeBytes > filters.MaxSizeBytes) throw new InvalidQuery("minSize", "minSize cannot exceed maxSize");
            var result = await service.SearchAsync(new()
            {
                Query = q, Category = category, Page = (int)page, PageSize = (int)pageSize, Limit = (int?)limit, Sources = sources,
                Filters = filters, Enrich = enrich, SkipCache = refresh, AdapterDeadlineMs = TorrentSearchService.InteractiveAdapterDeadlineMs
            }, cancellationToken);
            return Ok(result with { AvailableSources = catalog.AvailableSources });
        }
        catch (InvalidQuery e)
        {
            return BadRequest(e.Field == "q" ? (object)new { error = e.Message, field = e.Field, availableSources = catalog.AvailableSources } : new { error = e.Message, field = e.Field });
        }
        catch (SearchThrottledException e)
        {
            Response.Headers.RetryAfter = e.RetryAfterSeconds.ToString(CultureInfo.InvariantCulture);
            return StatusCode(429, new { error = "Indexers busy", message = e.Message, retryAfterSeconds = e.RetryAfterSeconds });
        }
        catch (Exception e) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogError(e, "Search failed");
            return StatusCode(500, new { error = "Search failed", message = "One or more indexers could not complete the search." });
        }
    }
    private string? Text(string key, string[]? allowed = null, bool required = false, int maxLength = int.MaxValue)
    {
        var value = Request.Query[key].FirstOrDefault()?.Trim();
        if (string.IsNullOrEmpty(value))
        {
            if (required) throw new InvalidQuery(key, $"{key} is required");
            return null;
        }
        if (value.Length > maxLength) throw new InvalidQuery(key, $"{key} must be at most {maxLength} characters");
        if (allowed != null && !allowed.Contains(value)) throw new InvalidQuery(key, $"{key} must be one of: {string.Join(", ", allowed)}");
        return value;
    }
    private bool? Binary(string key) => Text(key, ["0", "1"]) is { } value ? value == "1" : null;
    private long? Number(string key, long min = 0, long max = 9007199254740991)
    {
        var text = Text(key);
        if (text == null) return null;
        if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) || !double.IsFinite(value)
            || value != Math.Truncate(value) || value < min || value > max)
            throw new InvalidQuery(key, $"{key} must be an integer between {min} and {max}");
        return (long)value;
    }
    private sealed class InvalidQuery(string field, string message) : Exception(message) { public string Field { get; } = field; }
}
