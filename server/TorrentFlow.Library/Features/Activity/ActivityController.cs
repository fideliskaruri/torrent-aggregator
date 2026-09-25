using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data;
using TorrentFlow.Library.Features.Common;

namespace TorrentFlow.Library.Features.Activity;

[ApiController, ServiceFilter(typeof(LibraryExceptionFilter))]
public sealed class ActivityController(IDbContextFactory<TorrentFlowDbContext> factory, ActivityService activity) : ControllerBase
{
    [HttpGet("api/history")]
    public async Task<IActionResult> History(CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var items = await db.DownloadHistories.AsNoTracking().Where(x => x.UserId == LocalUser.Id && x.Retention != "stream")
            .OrderByDescending(x => x.CreatedAt).Take(100).ToListAsync(ct);
        return Ok(new { items = items.Select(LibraryJson.Row) });
    }
    [HttpDelete("api/history")]
    public async Task<IActionResult> Delete([FromQuery] string? id, CancellationToken ct)
    {
        Fields.Guard(Request);
        await using var db = await factory.CreateDbContextAsync(ct);
        await db.DownloadHistories.Where(x => x.UserId == LocalUser.Id && (string.IsNullOrEmpty(id) || x.Id == id)).ExecuteDeleteAsync(ct);
        return Ok(new { ok = true });
    }
    [HttpGet("api/activity")]
    public async Task<IActionResult> Get([FromQuery] string? filter, [FromQuery] string? limit, [FromQuery] string? cursor, CancellationToken ct) =>
        Ok(await activity.Page(filter, limit, cursor, ct));
    [HttpGet("api/activity/unread")]
    public async Task<IActionResult> Unread([FromQuery] string? since, CancellationToken ct) => Ok(await activity.Unread(since, ct));
}
