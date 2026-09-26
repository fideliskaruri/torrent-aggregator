using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Settings;

[ApiController]
[Route("api/settings/tmdb")]
public sealed class TmdbSettingsController(TmdbSettingsStore store, IHttpClientFactory http) : ControllerBase
{
    private bool Allowed() => Request.Headers["Sec-Fetch-Site"].ToString().ToLowerInvariant() is "" or "none" or "same-origin";
    private static string? Key(JsonElement body) => body.ValueKind == JsonValueKind.Object &&
        body.TryGetProperty("apiKey", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    [HttpGet]
    public IActionResult Get()
    {
        Response.Headers.CacheControl = "no-store";
        return Ok(store.Status());
    }

    [HttpPut]
    [RequestSizeLimit(8192)]
    public IActionResult Put([FromBody] JsonElement body)
    {
        if (!Allowed()) return StatusCode(403, new { error = "Cross-site writes are not allowed." });
        var key = Key(body);
        if (!TmdbSettingsStore.Accepts(key)) return BadRequest(new { error = "Enter a usable TMDB API key." });
        try { store.Save(key!); return Get(); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        { return StatusCode(503, new { error = "Could not save TMDB settings." }); }
    }

    [HttpDelete]
    public IActionResult Delete()
    {
        if (!Allowed()) return StatusCode(403, new { error = "Cross-site writes are not allowed." });
        try { store.Remove(); return Get(); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        { return StatusCode(503, new { error = "Could not remove TMDB settings." }); }
    }

    [HttpPost("test")]
    [RequestSizeLimit(8192)]
    public async Task<IActionResult> Test([FromBody] JsonElement body, CancellationToken ct)
    {
        if (!Allowed()) return StatusCode(403, new { error = "Cross-site writes are not allowed." });
        var key = Key(body) ?? store.ApiKey;
        if (!TmdbSettingsStore.Accepts(key)) return BadRequest(new { ok = false, status = "invalid" });
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            using var client = http.CreateClient("TorrentFlow.SourceHealth");
            using var request = TmdbClient.BuildRequest(TmdbClient.NormalizeCredential(key), $"{TmdbClient.Base}/configuration", []);
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            var status = response.IsSuccessStatusCode ? "ok" :
                response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden ? "invalid" : "unavailable";
            return Ok(new { ok = status == "ok", status });
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException)
        { return Ok(new { ok = false, status = "unavailable" }); }
    }
}
