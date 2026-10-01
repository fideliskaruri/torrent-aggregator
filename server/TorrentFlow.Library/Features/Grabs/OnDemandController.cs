using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
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
        // Every download is kept; older pages may still send "stream", which is accepted and treated as keep.
        f.Enum("retention", ["stream", "keep"]);
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
        var result = await grabs.Grab(new(title, type, new EpisodeCursor(season, episode), id, workId, resolution, cap), ct);
        var status = result.Ok ? 200 : result.Storage != null ? 507 : 502;
        if (result.Ok || result.NoReleaseFound == null) return StatusCode(status, result);
        // Nothing fitted: name the title so the Library can offer "Pick a release yourself". Older library rows have
        // no WorkId, so fall back to the work this title's key names.
        await using var keys = await factory.CreateDbContextAsync(ct);
        var slug = TorrentFlow.Core.Text.WorkKeySlug.WorkKeyFor(title);
        var workKey = workId != null
            ? await keys.Works.AsNoTracking().Where(w => w.Id == workId).Select(w => w.WorkKey).FirstOrDefaultAsync(ct)
            : await keys.Works.AsNoTracking().Where(w => w.WorkKey == slug).Select(w => w.WorkKey).FirstOrDefaultAsync(ct);
        if (workKey == null) return StatusCode(status, result);
        var json = HttpContext.RequestServices.GetRequiredService<IOptions<JsonOptions>>().Value.JsonSerializerOptions;
        var body = JsonSerializer.SerializeToNode(result, json)!.AsObject();
        body["workKey"] = workKey;
        return StatusCode(status, body);
    }
}
