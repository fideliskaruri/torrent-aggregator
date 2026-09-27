using Microsoft.AspNetCore.Mvc;

namespace TorrentFlow.Library.Features.Grabs;

[ApiController, Route("api/client/torrents/{hash}/alternatives")]
public sealed class ReleaseSwapController(ReleaseSwapService swaps) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(string hash, CancellationToken ct)
    {
        try { return Ok(await swaps.Alternatives(hash, ct)); }
        catch (InvalidOperationException error) { return Conflict(new { message = error.Message }); }
    }

    public sealed record SwapInput(string Token);

    [HttpPost]
    public async Task<IActionResult> Post(string hash, SwapInput input, CancellationToken ct)
    {
        var result = await swaps.Swap(hash, input.Token, ct);
        return result.Ok ? Ok(result) : Conflict(result);
    }
}
