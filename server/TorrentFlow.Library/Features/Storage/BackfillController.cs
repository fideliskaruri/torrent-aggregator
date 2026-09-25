using System.Globalization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data;
using TorrentFlow.Library.Features.Common;

namespace TorrentFlow.Library.Features.Storage;

[ApiController, Route("api/library/backfill-estimate"), ServiceFilter(typeof(LibraryExceptionFilter))]
public sealed class BackfillController(IDbContextFactory<TorrentFlowDbContext> factory) : ControllerBase
{
    public const string SetupMessage = "Downloads need setup first — choose a download folder and set a storage cap in Settings → Downloads.";
    public static string Format(double bytes) => bytes < 0 || !double.IsFinite(bytes) ? "?" :
        bytes >= 1e12 ? (bytes / 1e12).ToString("F1", CultureInfo.InvariantCulture) + " TB" :
        bytes >= 1e9 ? (bytes / 1e9).ToString("F1", CultureInfo.InvariantCulture) + " GB" :
        bytes >= 1e6 ? Math.Floor(bytes / 1e6 + .5).ToString(CultureInfo.InvariantCulture) + " MB" :
        Math.Floor(bytes + .5).ToString(CultureInfo.InvariantCulture) + " B";
    [HttpPost]
    public async Task<IActionResult> Post(CancellationToken ct)
    {
        // Like the Next route: no content-type or browser-origin gate (it never writes), and any unparseable body
        // is the same Invalid JSON envelope.
        Fields f;
        try
        {
            using var doc = await System.Text.Json.JsonDocument.ParseAsync(Request.Body, default, ct);
            f = new(doc.RootElement.ValueKind == System.Text.Json.JsonValueKind.Object
                ? doc.RootElement.Clone() : System.Text.Json.JsonDocument.Parse("{}").RootElement.Clone());
        }
        catch (System.Text.Json.JsonException)
        {
            return BadRequest(new { ok = false, error = "Invalid JSON", message = "Invalid JSON" });
        }
        var id = f.String("watchListItemId");
        var from = f.Number("fromSeason", min: -1e9) ?? 0;
        var to = f.Number("toSeason", min: -1e9) ?? 0;
        var perSeason = f.Number("episodesPerSeason", min: -1e9) ?? 22;
        var average = (f.Number("avgEpisodeGb", min: -1e9) ?? 1.5) * 1e9;
        var title = "Show";
        await using var db = await factory.CreateDbContextAsync(ct);
        if (!string.IsNullOrEmpty(id))
        {
            var item = await db.WatchListItems.FirstOrDefaultAsync(x => x.Id == id && x.UserId == LocalUser.Id, ct);
            if (item == null) return NotFound(new { ok = false, error = "Not found", message = "Library item not found" });
            title = item.Title;
            if (from < 1) from = item.FromSeason ?? item.CursorSeason ?? 1;
        }
        from = Math.Max(1, from); to = Math.Max(from, to);
        var seasons = to - from + 1;
        var episodes = seasons * perSeason;
        var estimate = Math.Floor(episodes * average + .5);
        var settings = await db.ClientSettings.FirstOrDefaultAsync(x => x.UserId == LocalUser.Id, ct);
        long? free = null;
        try { free = new DriveInfo(Path.GetPathRoot(settings?.BaseDownloadPath ?? settings?.SavePath ?? Environment.CurrentDirectory)!).AvailableFreeSpace; }
        catch (IOException) { }
        catch (ArgumentException) { }
        // The TS estimate calls canFitEstimate without a cap; preserve its setup-required result.
        return Ok(LibraryJson.Object(("ok", true), ("title", title), ("fromSeason", from), ("toSeason", to), ("seasons", seasons),
            ("episodes", episodes), ("estimatedBytes", estimate), ("estimatedLabel", Format(estimate)), ("freeBytes", free),
            ("freeLabel", free == null ? "unknown" : Format(free.Value)), ("canFit", false), ("message", SetupMessage),
            ("note", "Estimate only — confirm in UI before any bulk grab. Default monitoring never bulk-grabs.")));
    }
}
