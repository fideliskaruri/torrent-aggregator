using Microsoft.AspNetCore.Mvc;
using TorrentFlow.Engine.Layout;

namespace TorrentFlow.Engine.Controllers;

[ApiController]
public sealed class LayoutTidyController(ILayoutTidy tidy) : ControllerBase
{
    /// <summary>Moves finished downloads still nested in their release folders into the flat library layout.</summary>
    [HttpPost("api/client/torrents/tidy")]
    public async Task<IActionResult> Tidy(CancellationToken ct) => Ok(await tidy.TidyAsync(ct));
}
