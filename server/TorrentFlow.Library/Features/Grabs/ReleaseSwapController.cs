using Microsoft.AspNetCore.Mvc;

namespace TorrentFlow.Library.Features.Grabs;

[ApiController, Route("api/client/torrents/{hash}/alternatives")]
public sealed class ReleaseSwapController(ReleaseSwapService swaps) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(string hash, [FromQuery] string? source, CancellationToken ct)
    {
        try { return Ok(await swaps.Alternatives(hash, source, ct)); }
        catch (InvalidOperationException error) { return Conflict(new { message = error.Message }); }
    }

    /// <summary>
    /// Either a token from GET, or <c>best: true</c> (optionally with a source) to search and swap in one step. A token for
    /// a blocked release also needs <c>allowBlocked: true</c> ("Use it anyway"); best never picks a blocked release.
    /// </summary>
    public sealed record SwapInput(string? Token, bool? Best, string? Source, bool? AllowBlocked = null);

    [HttpPost]
    public async Task<IActionResult> Post(string hash, SwapInput input, CancellationToken ct)
    {
        if (input.Best == true)
        {
            try
            {
                var best = await swaps.SwapBest(hash, input.Source, ct);
                return best.Ok ? Ok(best) : Conflict(best);
            }
            catch (InvalidOperationException error) { return Conflict(new { ok = false, message = error.Message }); }
        }
        if (string.IsNullOrWhiteSpace(input.Token))
            return BadRequest(new { message = "Choose a release, or ask for the best one." });
        var result = await swaps.Swap(hash, input.Token, input.AllowBlocked == true, ct);
        return result.Ok ? Ok(result) : Conflict(result);
    }
}
