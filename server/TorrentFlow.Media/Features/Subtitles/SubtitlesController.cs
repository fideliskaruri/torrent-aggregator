using Microsoft.AspNetCore.Mvc;

namespace TorrentFlow.Media.Features.Subtitles;

[ApiController]
[Route("api/subtitles/{infoHash}")]
public sealed class SubtitlesController(SubtitlesService service) : ControllerBase
{
    [HttpGet]
    [HttpHead]
    [HttpDelete]
    public Task<IActionResult> Handle(string infoHash, CancellationToken ct) =>
        service.HandleAsync(infoHash, HttpContext, ct);
}
