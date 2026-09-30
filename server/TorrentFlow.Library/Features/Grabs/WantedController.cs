using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data;
using TorrentFlow.Library.Features.Common;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>
/// What the wanted queue is still looking for, when it tries each title and season next, and <c>why</c> each one is
/// still missing: what the last search really returned (see <see cref="GrabFailure.Detail"/>).
/// </summary>
[ApiController, Route("api/wanted"), ServiceFilter(typeof(LibraryExceptionFilter))]
public sealed class WantedController(WantedQueue wanted, IDbContextFactory<TorrentFlowDbContext> factory) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var rows = await db.AcquisitionTargets.AsNoTracking()
            .Where(t => t.UserId == LocalUser.Id && t.Status == "queued" && t.InfoHash == null && (t.Scope == "episode" || t.Scope == "title"))
            .OrderBy(t => t.WorkKey).ThenBy(t => t.Season).ThenBy(t => t.Episode)
            .Select(t => new { t.TargetKey, t.WorkKey, t.Season, t.Episode, t.Error, t.UpdatedAt }).ToListAsync(ct);
        return Ok(new { queue = wanted.Snapshot(),
            wanted = rows.Select(t => new { t.WorkKey, t.Season, t.Episode, t.Error, why = wanted.Why(t.TargetKey), t.UpdatedAt }) });
    }
}
