using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Titles;

[ApiController, Route("api/title/{workKey}"), ServiceFilter(typeof(LibraryExceptionFilter))]
public sealed class TitleController(TitleService titles, GrabService grabs, IDbContextFactory<TorrentFlowDbContext> factory, IMetadataResolver metadata,
    EpisodeSearchIdentity identity) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(string workKey, [FromQuery] string? t, [FromQuery] int? y,
        [FromQuery] string? type, [FromQuery] int? s, [FromQuery] int? remembered, CancellationToken ct)
    {
        var provider = Request.Query["provider"].ToString();
        var external = Request.Query["externalId"].ToString();
        MediaMetadata? resolved = null;
        if (provider.Length > 0 && provider is not ("tmdb" or "anilist")) return BadRequest(new { error = "Unsupported title provider" });
        if (external.Length > 0)
            resolved = provider == "anilist" ? await metadata.GetAniListByIdAsync(external, ct) :
                provider == "tmdb" ? await metadata.GetTmdbByIdAsync(type == "movie" ? "movie" : "tv", external, ct) : null;
        return Ok(await titles.Detail(new(workKey, t, y, type, s, remembered, resolved), ct));
    }
    [HttpGet("progress")]
    public async Task<IActionResult> Progress(string workKey, CancellationToken ct) => Ok(await titles.Progress(workKey, ct));

    [HttpPost]
    public async Task<IActionResult> Post(string workKey, CancellationToken ct)
    {
        var f = await Fields.Read(Request, ct);
        var scope = f.String("scope");
        int? Positive(string name) => f.Raw(name).ValueKind == JsonValueKind.Number && f.Raw(name).TryGetInt32(out var n) && n > 0 ? n : null;
        var season = Positive("season");
        var episode = Positive("episode");
        var episodesRaw = f.Raw("episodes");
        var episodes = episodesRaw.ValueKind == JsonValueKind.Array ? episodesRaw.EnumerateArray()
            .Where(x => x.ValueKind == JsonValueKind.Number && x.TryGetInt32(out var n) && n > 0).Select(x => x.GetInt32()).Distinct().Order().Take(500).ToArray() : [];
        string? failure = !string.IsNullOrEmpty(f.String("infoHash")) ? "Acquisition intent cannot pin or promote a torrent hash." :
            scope switch
            {
                "episode" when season == null || episode == null || episodes.Length > 0 => "Episode scope requires exactly one season and episode.",
                "season" when season == null || f.Raw("episode").ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null) || episodes.Length == 0 => "Season scope requires a season and its episode list.",
                "title" when f.Raw("season").ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null) ||
                    f.Raw("episode").ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null) || episodes.Length > 0 => "Title scope cannot include season or episode coordinates.",
                not ("episode" or "season" or "title") => "An explicit acquisition scope is required.",
                _ => null
            };
        if (failure != null) return BadRequest(new { ok = false, message = failure });
        var resolution = Positive("preferredResolution");
        if (f.Raw("preferredResolution").ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null) &&
            (resolution == null || !new[] { 480, 720, 1080, 2160 }.Contains(resolution.Value)))
            return BadRequest(new { ok = false, message = "Preferred resolution must be 480p, 720p, 1080p, or 2160p." });
        var retention = f.Enum("retention", ["keep", "stream"]) ?? "keep";
        var cap = f.Bool("overrideStorageCap") == true;
        var claimedProvider = f.String("provider");
        var externalId = f.String("externalId");
        MediaMetadata? verified = null;
        if (claimedProvider != null || externalId != null)
        {
            if (claimedProvider is not ("anilist" or "tmdb") || string.IsNullOrWhiteSpace(externalId))
                return BadRequest(new { ok = false, message = "Unsupported title provider" });
            verified = claimedProvider == "anilist" ? await metadata.GetAniListByIdAsync(externalId, ct) :
                await metadata.GetTmdbByIdAsync(f.String("mediaType") == "movie" ? "movie" : "tv", externalId, ct);
            if (verified == null || !ReleaseSelection.MatchesWork(workKey, verified.Title, verified.Year))
                return BadRequest(new { ok = false, message = "Provider identity does not match this title." });
        }
        var detail = await titles.Detail(new(workKey, f.String("title"), (int?)f.Number("year", nullable: true), f.String("mediaType"), Provider: verified), ct);
        var title = (string)detail["title"]!;
        var type = detail["mediaType"] as string ?? ((bool)detail["isSeries"]! ? "tv" : "movie");
        if (scope == "title" && (bool)detail["isSeries"]!)
            return Conflict(new { ok = false, message = "Series title acquisition needs an episode — choose or find one first." });
        var library = (Dictionary<string, object?>)detail["library"]!;
        var watchId = library["watchListItemId"] as string;
        await using var db = await factory.CreateDbContextAsync(ct);
        var work = await db.Works.FirstOrDefaultAsync(x => x.WorkKey == workKey, ct);
        if (work == null)
        {
            work = new() { Id = Ids.New(), WorkKey = workKey, CanonicalTitle = title, MediaType = type, Year = detail["year"] as int?,
                PosterUrl = detail["posterUrl"] as string, AliasesJson = JsonSerializer.Serialize(detail["aliases"]),
                Provider = verified?.Source, ProviderId = verified?.ExternalId, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow };
            db.Works.Add(work);
            await db.SaveChangesAsync(ct);
        }
        if (watchId != null)
            await db.WatchListItems.Where(x => x.Id == watchId && x.UserId == LocalUser.Id).ExecuteUpdateAsync(x => x.SetProperty(w => w.WorkId, work.Id), ct);
        await db.CatalogEntries.Where(x => x.WorkKey == workKey).ExecuteUpdateAsync(x => x.SetProperty(c => c.WorkId, work.Id), ct);
        var input = new GrabInput(title, type, null, watchId, work.Id, resolution, retention, cap, detail["aliases"] as string[], Year: work.Year, WorkKey: workKey);
        if (scope != "title")
        {
            // Episode ladders search under recovered AniList names too; the page's own identity stays untouched.
            var (searchType, searchAliases) = await identity.ResolveAsync(title, detail["year"] as int?, detail["mediaType"] as string, input.Aliases, ct);
            input = input with { MediaType = searchType, Aliases = searchAliases };
        }
        var tracked = new List<AcquisitionTarget>();
        if (retention == "keep")
        {
            foreach (var ep in scope == "season" ? episodes.Cast<int?>() : new int?[] { episode })
            {
                var targetScope = scope == "season" ? "episode" : scope!;
                var key = $"{workKey}:{targetScope}:{season?.ToString() ?? "-"}:{ep?.ToString() ?? "-"}";
                var target = await db.AcquisitionTargets.FirstOrDefaultAsync(x => x.UserId == LocalUser.Id && x.TargetKey == key, ct);
                if (target == null)
                {
                    target = new() { Id = Ids.New(), UserId = LocalUser.Id, TargetKey = key, WorkKey = workKey, Scope = targetScope, Season = season, Episode = ep, CreatedAt = DateTime.UtcNow };
                    db.AcquisitionTargets.Add(target);
                }
                target.WorkId = work.Id; target.Status = "queued"; target.Progress = 0; target.InfoHash = null; target.FilePath = null;
                target.Error = null; target.PreferredResolution = resolution; target.UpdatedAt = DateTime.UtcNow;
                tracked.Add(target);
            }
            await db.SaveChangesAsync(ct);
        }
        try
        {
            if (scope == "season")
            {
                var result = await SeasonFanout.Run(episodes, (ep, before) => grabs.Grab(input with { Cursor = new EpisodeCursor(season!.Value, ep) }, ct, before), ct);
                foreach (var target in tracked)
                {
                    var transfer = result.Transfers.First(x => x.Episode == target.Episode);
                    target.Status = transfer.Status; target.InfoHash = transfer.InfoHash; target.Error = transfer.Error; target.UpdatedAt = DateTime.UtcNow;
                }
                await db.SaveChangesAsync(ct);
                var ok = result.CoveredEpisodes.Count > 0;
                var body = LibraryJson.Object(("ok", ok), ("message", ok ? $"{result.CoveredEpisodes.Count} of {episodes.Length} episodes started" :
                    "No episode downloads started — try again shortly."),
                    ("report", new { season, totalEpisodes = episodes.Length, coveredEpisodes = result.CoveredEpisodes.Count,
                        strategy = "singles", coverageConfirmed = true, episodes = result.Transfers.Select(x => x.Status == "failed" ?
                            LibraryJson.Object(("episode", x.Episode), ("status", "missing"), ("reason", x.Error)) :
                            LibraryJson.Object(("episode", x.Episode), ("status", "covered"))),
                        planReason = "Each episode used the same acquisition path as its individual Download button." }));
                if (result.Storage != null) body["storage"] = result.Storage;
                return StatusCode(ok ? 200 : 409, body);
            }
            var single = await grabs.Grab(input with { Cursor = season != null && episode != null ? new EpisodeCursor(season.Value, episode.Value) : null }, ct);
            foreach (var target in tracked)
            {
                target.Status = single.Ok ? "downloading" : "failed"; target.InfoHash = single.InfoHash; target.Error = single.Ok ? null : single.Message;
                target.UpdatedAt = DateTime.UtcNow;
            }
            await db.SaveChangesAsync(ct);
            return StatusCode(single.Ok ? 200 : 409, LibraryJson.Object(("ok", single.Ok), ("message", single.Message),
                ("title", single.Title), ("savePath", single.SavePath), ("infoHash", single.InfoHash), ("storage", single.Storage),
                ("queued", single.Queued), ("queuePosition", single.QueuePosition)));
        }
        catch (Exception error) when (!ct.IsCancellationRequested)
        {
            foreach (var target in tracked) { target.Status = "failed"; target.Error = error.Message; target.UpdatedAt = DateTime.UtcNow; }
            await db.SaveChangesAsync(ct);
            return StatusCode(500, new { ok = false, message = error.Message });
        }
    }
}
