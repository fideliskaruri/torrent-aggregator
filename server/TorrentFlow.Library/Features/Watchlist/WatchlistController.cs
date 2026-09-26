using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Automation;

namespace TorrentFlow.Library.Features.Watchlist;

[ApiController, Route("api/watchlist"), ServiceFilter(typeof(LibraryExceptionFilter))]
public sealed class WatchlistController(IDbContextFactory<TorrentFlowDbContext> factory,
    IMetadataResolver metadata, ITorrentSearchService search, AutomationWake wake) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var items = await db.WatchListItems.AsNoTracking().Where(x => x.UserId == LocalUser.Id).OrderByDescending(x => x.UpdatedAt).ToListAsync(ct);
        return Ok(new { items = items.Select(LibraryJson.Row) });
    }

    [HttpPost, HttpPatch]
    public async Task<IActionResult> Save(CancellationToken ct)
    {
        var f = await Fields.Read(Request, ct);
        var patch = HttpMethods.IsPatch(Request.Method);
        var id = patch ? f.String("id", true, 128) : null;
        var type = patch ? null : f.String("mediaType", true, 32)?.ToLowerInvariant();
        type = type switch { "movies" => "movie", "series" => "tv", _ => type };
        if (!patch && type is not ("anime" or "movie" or "tv")) Fields.Fail("mediaType must be anime, movie, or tv", "mediaType");
        var externalId = patch ? null : f.String("externalId", true, 128);
        var title = patch ? null : f.String("title", true);
        var poster = patch ? null : f.String("posterUrl", max: 2048, nullable: true);
        var synopsis = patch ? null : f.String("synopsis", max: 20000, nullable: true);
        var rating = patch ? null : f.Number("rating", max: 10, nullable: true);
        var status = f.Enum("status", ["watching", "planned", "completed", "dropped"]);
        var monitored = f.Bool("monitored");
        var fromSeason = f.Int("fromSeason", 10000);
        var fromEpisode = f.Int("fromEpisode");
        var cursorSeason = patch ? f.Int("cursorSeason", 10000) : null;
        var cursorEpisode = patch ? f.Int("cursorEpisode") : null;
        var lastEpisode = patch ? f.String("lastEpisode", max: 100, nullable: true) : null;
        var mode = f.Enum("monitorMode", ["ongoing"]);
        var resolution = f.Int("preferredResolution");
        if (resolution != null && !new[] { 480, 720, 1080, 2160 }.Contains(resolution.Value))
            Fields.Fail("preferredResolution must be one of 480, 720, 1080, 2160");
        await using var db = await factory.CreateDbContextAsync(ct);
        var item = patch
            ? await db.WatchListItems.FirstOrDefaultAsync(x => x.Id == id && x.UserId == LocalUser.Id, ct)
            : await db.WatchListItems.FirstOrDefaultAsync(x => x.MediaType == type && x.ExternalId == externalId && x.UserId == LocalUser.Id, ct);
        if (patch && item == null) return NotFound(new { error = "Not found" });
        if (!patch && string.IsNullOrEmpty(poster))
        {
            try
            {
                var art = await metadata.ResolveMetadataAsync(title!, type, ct);
                poster = art?.PosterUrl;
                synopsis ??= art?.Synopsis;
                rating ??= art?.Rating;
            }
            catch (Exception) when (!ct.IsCancellationRequested) { /* Artwork cannot block adding a title. */ }
        }
        var now = DateTime.UtcNow;
        var previousCursor = item == null ? null : EpisodeCursor.Resolve(item);
        var previousResolution = item?.PreferredResolution;
        if (item == null)
        {
            item = new WatchListItem { Id = Ids.New(), UserId = LocalUser.Id, Title = title!, MediaType = type!,
                ExternalId = externalId!, Status = status ?? "watching", Monitored = monitored ?? true,
                MonitorMode = mode ?? "ongoing", CreatedAt = now, LastChecked = now };
            db.WatchListItems.Add(item);
        }
        if (!patch)
        {
            item.Title = title!;
            if (!string.IsNullOrEmpty(poster)) item.PosterUrl = poster;
            if (!string.IsNullOrEmpty(synopsis)) item.Synopsis = synopsis;
            if (rating != null) item.Rating = rating;
        }
        if (status != null) item.Status = status;
        if (monitored != null) item.Monitored = monitored;
        if (mode != null) item.MonitorMode = mode;
        if (f.Has("preferredResolution")) item.PreferredResolution = resolution;
        if (patch) item.LastChecked = now;
        if (f.Has("lastEpisode")) item.LastEpisode = lastEpisode;
        EpisodeCursor? cursor = null;
        if (fromSeason != null && (patch || EpisodeCursor.IsSeries(item.MediaType)))
        {
            cursor = new(fromSeason.Value, fromEpisode ?? 1);
            item.FromSeason = cursor.Value.Season;
            item.FromEpisode = cursor.Value.Episode;
        }
        else if (patch && cursorSeason != null && cursorEpisode != null) cursor = new(cursorSeason.Value, cursorEpisode.Value);
        else if (patch && f.Has("lastEpisode"))
        {
            var copy = new WatchListItem { Title = item.Title, MediaType = item.MediaType, LastEpisode = lastEpisode, FromSeason = item.FromSeason, FromEpisode = item.FromEpisode };
            cursor = EpisodeCursor.Resolve(copy);
        }
        if (cursor != null)
        {
            item.CursorSeason = cursor.Value.Season;
            item.CursorEpisode = cursor.Value.Episode;
            item.NextEpisodeHint = cursor.Value.Query(item.Title);
        }
        item.UpdatedAt = now;
        item.NextCheckAt = item.Monitored == true && item.Status is "watching" or "planned" ? now : null;
        item.NextCheckReason = item.NextCheckAt == null ? null : "next check";
        if (EpisodeCursor.Resolve(item) != previousCursor || item.PreferredResolution != previousResolution)
        {
            item.SeederWaitSince = null;
            item.CursorMisses = 0;
        }
        await db.SaveChangesAsync(ct);
        wake.Wake();
        await Promote(db, item, ct);
        return Ok(new { item = LibraryJson.Row(item) });
    }

    [HttpDelete]
    public async Task<IActionResult> Delete(CancellationToken ct)
    {
        Fields.Guard(Request);
        var id = Fields.Query(Request, "id", required: true, maxLength: 128)!;
        await using var db = await factory.CreateDbContextAsync(ct);
        var item = await db.WatchListItems.FirstOrDefaultAsync(x => x.UserId == LocalUser.Id && x.Id == id, ct);
        if (item != null)
        {
            await Promote(db, item, ct);
            db.WatchListItems.Remove(item);
            await db.SaveChangesAsync(ct);
        }
        return Ok(new { ok = true, filesKept = true });
    }

    private static async Task Promote(TorrentFlowDbContext db, WatchListItem item, CancellationToken ct)
    {
        var hashes = await db.PlaybackProgresses.Where(x => x.UserId == LocalUser.Id && x.WatchListItemId == item.Id).Select(x => x.InfoHash).ToListAsync(ct);
        var streams = await db.EngineTorrents.AsNoTracking().Where(x => x.UserId == LocalUser.Id && (x.Origin == "stream" || x.Origin == "prewarm"))
            .Select(x => new { x.Hash, x.Name }).ToListAsync(ct);
        hashes.AddRange(streams.Where(x => ReleaseSelection.Normalize(ReleaseSelection.CleanTitle(x.Name)) == ReleaseSelection.Normalize(item.Title)).Select(x => x.Hash));
        await db.EngineTorrents.Where(x => x.UserId == LocalUser.Id && x.Origin != "user" &&
            (hashes.Contains(x.Hash) || (item.WorkId != null && x.WorkId == item.WorkId)))
            .ExecuteUpdateAsync(x => x.SetProperty(t => t.Origin, "user"), ct);
    }

    [HttpPost("check")]
    public async Task<IActionResult> Check(CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var items = await db.WatchListItems.Where(x => x.UserId == LocalUser.Id && (x.Status == "watching" || x.Status == "planned")).ToListAsync(ct);
        var global = await db.ClientSettings.Where(x => x.UserId == LocalUser.Id).Select(x => x.PreferredResolution).FirstOrDefaultAsync(ct) ?? 1080;
        var updates = new List<object>();
        foreach (var item in items)
        {
            var next = EpisodeCursor.Parse(item.LastEpisode)?.Next();
            var query = next?.Query(item.Title) ?? item.Title;
            string? latest = null;
            try
            {
                var results = await search.SearchAsync(new() { Query = query, Category = item.MediaType == "movie" ? "movies" : item.MediaType,
                    Limit = 12, Enrich = false, TargetResolution = item.PreferredResolution, Filters = new() { MinSeeders = 1 } }, ct);
                var best = results.Results.FirstOrDefault(x => ReleaseSelection.MeetsFloor(x.Title, item.PreferredResolution ?? global));
                if (best != null)
                {
                    var ep = EpisodeCursor.Parse(best.Title);
                    latest = ep == null || ep.Value.IsAfter(EpisodeCursor.Parse(item.LastEpisode)) ? best.Title : null;
                    item.LatestReleaseTitle = best.Title;
                    item.LatestReleaseMagnet = best.Magnet;
                    item.LatestReleaseAt = DateTime.TryParse(best.PublishedAt, out var published) ? published.ToUniversalTime() : DateTime.UtcNow;
                    item.LastChecked = item.UpdatedAt = DateTime.UtcNow;
                    item.NextEpisodeHint = ep?.Next().Query(item.Title) ?? query;
                    query = item.NextEpisodeHint;
                }
            }
            catch (Exception) when (!ct.IsCancellationRequested) { }
            updates.Add(LibraryJson.Object(("id", item.Id), ("title", item.Title), ("latestReleaseTitle", latest), ("nextEpisodeHint", query)));
        }
        await db.SaveChangesAsync(ct);
        return Ok(new { updates });
    }
}
