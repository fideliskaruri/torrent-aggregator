using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Core.Scheduling;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Automation;
using TorrentFlow.Library.Features.Titles;
using TorrentFlow.Core.Text;

namespace TorrentFlow.Library.Features.Watchlist;

[ApiController, Route("api/watchlist"), ServiceFilter(typeof(LibraryExceptionFilter))]
public sealed class WatchlistController(IDbContextFactory<TorrentFlowDbContext> factory,
    IMetadataResolver metadata, ITorrentSearchService search, AutomationWake wake, IAirDateLookup airDates) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var items = await db.WatchListItems.AsNoTracking().Include(x => x.Work).Where(x => x.UserId == LocalUser.Id).OrderByDescending(x => x.UpdatedAt).ToListAsync(ct);
        var posters = await WorkPosters.LoadAsync(db, items.Select(x => WorkPosters.KeyFor(x.Work?.WorkKey, x.Title)), ct);
        var resolved = items.Select(x => (x.Id, Stored: x.PosterUrl, Resolved: WorkPosters.Pick(posters, WorkPosters.KeyFor(x.Work?.WorkKey, x.Title), x.PosterUrl))).ToList();
        await WorkPosters.StoreOnWatchlistAsync(db, resolved, ct);
        foreach (var (item, art) in items.Zip(resolved)) item.PosterUrl = art.Resolved;
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
        var workKey = patch ? null : f.String("workKey", max: 200, nullable: true);
        var provider = patch ? null : f.String("provider", max: 32, nullable: true);
        var providerId = patch ? null : f.String("providerId", max: 200, nullable: true);
        var status = f.Enum("status", ["watching", "planned", "completed", "dropped"]);
        var monitored = f.Bool("monitored");
        var fromSeason = f.Int("fromSeason", 10000);
        var fromEpisode = f.Int("fromEpisode");
        var cursorSeason = patch ? f.Int("cursorSeason", 10000) : null;
        var cursorEpisode = patch ? f.Int("cursorEpisode") : null;
        var lastEpisode = patch ? f.String("lastEpisode", max: 100, nullable: true) : null;
        var mode = f.Enum("monitorMode", [HuntCursor.OngoingMode, HuntCursor.NewEpisodesMode]);
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
                MonitorMode = HuntCursor.OngoingMode, CreatedAt = now, LastChecked = now };
            // A series added without a start season is "New episodes only": the absence is the answer.
            mode ??= EpisodeCursor.IsSeries(type) && fromSeason == null ? HuntCursor.NewEpisodesMode : null;
            db.WatchListItems.Add(item);
        }
        if (!patch)
        {
            item.Title = title!;
            if (!string.IsNullOrEmpty(poster)) item.PosterUrl = poster;
            if (!string.IsNullOrEmpty(synopsis)) item.Synopsis = synopsis;
            if (rating != null) item.Rating = rating;
        }
        if (!patch && item.WorkId == null) item.WorkId = await WorkFor(db, workKey, provider, providerId ?? externalId, item, ct);
        if (status != null) item.Status = status;
        if (monitored != null) item.Monitored = monitored;
        if (mode == null && fromSeason != null && HuntCursor.IsNewEpisodesOnly(item.MonitorMode)) mode = HuntCursor.OngoingMode;
        if (mode != null && mode != item.MonitorMode || mode == HuntCursor.NewEpisodesMode && item.NewEpisodesSince == null)
        {
            item.MonitorMode = mode!;
            item.NewEpisodesSince = HuntCursor.IsNewEpisodesOnly(mode) ? now : null;
            if (HuntCursor.IsNewEpisodesOnly(mode))
            {
                item.CursorSeason = null;
                item.CursorEpisode = null;
                item.NextEpisodeHint = null;
            }
        }
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
        if (EpisodeCursor.AwaitingFirstNewEpisode(item))
            await NewEpisodes.PinAsync(db, airDates, item, TimeSpan.FromSeconds(5), ct);
        wake.Wake();
        return Ok(new { item = LibraryJson.Row(item) });
    }

    /// <summary>
    /// The work a new row belongs to, so the hunter and on-demand grabs carry its catalog identity (the grab asks that
    /// provider whether it is anime): the title page's work, else the work holding this catalog id, else a new work with
    /// only that id, which its first grab or open fills from the provider. An AniList id is what an anime row's external
    /// id has always been. No catalog id and no work leaves the row unlinked, as before.
    /// </summary>
    private static async Task<string?> WorkFor(TorrentFlowDbContext db, string? workKey, string? provider, string? providerId,
        WatchListItem item, CancellationToken ct)
    {
        var identity = TitleIdentity.From(provider, providerId)
            ?? (item.MediaType == "anime" && int.TryParse(item.ExternalId, out var anilist) && anilist > 0 ? new("anilist", item.ExternalId) : null);
        var key = workKey?.Trim().ToLowerInvariant() is { Length: > 0 } k ? k
            : item.ExternalId.StartsWith("work:", StringComparison.Ordinal) ? item.ExternalId[5..] : null;
        var work = key == null ? null : await db.Works.AsNoTracking().FirstOrDefaultAsync(w => w.WorkKey == key, ct);
        if (work == null && identity != null)
            work = await db.Works.AsNoTracking().FirstOrDefaultAsync(w => w.Provider == identity.Provider && w.ProviderId == identity.ProviderId &&
                (w.MediaType == item.MediaType || identity.Provider == "anilist"), ct);
        if (work != null || identity == null) return work?.Id;
        key ??= WorkKeySlug.WorkKeyFor(item.Title);
        if (await db.Works.AnyAsync(w => w.WorkKey == key, ct)) return null;
        var now = DateTime.UtcNow;
        var created = new Work { Id = Ids.New(), WorkKey = key, CanonicalTitle = item.Title, MediaType = item.MediaType,
            NamesJson = WorkNames.Legacy(item.Title, null, identity.Provider).ToJson(),
            IdsJson = WorkIds.From(identity.Provider, identity.ProviderId).ToJson() ?? "{}",
            Format = WorkFormats.FromMediaType(item.MediaType), Anime = AnimeIdentity.IsAnime(identity.Provider, null, identity.ProviderId) ? true : null,
            Provider = identity.Provider, ProviderId = identity.ProviderId, PosterUrl = item.PosterUrl, CreatedAt = now, UpdatedAt = now };
        db.Works.Add(created);
        return created.Id;
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
            db.WatchListItems.Remove(item);
            await db.SaveChangesAsync(ct);
        }
        return Ok(new { ok = true, filesKept = true });
    }

    [HttpPost("check")]
    public async Task<IActionResult> Check(CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var items = await db.WatchListItems.Where(x => x.UserId == LocalUser.Id && (x.Status == "watching" || x.Status == "planned")).ToListAsync(ct);
        var global = SettingsDefaults.ResolutionOrDefault(await db.ClientSettings.Where(x => x.UserId == LocalUser.Id).Select(x => x.PreferredResolution).FirstOrDefaultAsync(ct));
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
