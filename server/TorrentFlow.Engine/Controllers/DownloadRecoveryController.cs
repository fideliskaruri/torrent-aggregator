using System.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Engine.Controllers;

[ApiController]
[Route("api/settings/download-recovery")]
public sealed class DownloadRecoveryController(ClientSettingsStore settings, IOptions<EngineOptions> options, IConfiguration configuration) : ControllerBase
{
    // A proxy can connect from loopback: forwarded requests are never owner requests. Remote-access middleware
    // must also deny this route on its dedicated listener, before controllers execute.
    internal static bool IsOwner(HttpContext context, string? ownerUrls = null) =>
        (context.Connection.RemoteIpAddress is null || IPAddress.IsLoopback(context.Connection.RemoteIpAddress))
        && !context.Request.Headers.ContainsKey("Forwarded")
        && !context.Request.Headers.ContainsKey("CF-Connecting-IP")
        && !context.Request.Headers.Keys.Any(k => k.StartsWith("X-Forwarded-", StringComparison.OrdinalIgnoreCase))
        && (context.Connection.LocalPort == 0 || ownerUrls is null
            || ownerUrls.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Any(url => Uri.TryCreate(url.Replace("://*:", "://localhost:").Replace("://+:", "://localhost:"), UriKind.Absolute, out var uri)
                    && uri.Port == context.Connection.LocalPort));

    private bool OwnerRequest() => IsOwner(HttpContext, configuration["urls"]
        ?? Environment.GetEnvironmentVariable("ASPNETCORE_URLS") ?? "http://127.0.0.1:3000");

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        if (!OwnerRequest()) return NotFound();
        Response.Headers.CacheControl = "no-store";
        var config = await settings.GetConfigAsync(ct);
        var service = HttpContext.RequestServices.GetRequiredService<DownloadRecoveryService>();
        return Ok(new { dataDirectory = options.Value.DataDirectory, downloadDirectory = config.DownloadRoot,
            hasMedia = await service.HasMediaAsync(ct) });
    }

    [HttpPost]
    public async Task<IActionResult> Import(CancellationToken ct)
    {
        if (!OwnerRequest()) return NotFound();
        Response.Headers.CacheControl = "no-store";
        try { return Ok(await HttpContext.RequestServices.GetRequiredService<DownloadRecoveryService>().ImportAsync(ct)); }
        catch (InvalidOperationException) { return BadRequest(new { error = "Choose and save a download folder in Settings first." }); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        { return Conflict(new { error = "Could not scan the download folder. Check access and try again." }); }
    }

    [HttpGet("sources")]
    public async Task<IActionResult> Sources(CancellationToken ct)
    {
        if (!OwnerRequest()) return NotFound();
        Response.Headers.CacheControl = "no-store";
        return Ok(await HttpContext.RequestServices.GetRequiredService<ExternalDownloadImportService>().DiscoverAsync(ct));
    }

    [HttpPost("sources")]
    public async Task<IActionResult> ImportSources([FromBody] ExternalDownloadImportRequest request, CancellationToken ct)
    {
        if (!OwnerRequest()) return NotFound();
        Response.Headers.CacheControl = "no-store";
        try { return Ok(await HttpContext.RequestServices.GetRequiredService<ExternalDownloadImportService>().ImportAsync(request, ct)); }
        catch (ArgumentException ex) { return BadRequest(new { error = ex.Message }); }
    }
}
