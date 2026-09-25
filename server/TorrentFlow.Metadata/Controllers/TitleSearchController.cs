using Microsoft.AspNetCore.Mvc;
using TorrentFlow.Metadata.Search;

namespace TorrentFlow.Metadata.Controllers;

[ApiController]
public sealed class TitleSearchController(WorkSearchService works, SuggestService suggest, RateLimiter rateLimiter) : ControllerBase
{
    /// <summary>GET /api/search/titles?q=&amp;category=&amp;limit=</summary>
    [HttpGet("/api/search/titles")]
    public async Task<IActionResult> SearchTitles([FromQuery] string? q, [FromQuery] string? category, [FromQuery] string? limit, CancellationToken ct)
    {
        if (!rateLimiter.Allow($"search-titles:{RateLimiter.ClientKey(Request)}", 60))
            return StatusCode(429, new { error = "Too many requests", results = Array.Empty<object>() });
        var query = q?.Trim() ?? "";
        var scope = WorkSearchService.ParseScope(category);
        if (query.Length == 0) return BadRequest(new { error = "Missing query parameter `q`", results = Array.Empty<object>() });
        if (query.Length > 200) return BadRequest(new { error = "Query too long", results = Array.Empty<object>() });
        var take = Math.Min(Math.Max(ParseIntPrefix(limit ?? "12") is { } n && n != 0 ? n : 12, 1), 40);
        try
        {
            var outcome = await works.SearchAsync(scope, query, take, ct);
            return Ok(new
            {
                results = outcome.Results,
                query = outcome.DisplayQuery,
                canonicalQuery = outcome.Query,
                category = scope,
                partial = outcome.Partial,
                failedProviders = outcome.Failed,
                stale = outcome.Stale,
            });
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            var safe = SafeErrors.Normalize(e);
            return StatusCode(500, new
            {
                error = "Title search failed",
                code = safe.Code,
                message = safe.Message,
                results = Array.Empty<object>(),
                partial = false,
                failedProviders = e is AllProvidersFailedException all ? all.Failed : [],
            });
        }
    }

    /// <summary>GET /api/suggest?q=</summary>
    [HttpGet("/api/suggest")]
    public async Task<IActionResult> Suggest([FromQuery] string? q, CancellationToken ct)
    {
        if (!rateLimiter.Allow($"suggest:{RateLimiter.ClientKey(Request)}", 60)) return Ok(new { suggestions = Array.Empty<object>() });
        var query = q?.Trim() ?? "";
        if (query.Length < 2) return Ok(new { suggestions = Array.Empty<object>() });
        if (query.Length > 200) return BadRequest(new { error = "Query too long", suggestions = Array.Empty<object>() });
        try
        {
            var outcome = await suggest.CollectAsync(query, ct: ct);
            return Ok(new
            {
                suggestions = outcome.Suggestions,
                query = outcome.DisplayQuery,
                canonicalQuery = outcome.Query,
                partial = outcome.Partial,
                failedProviders = outcome.Failed,
            });
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            var safe = SafeErrors.Normalize(e);
            var outage = e is AllProvidersFailedException;
            return StatusCode(outage ? 502 : 500, new
            {
                error = outage ? "Suggest failed" : "Suggest could not be completed",
                code = safe.Code,
                message = safe.Message,
                suggestions = Array.Empty<object>(),
                partial = false,
                failedProviders = e is AllProvidersFailedException all ? all.Failed : [],
            });
        }
    }

    /// <summary>JS parseInt: leading optional sign + digits, else null.</summary>
    public static int? ParseIntPrefix(string value)
    {
        var s = value.TrimStart();
        var i = 0;
        if (i < s.Length && (s[i] == '-' || s[i] == '+')) i++;
        var start = i;
        while (i < s.Length && char.IsAsciiDigit(s[i])) i++;
        if (i == start) return null;
        return long.TryParse(s[..i], out var v) ? (int)Math.Clamp(v, int.MinValue, int.MaxValue) : null;
    }
}
