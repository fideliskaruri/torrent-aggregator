using System.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Engine.Controllers;

[ApiController]
[Route("api/settings/download-recovery")]
public sealed class DownloadRecoveryController(ClientSettingsStore settings, IOptions<EngineOptions> options) : ControllerBase
{
    // A proxy can connect from loopback: forwarded requests are never owner requests. Remote-access middleware
    // must also deny this route on its dedicated listener, before controllers execute.
    internal static bool IsOwner(HttpContext context) =>
        (context.Connection.RemoteIpAddress is null || IPAddress.IsLoopback(context.Connection.RemoteIpAddress))
        && !context.Request.Headers.ContainsKey("Forwarded")
        && !context.Request.Headers.Keys.Any(k => k.StartsWith("X-Forwarded-", StringComparison.OrdinalIgnoreCase));

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        if (!IsOwner(HttpContext)) return NotFound();
        Response.Headers.CacheControl = "no-store";
        var config = await settings.GetConfigAsync(ct);
        var service = HttpContext.RequestServices.GetRequiredService<DownloadRecoveryService>();
        return Ok(new { dataDirectory = options.Value.DataDirectory, downloadDirectory = config.DownloadRoot,
            hasMedia = await service.HasMediaAsync(ct) });
    }

    [HttpPost]
    public async Task<IActionResult> Import(CancellationToken ct)
    {
        if (!IsOwner(HttpContext)) return NotFound();
        Response.Headers.CacheControl = "no-store";
        try { return Ok(await HttpContext.RequestServices.GetRequiredService<DownloadRecoveryService>().ImportAsync(ct)); }
        catch (InvalidOperationException) { return BadRequest(new { error = "Choose and save a download folder in Settings first." }); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        { return Conflict(new { error = "Could not scan the download folder. Check access and try again." }); }
    }
}
