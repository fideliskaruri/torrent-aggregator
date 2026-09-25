using Microsoft.AspNetCore.Mvc;
using TorrentFlow.Data;
using TorrentFlow.Metadata.Browse;
using TorrentFlow.Metadata.Recommend;
using TorrentFlow.Metadata.Title;

namespace TorrentFlow.Metadata.Controllers;

[ApiController]
public sealed class BrowseController(BrowseService browse, RecommendationService recommendations, TitleExtrasService extras) : ControllerBase
{
    /// <summary>GET /api/browse — personal rails first, discovery rails beneath. 500 only when the local DB is unreadable.</summary>
    [HttpGet("/api/browse")]
    public async Task<IActionResult> Browse(CancellationToken ct)
    {
        try
        {
            return Ok(await browse.BuildAsync(LocalUser.Id, ct));
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            return StatusCode(500, new { error = "Failed to build browse payload", message = e.Message });
        }
    }

    /// <summary>GET /api/recommendations — always 200; <c>{rail:null}</c> when there is nothing to explain a rail.</summary>
    [HttpGet("/api/recommendations")]
    public async Task<IActionResult> Recommendations(CancellationToken ct) =>
        new JsonResult(new RecommendationsResponse(await recommendations.ForUserAsync(LocalUser.Id, ct)));

    /// <summary>GET /api/title/{workKey}/extras — never non-200 once the key is present.</summary>
    [HttpGet("/api/title/{workKey}/extras")]
    public async Task<IActionResult> Extras(string workKey, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(workKey)) return BadRequest(new { error = "Missing work key" });
        string key;
        try { key = Uri.UnescapeDataString(workKey); } catch (UriFormatException) { key = workKey; }
        var p = Request.Query;
        var query = new TitleExtrasQuery(key, p["t"].FirstOrDefault()?.Trim() ?? "", IntParam(p["y"].FirstOrDefault()),
            p["type"].FirstOrDefault(), IntParam(p["s"].FirstOrDefault()), p["provider"].FirstOrDefault(), p["providerId"].FirstOrDefault(),
            p["poster"].FirstOrDefault(), p["series"].FirstOrDefault() == "1");
        return Ok(await extras.GetAsync(query, ct));
    }

    private static int? IntParam(string? raw) => string.IsNullOrEmpty(raw) ? null : TitleSearchController.ParseIntPrefix(raw);

    public sealed record RecommendationsResponse(
        [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.Never)] RecommendationRail? Rail);
}
