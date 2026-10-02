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
        var keys = rows.Select(t => t.WorkKey).Distinct().ToArray();
        var titles = await db.Works.AsNoTracking().Where(w => keys.Contains(w.WorkKey))
            .ToDictionaryAsync(w => w.WorkKey, w => new { w.CanonicalTitle, w.MediaType, w.Year }, ct);
        // `looking` is true while a search for the target runs; otherwise it waits for `nextAttemptAt` (null: due now).
        string Title(string workKey) => titles.GetValueOrDefault(workKey)?.CanonicalTitle ?? TorrentFlow.Core.Text.WorkKeySlug.DisplayTitle(workKey);
        string Pick(string workKey, int? season, int? episode) =>
            WantedQueue.PickLink(workKey, Title(workKey), season, episode, ReleasePicker.DefaultQuery(Title(workKey), season, episode));
        // `pickLink` opens "Pick a release yourself" for the row; `seasonPickLink` for its whole season.
        return Ok(new { queue = wanted.Snapshot(),
            wanted = rows.Select(t => new { t.WorkKey, title = titles.GetValueOrDefault(t.WorkKey)?.CanonicalTitle,
                mediaType = titles.GetValueOrDefault(t.WorkKey)?.MediaType, year = titles.GetValueOrDefault(t.WorkKey)?.Year, t.Season, t.Episode, t.Error, why = wanted.Why(t.TargetKey),
                looking = wanted.Looking(t.WorkKey, t.Season, t.Episode), nextAttemptAt = wanted.NextAttempt(t.WorkKey, t.Season, t.Episode), t.UpdatedAt,
                pickLink = Pick(t.WorkKey, t.Season, t.Episode), seasonPickLink = t.Season == null ? null : Pick(t.WorkKey, t.Season, null) }) });
    }

    /// <summary>Stop looking for a film (no season), a season's episodes, or one episode. Survives a restart.</summary>
    [HttpDelete]
    public async Task<IActionResult> Stop(CancellationToken ct)
    {
        var (workKey, season, episode) = Target();
        var removed = await wanted.StopAsync(workKey, season, episode, ct);
        return Ok(new { ok = true, removed });
    }

    /// <summary>Try now: search for a film, a season's episodes or one episode at once instead of after its wait.</summary>
    [HttpPost("try")]
    public IActionResult TryNow()
    {
        var (workKey, season, episode) = Target();
        wanted.TryNow(workKey, season, episode);
        return Accepted(new { ok = true });
    }

    private (string WorkKey, int? Season, int? Episode) Target()
    {
        Fields.Guard(Request);
        var workKey = Fields.Query(Request, "workKey", required: true, maxLength: 512)!;
        var season = Fields.QueryInt(Request, "season", 0, 10000);
        var episode = Fields.QueryInt(Request, "episode", 1, 100000);
        if (episode != null && season == null) Fields.Fail("An episode needs its season.", "episode");
        return (workKey, season, episode);
    }
}
