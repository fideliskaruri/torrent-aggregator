using System.Text.Json.Nodes;
using System.Xml;
using System.Xml.Linq;
using Microsoft.AspNetCore.Mvc;
using TorrentFlow.Core.Sources;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Settings;

[ApiController]
[Route("api/settings/sources")]
public sealed class SourcesController(SourceRegistry registry, IHttpClientFactory http) : ControllerBase
{
    private bool Allowed() => Request.Headers["Sec-Fetch-Site"].ToString().ToLowerInvariant() is "" or "none" or "same-origin";
    [HttpGet]
    public IActionResult Get()
    {
        Response.Headers.CacheControl = "no-store";
        var entries = registry.Snapshot();
        return Ok(new { sources = entries.Select(registry.Public), error = registry.LoadError });
    }

    [HttpPut("{id}")]
    [RequestSizeLimit(32768)]
    public IActionResult Put(string id, [FromBody] JsonObject body)
    {
        if (!Allowed()) return StatusCode(403, new { error = "Cross-site writes are not allowed." });
        try
        {
            string[] allowed = ["enabled", "priority", "baseUrl", "mirrors", "timeoutMs", "categories", "options", "credential", "kind", "type"];
            if (body.Any(p => !allowed.Contains(p.Key))) return BadRequest(new { error = "Unknown source field." });
            var existing = registry.Find(id);
            if (existing is null && (body["type"]?.GetValue<string>() != "torznab" || body["kind"]?.GetValue<string>() != "torrent"))
                return BadRequest(new { error = "Only custom Torznab sources can be added." });
            if (existing is not null && (body.ContainsKey("type") || body.ContainsKey("kind")))
                return BadRequest(new { error = "Source implementation and kind cannot be changed." });
            if (body.TryGetPropertyValue("credential", out var credential) && credential is not null && existing?.Type == "tmdb" &&
                !TmdbSettingsStore.Accepts(credential.GetValue<string>()))
                return BadRequest(new { error = "Enter a usable TMDB API key." });
            registry.Update(id, body);
            return Get();
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.Text.Json.JsonException)
        { return BadRequest(new { error = "Invalid source settings. Check URLs, categories, priority and timeout." }); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        { return StatusCode(503, new { error = "Could not save sources." }); }
    }

    [HttpDelete("{id}")]
    public IActionResult Delete(string id)
    {
        if (!Allowed()) return StatusCode(403, new { error = "Cross-site writes are not allowed." });
        try { registry.Remove(id); return Get(); }
        catch (ArgumentException) { return BadRequest(new { error = "Disable built-in sources instead of removing them." }); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        { return StatusCode(503, new { error = "Could not remove source." }); }
    }

    [HttpPost("{id}/test")]
    public async Task<IActionResult> Test(string id, CancellationToken ct)
    {
        if (!Allowed()) return StatusCode(403, new { error = "Cross-site writes are not allowed." });
        var source = registry.Find(id);
        if (source is null) return NotFound();
        var credential = registry.Credential(source);
        // Without a key TMDB answers 401, which read as "check its URL". Name the real cause instead.
        if (source.Type == "tmdb" && !TmdbCredentials.IsUsable(credential))
            return Ok(new { ok = false, status = "credential_required", message = "TMDB needs an API key. Add one, or turn TMDB off." });
        try
        {
            return await SourceExecution.RunAsync<IActionResult>(source, async token =>
            {
                var suffix = source.Type switch
                {
                    "tvmaze" => "/shows/1", "cinemeta" => "/meta/movie/tt0038650.json",
                    "tmdb" => "/configuration", "torznab" => "?t=caps", "nyaa" => "/?page=rss",
                    "apibay" => "/q.php?q=public%20domain&cat=0", "yts" => "/list_movies.json?limit=1",
                    "eztv" => "/get-torrents?limit=1&page=1", "animetosho" => "/json?q=test", "subsplease" => "/api/?f=search&tz=UTC&s=test",
                    "therarbg" => "/get-posts/keywords:test:format:json/", _ => ""
                };
                using var request = source.Type == "tmdb" && !string.IsNullOrEmpty(credential)
                    ? TmdbClient.BuildRequest(credential, source.BaseUrl.TrimEnd('/') + suffix, [])
                    : new HttpRequestMessage(source.Type == "anilist" ? HttpMethod.Post : HttpMethod.Get,
                        source.BaseUrl.TrimEnd('/') + suffix + (source.Type == "torznab" && credential is not null ? "&apikey=" + Uri.EscapeDataString(credential) : ""));
                if (source.Type == "anilist") request.Content = new StringContent("{\"query\":\"{ Page(perPage:1) { media(type:ANIME) { id } } }\"}", System.Text.Encoding.UTF8, "application/json");
                using var client = http.CreateClient("TorrentFlow.SourceHealth");
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
                var ok = response.IsSuccessStatusCode;
                string? message = null;
                if (ok && source.Type == "torznab")
                {
                    await response.Content.LoadIntoBufferAsync(1024 * 1024, token);
                    await using var stream = await response.Content.ReadAsStreamAsync(token);
                    try
                    {
                        using var reader = XmlReader.Create(stream, new XmlReaderSettings
                        {
                            Async = true, DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null,
                            MaxCharactersInDocument = 1024 * 1024
                        });
                        var caps = await XDocument.LoadAsync(reader, LoadOptions.None, token);
                        ok = caps.Root?.Name.LocalName == "caps";
                    }
                    catch (XmlException)
                    {
                        ok = false;
                    }
                    if (!ok)
                        message = "That address answered, but not as a Torznab indexer.";
                }
                if (!response.IsSuccessStatusCode) message = FailureMessage(source.Type, (int)response.StatusCode);
                return Ok(new { ok, status = ok ? "ok" : "unavailable", message });
            }, ct);
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or XmlException or IOException)
        {
            // XmlException here is only reached when the response body could not be read as Torznab caps.
            string message;
            if (source.Type == "torznab" && e is XmlException)
                message = "That address answered, but not as a Torznab indexer.";
            else if (e is OperationCanceledException or TaskCanceledException)
                message = "The source did not answer in time. Check the address and try again.";
            else if (e is HttpRequestException http)
            {
                var detail = http.InnerException?.Message ?? http.Message;
                message = detail.Contains("refused", StringComparison.OrdinalIgnoreCase)
                        || detail.Contains("actively refused", StringComparison.OrdinalIgnoreCase)
                    ? "Could not connect. The host refused the connection."
                    : detail.Contains("No such host", StringComparison.OrdinalIgnoreCase)
                        || detail.Contains("not known", StringComparison.OrdinalIgnoreCase)
                        || detail.Contains("Name or service not known", StringComparison.OrdinalIgnoreCase)
                        || detail.Contains("nodename nor servname", StringComparison.OrdinalIgnoreCase)
                    ? "Could not look up that host name. Check the address."
                    : detail.Contains("SSL", StringComparison.OrdinalIgnoreCase)
                        || detail.Contains("TLS", StringComparison.OrdinalIgnoreCase)
                        || detail.Contains("certificate", StringComparison.OrdinalIgnoreCase)
                    ? "Could not open a secure connection to that source."
                    : "Could not reach that source. Check the address and your network.";
            }
            else
                message = "Could not reach that source. Check the address and your network.";
            return Ok(new { ok = false, status = "unavailable", message });
        }
    }

    /// <summary>Why a source that answered did not pass, in words that point at the fix.</summary>
    internal static string FailureMessage(string type, int status) => status switch
    {
        401 or 403 => type switch
        {
            "tmdb" => "TMDB did not accept the API key. Check the key and try again.",
            "torznab" => "The indexer did not accept the API key. Check the key and try again.",
            _ => "The source refused the request. It may need a key, or it may block this network.",
        },
        404 => "The source answered, but that address was not found. Check the base URL.",
        429 => "The source is limiting requests. Wait a minute and try again.",
        >= 500 => "The source is having problems right now. Try again later.",
        _ => $"The source answered with HTTP {status}. Check its settings and try again.",
    };
}
