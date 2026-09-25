using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Grabs;

[ApiController, Route("api/library/ondemand"), ServiceFilter(typeof(LibraryExceptionFilter))]
public sealed class OnDemandController(IDbContextFactory<TorrentFlowDbContext> factory, GrabService grabs) : ControllerBase
{
    [HttpPost]
    public async Task<IActionResult> Post(CancellationToken ct)
    {
        try { return await Grab(ct); }
        catch (LibraryRequestException error)
        {
            // define-route.ts: every failure uses the canonical { ok: false, error, message, field? } envelope.
            var body = LibraryJson.Object(("ok", false), ("error", error.Message), ("message", error.Message));
            if (error.Field != null) body["field"] = error.Field;
            return StatusCode(error.Status, body);
        }
    }

    private async Task<IActionResult> Grab(CancellationToken ct)
    {
        var f = await Fields.Read(Request, ct);
        var id = f.String("watchListItemId");
        var title = f.String("title");
        var type = f.String("mediaType") ?? "tv";
        var season = f.Int("season", int.MaxValue, true)!.Value;
        var episode = f.Int("episode", int.MaxValue, true)!.Value;
        var retention = f.Enum("retention", ["stream", "keep"]) ?? "keep";
        var cap = f.Bool("overrideStorageCap") == true;
        int? resolution = null;
        string? workId = null;
        if (!string.IsNullOrEmpty(id))
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            var item = await db.WatchListItems.FirstOrDefaultAsync(x => x.Id == id && x.UserId == LocalUser.Id, ct);
            if (item == null) return NotFound(new { ok = false, error = "Not found", message = "Library item not found" });
            title = item.Title; type = item.MediaType; resolution = item.PreferredResolution; workId = item.WorkId;
        }
        if (string.IsNullOrWhiteSpace(title)) return BadRequest(new { ok = false, error = "Missing title", message = "title or watchListItemId required" });
        var result = await grabs.Grab(new(title, type, new EpisodeCursor(season, episode), id, workId, resolution, retention, cap), ct);
        return StatusCode(result.Ok ? 200 : result.Storage != null ? 507 : 502, result);
    }
}
