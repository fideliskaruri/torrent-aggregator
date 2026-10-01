using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Hosting;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Titles;

[ApiController, Route("api/title/{workKey}"), ServiceFilter(typeof(LibraryExceptionFilter))]
public sealed class TitleController(TitleService titles, GrabService grabs, ReleasePicker picker, WantedQueue wanted, IDbContextFactory<TorrentFlowDbContext> factory, IMetadataResolver metadata,
    IHostApplicationLifetime lifetime) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(string workKey, [FromQuery] string? t, [FromQuery] int? y,
        [FromQuery] string? type, [FromQuery] int? s, [FromQuery] int? remembered, CancellationToken ct)
    {
        var provider = Request.Query["provider"].ToString().Trim().ToLowerInvariant();
        var external = Request.Query["providerId"].ToString();
        if (external.Length == 0) external = Request.Query["externalId"].ToString();
        MediaMetadata? resolved = null;
        if (provider.Length > 0 && !IMetadataResolver.SupportsProvider(provider)) return BadRequest(new { error = "Unsupported title provider" });
        if (external.Length > 0)
        {
            if (!IMetadataResolver.SupportsProvider(provider)) return BadRequest(new { error = "A supported title provider is required." });
            resolved = await metadata.GetByIdAsync(provider, type == "movie" ? "movie" : "tv", external, ct);
            if (resolved != null && !MatchesProvider(workKey, resolved))
                return BadRequest(new { error = "Provider identity does not match this title." });
        }
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
        // Every download is kept; older pages may still send "stream", which is accepted and treated as keep.
        f.Enum("retention", ["keep", "stream"]);
        var cap = f.Bool("overrideStorageCap") == true;
        // Provider IDs are authoritative claims even when optional display hints are absent.
        string? Claim(string name) => f.Raw(name) is { ValueKind: JsonValueKind.String } v && v.GetString()!.Trim() is { Length: > 0 and <= 200 } s ? s : null;
        var claimedProvider = Claim("provider")?.ToLowerInvariant();
        var externalId = Claim("providerId");
        var sourceType = (Claim("sourceType") ?? Claim("mediaType"))?.ToLowerInvariant();
        MediaMetadata? verified = null;
        if (externalId != null)
        {
            if (claimedProvider == null || !IMetadataResolver.SupportsProvider(claimedProvider))
                return BadRequest(new { ok = false, message = "A supported title provider is required." });
            verified = await metadata.GetByIdAsync(claimedProvider, sourceType == "movie" ? "movie" : "tv", externalId, ct);
            if (verified == null || !MatchesProvider(workKey, verified))
                return BadRequest(new { ok = false, message = "Provider identity does not match this title." });
        }
        var detail = await titles.Detail(new(workKey, f.String("title", nullable: true), (int?)f.Number("year", nullable: true), f.String("mediaType", nullable: true), Provider: verified), ct);
        var title = (string)detail["title"]!;
        var type = detail["mediaType"] as string ?? ((bool)detail["isSeries"]! ? "tv" : "movie");
        if (scope == "title" && (bool)detail["isSeries"]!)
            return Conflict(new { ok = false, message = "Choose an episode or season to download first." });
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
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException error) when (IsUniqueViolation(error))
            {
                db.Entry(work).State = EntityState.Detached;
                work = await db.Works.SingleAsync(x => x.WorkKey == workKey, ct);
            }
        }
        else if (verified != null && work.ProviderId == null)
        {
            work.Provider = verified.Source;
            work.ProviderId = verified.ExternalId;
            work.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
        }
        if (watchId != null)
            await db.WatchListItems.Where(x => x.Id == watchId && x.UserId == LocalUser.Id).ExecuteUpdateAsync(x => x.SetProperty(w => w.WorkId, work.Id), ct);
        await db.CatalogEntries.Where(x => x.WorkKey == workKey).ExecuteUpdateAsync(x => x.SetProperty(c => c.WorkId, work.Id), ct);
        var input = new GrabInput(title, type, null, watchId, work.Id, resolution, cap, detail["aliases"] as string[], Year: work.Year, WorkKey: workKey,
            Provider: verified?.Source ?? work.Provider, ProviderId: verified?.ExternalId ?? work.ProviderId);
        // Download season is fire and forget: record what is wanted and return. The wanted queue runs the shared
        // season path (the single-episode grab for each episode) in the background and keeps retrying whatever is not found yet.
        if (scope == "season")
        {
            await wanted.EnqueueAsync(new(workKey, work.Id, season!.Value, episodes, resolution, cap, TorrentLane.Owner), CancellationToken.None);
            return Accepted(LibraryJson.Object(("ok", true), ("queued", true), ("message", $"Season {season} queued."),
                ("report", new { season, totalEpisodes = episodes.Length, coveredEpisodes = 0, strategy = "unknown", coverageConfirmed = false,
                    episodes = episodes.Select(e => new { episode = e, status = "not_measured" }),
                    planReason = "We'll get each episode and keep looking for any we can't find yet." })));
        }
        // Once targets are seeded the acquisition must finish and settle even if the client disconnects;
        // only host shutdown may interrupt it.
        var workToken = lifetime.ApplicationStopping;
        var tracked = await wanted.SeedAsync(workKey, work.Id, scope!, season, [episode], resolution, restart: true, ct);
        GrabResult? single = null;
        Exception? crash = null;
        try
        {
            single = await grabs.Grab(input with { Cursor = season != null && episode != null ? new EpisodeCursor(season.Value, episode.Value) : null }, workToken);
        }
        catch (Exception error)
        {
            crash = error;
        }
        finally
        {
            if (tracked.Count > 0)
                await wanted.SettleAsync(tracked, work.Id, [single is { } done ? Transfer(done, episode)
                    : new EpisodeTransfer(episode ?? 0, "failed", null, crash?.Message ?? "The acquisition was interrupted before it finished.")], CancellationToken.None);
        }
        if (crash != null) return Crash(crash);
        return StatusCode(single!.Ok ? 200 : 409, LibraryJson.Object(("ok", single.Ok), ("message", single.Message),
            ("title", single.Title), ("savePath", single.SavePath), ("infoHash", single.InfoHash), ("storage", single.Storage),
            ("queued", single.Queued), ("queuePosition", single.QueuePosition), ("noReleaseFound", single.NoReleaseFound)));
    }

    private ObjectResult Crash(Exception error)
    {
        var problem = GrabFailure.FromException(error);
        return StatusCode(500, new { ok = false, message = $"{problem.Message} {problem.Action}" });
    }

    private static EpisodeTransfer Transfer(GrabResult result, int? episode) => new(episode ?? 0,
        result.Ok ? result.Queued ? "queued" : "downloading" : "failed", result.Ok ? result.InfoHash : null, result.Ok ? null : result.Message);

    /// <summary>"Pick a release yourself": a manual search for this title, episode or season, prefilled with our query.</summary>
    [HttpGet("releases")]
    public async Task<IActionResult> Releases(string workKey, [FromQuery] int? season, [FromQuery] int? episode, [FromQuery] string? q,
        CancellationToken ct) => Ok(await picker.Search(workKey, season is > 0 ? season : null, episode is > 0 ? episode : null, q, ct));

    [HttpPost("releases")]
    public async Task<IActionResult> PickRelease(string workKey, CancellationToken ct)
    {
        var f = await Fields.Read(Request, ct);
        var token = f.String("token");
        if (string.IsNullOrWhiteSpace(token)) return BadRequest(new { ok = false, message = "Choose a release first." });
        var result = await picker.Pick(workKey, token, null, lifetime.ApplicationStopping);
        if (result.Ok && result.InfoHash != null) await SettlePicked(workKey, result, CancellationToken.None);
        return StatusCode(result.Ok ? 200 : 409, LibraryJson.Object(("ok", result.Ok), ("message", result.Message),
            ("title", result.Title), ("infoHash", result.InfoHash), ("queued", result.Queued), ("storage", result.Storage)));
    }

    /// <summary>A hand-picked release settles the failed or queued target it covers: its episode, or the film.</summary>
    private async Task SettlePicked(string workKey, GrabResult result, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var row = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.Hash == result.InfoHash)
            .Select(t => new { t.QueueKey, t.WorkId }).FirstOrDefaultAsync(ct);
        if (row?.WorkId == null) return;
        var key = TorrentFlow.Core.QueueKeys.Parse(row.QueueKey);
        var targets = db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkKey == workKey);
        targets = key is { } single ? targets.Where(t => t.Scope == "episode" && t.Season == single.Season && t.Episode == single.Episode)
            : targets.Where(t => t.Scope == "title");
        var tracked = await targets.ToDictionaryAsync(t => t.TargetKey, t => t.Episode, ct);
        if (tracked.Count == 0) return;
        await wanted.SettleAsync(tracked, row.WorkId, tracked.Values.Distinct().Select(ep => Transfer(result, ep)).ToArray(), ct);
        await wanted.ReportStartedAsync(workKey, key?.Season, [result.InfoHash!], ct);
    }

    private static bool MatchesProvider(string workKey, MediaMetadata resolved) =>
        (resolved.Aliases ?? []).Prepend(resolved.Title).Any(title =>
            ReleaseSelection.MatchesWork(workKey.Trim().ToLowerInvariant(), title, resolved.Year));

    private static bool IsUniqueViolation(DbUpdateException error) =>
        error.InnerException is SqliteException { SqliteExtendedErrorCode: 2067 or 1555 };
}
