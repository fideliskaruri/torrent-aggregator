using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using TorrentFlow.Core.Contracts.Engine;

namespace TorrentFlow.Engine.Controllers;

/// <summary>
/// The owner's decision on a held download (docs/english-gates-plan.md section 1): Keep moves its files from the stage
/// folder into the library; Find another deletes them, blocks the release and lets the finder pick again. Owner only.
/// </summary>
[ApiController]
public sealed partial class DownloadPromotionController(ITorrentEngine engine) : ControllerBase
{
    [GeneratedRegex("^(?:builtin:)?([0-9a-f]{40})$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex BuiltinId();

    [HttpPost("api/downloads/{transferId}/keep")]
    public Task<IActionResult> Keep(string transferId, CancellationToken ct) => DecideAsync(transferId, keep: true, ct);

    [HttpPost("api/downloads/{transferId}/find-another")]
    public Task<IActionResult> FindAnother(string transferId, CancellationToken ct) => DecideAsync(transferId, keep: false, ct);

    private async Task<IActionResult> DecideAsync(string transferId, bool keep, CancellationToken ct)
    {
        // Claims set by the remote access middleware (Api); read by name because this module cannot reference it.
        if (User.FindFirst("tf:role")?.Value == "requester")
            return StatusCode(403, new { ok = false, reason = "requester", code = "requester_forbidden",
                error = "This part of TorrentFlow is only available to its owner.", message = "This part of TorrentFlow is only available to its owner." });
        if (BuiltinId().Match((transferId ?? "").Trim()) is not { Success: true } match)
            return BadRequest(new { ok = false, reason = "invalid-id", error = "That is not a download id.", message = "Reload the page and try again." });
        var hash = match.Groups[1].Value.ToLowerInvariant();
        var result = keep ? await engine.KeepAsync(hash, ct) : await engine.FindAnotherAsync(hash, CancellationToken.None);
        if (result.Ok) return Ok(new { ok = true, message = result.Message });
        var status = result.Message == TorrentEngineService.NotFound ? 404 : 409;
        return StatusCode(status, new { ok = false, reason = status == 404 ? "not-found" : "not-held", error = result.Message, message = result.Message });
    }
}
