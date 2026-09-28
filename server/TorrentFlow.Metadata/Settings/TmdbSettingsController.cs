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
    public async Task<IActionResult> Put([FromBody] JsonElement body, CancellationToken ct)
    {
        if (!Allowed()) return StatusCode(403, new { error = "Cross-site writes are not allowed." });
        var key = Key(body);
        if (!TmdbSettingsStore.Accepts(key))
            return BadRequest(new { error = "Enter a usable TMDB API key (32-character v3 key or v4 access token)." });
        // Format-validated keys save here. Use POST /test for a live TMDB probe (keeps offline/dev saves working).
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
        if (!TmdbSettingsStore.Accepts(key))
            return BadRequest(new { ok = false, status = "invalid", message = "Enter a usable TMDB API key (32-character v3 key or v4 access token)." });
        var probe = await ProbeKeyAsync(key!, ct);
        var message = probe.Status switch
        {
            "ok" => "TMDB accepted this key.",
            "invalid" => "TMDB rejected that key. Check it in your TMDB account settings.",
            _ => "Could not reach TMDB. Check your network and try again.",
        };
        return Ok(new { ok = probe.Status == "ok", status = probe.Status, message });
    }

    private async Task<(string Status, string? Detail)> ProbeKeyAsync(string key, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            using var client = http.CreateClient("TorrentFlow.SourceHealth");
            using var request = TmdbClient.BuildRequest(TmdbClient.NormalizeCredential(key), $"{TmdbClient.Base}/configuration", []);
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            var status = response.IsSuccessStatusCode ? "ok" :
                response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden ? "invalid" : "unavailable";
            return (status, null);
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException)
        {
            return ("unavailable", e.Message);
        }
    }
}
