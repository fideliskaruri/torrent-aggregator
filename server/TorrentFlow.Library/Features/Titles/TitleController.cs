using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Titles;

[ApiController, Route("api/title/{workKey}"), ServiceFilter(typeof(LibraryExceptionFilter))]
public sealed class TitleController(TitleService titles, ReleasePicker picker, WantedQueue wanted, IDbContextFactory<TorrentFlowDbContext> factory, IMetadataResolver metadata,
    IHostApplicationLifetime lifetime, ISeasonShapeLookup seasonShapes, WorkNamesRefresh names, IWorkLinker? linker = null,
    ILogger<TitleController>? logger = null) : ControllerBase
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
            if (resolved != null && !TitleIdentity.Matches(workKey, resolved))
                return BadRequest(new { error = "Provider identity does not match this title." });
        }
        await RefreshNamesAsync(workKey, resolved, ct);
        return Ok(await titles.Detail(new(workKey, t, y, type, s, remembered, resolved, TitleIdentity.From(provider, external), FindIdentity: true), ct));
    }

    /// <summary>
    /// Opening a title saves its provider record's names, or looks a stale work's names up again, then links the work
    /// to its other records if it never was (all within one budget; what runs out of time is finished by a later open).
    /// </summary>
    private async Task RefreshNamesAsync(string workKey, MediaMetadata? resolved, CancellationToken ct)
    {
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(TimeSpan.FromMilliseconds(2500));
        var key = workKey.Trim().ToLowerInvariant();
        try
        {
            await names.RefreshAsync(key, resolved, fetch: true, budget.Token);
            if (linker != null) await linker.LinkAsync(key, budget.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
        catch (Exception error) when (!ct.IsCancellationRequested)
        {
            // The page opens with what is stored; a later open or the backfill finishes the names and links.
            logger?.LogWarning("Refreshing the names and links of {WorkKey} failed: {Error}", key, error.InnerException?.Message ?? error.Message);
        }
    }

    /// <summary>The work's crosswalk: each record at another provider it is linked to, and where the link came from.</summary>
    [HttpGet("links")]
    public async Task<IActionResult> Links(string workKey, CancellationToken ct)
    {
        if (linker == null) return NotFound(new { error = "Links are not available." });
        var links = await linker.ListAsync(workKey.Trim().ToLowerInvariant(), ct);
        return links == null ? NotFound(new { error = "This title has no saved record yet." }) : Ok(new { links });
    }

    /// <summary>The owner unlinks a record: it is never linked again, and its ids and names leave the work.</summary>
    [HttpDelete("links/{provider}/{externalId}")]
    public async Task<IActionResult> Unlink(string workKey, string provider, string externalId, CancellationToken ct)
    {
        if (linker == null) return NotFound(new { error = "Links are not available." });
        var removed = await linker.UnlinkAsync(workKey.Trim().ToLowerInvariant(), provider.Trim().ToLowerInvariant(), externalId.Trim(), ct);
        if (!removed) return NotFound(new { ok = false, message = "That link was not found. Reload the page and try again." });
        return Ok(new { ok = true, links = await linker.ListAsync(workKey.Trim().ToLowerInvariant(), ct) });
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
                "season" when season == null || f.Raw("episode").ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null) => "Season scope requires a season.",
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
            if (verified == null || !TitleIdentity.Matches(workKey, verified))
                return BadRequest(new { ok = false, message = "Provider identity does not match this title." });
        }
        var detail = await titles.Detail(new(workKey, f.String("title", nullable: true), (int?)f.Number("year", nullable: true), f.String("mediaType", nullable: true), Provider: verified), ct);
        var title = (string)detail["title"]!;
        var type = detail["mediaType"] as string ?? ((bool)detail["isSeries"]! ? "tv" : "movie");
        if (scope == "title" && (bool)detail["isSeries"]!)
            return Conflict(new { ok = false, message = "Choose an episode or season to download first." });
        var library = (Dictionary<string, object?>)detail["library"]!;
        var watchId = library["watchListItemId"] as string;
        // The page's own catalog identity (an AniList film from a home rail, say) belongs on the work even when the click
        // carried no provider claim: the grab decides anime from it, and the Downloaded card draws its poster from it.
        var provider = verified?.Source ?? (detail.GetValueOrDefault("provider") as string is { } known && IMetadataResolver.SupportsProvider(known) ? known : null);
        var providerId = verified?.ExternalId ?? (provider == null ? null : detail.GetValueOrDefault("providerId") as string);
        if (providerId == null) provider = null;
        await using var db = await factory.CreateDbContextAsync(ct);
        var work = await db.Works.FirstOrDefaultAsync(x => x.WorkKey == workKey, ct);
        // The key's work is another title: a film where this is a series (or the reverse), or another record of the same
        // catalog. Search keeps such a namesake on the key with its kind on the end ("the-flash-2023-tv"); so does this.
        if (work != null && (TorrentFlow.Core.Scheduling.HuntCursor.IsSeries(work.MediaType) != TorrentFlow.Core.Scheduling.HuntCursor.IsSeries(type) ||
                (verified != null && work.Provider == verified.Source && work.ProviderId != null && work.ProviderId != verified.ExternalId)))
        {
            workKey = TorrentFlow.Core.Text.WorkKeySlug.KindKey(workKey, TorrentFlow.Core.Scheduling.HuntCursor.IsSeries(type));
            work = await db.Works.FirstOrDefaultAsync(x => x.WorkKey == workKey, ct);
        }
        // The verified record is already stored under another key (a link from before search dated namesakes, or another
        // catalog's record of it that the work's verified links name): the download belongs to that work, never to a
        // second copy of it.
        if (work == null && verified != null)
        {
            var source = verified.Source == "cinemeta" ? "imdb" : verified.Source;
            var stored = await db.Works.FirstOrDefaultAsync(x => x.Provider == verified.Source && x.ProviderId == verified.ExternalId && x.MediaType == type, ct)
                ?? await db.Works.Where(x => (x.MediaType == "movie") == (type == "movie") &&
                    x.Links.Any(l => l.Verified && !l.Rejected && l.Provider == source && l.ExternalId == verified.ExternalId)).FirstOrDefaultAsync(ct);
            if (stored != null)
            {
                work = stored;
                workKey = stored.WorkKey;
            }
        }
        // An identity is unique to one work; a page-derived identity already held by another work key is not copied here.
        if (verified == null && provider != null && await db.Works.AnyAsync(x => x.Provider == provider && x.ProviderId == providerId && x.MediaType == type && x.WorkKey != workKey, ct))
            provider = providerId = null;
        if (work == null)
        {
            var workNames = verified != null ? WorkNames.Of(verified) : WorkNames.Legacy(title, detail["aliases"] as string[], provider);
            work = new() { Id = Ids.New(), WorkKey = workKey, CanonicalTitle = title, MediaType = type, Year = detail["year"] as int?,
                PosterUrl = detail["posterUrl"] as string, NamesJson = workNames.ToJson(),
                IdsJson = (verified?.Ids ?? new()).Merge(WorkIds.From(provider, providerId)).ToJson() ?? "{}",
                Format = WorkFormats.Of(verified) ?? WorkFormats.FromMediaType(type), OriginalLanguage = WorkFormats.LanguageOf(verified),
                Anime = verified != null ? AnimeIdentity.IsAnime(verified) : null,
                Provider = provider, ProviderId = providerId, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow };
            db.Works.Add(work);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException error) when (IsUniqueViolation(error))
            {
                db.Entry(work).State = EntityState.Detached;
                work = await db.Works.FirstOrDefaultAsync(x => x.WorkKey == workKey, ct)
                    ?? await db.Works.SingleAsync(x => x.Provider == provider && x.ProviderId == providerId && x.MediaType == type, ct);
                workKey = work.WorkKey;
            }
        }
        else if (provider != null && work.ProviderId == null)
        {
            work.Provider = provider;
            work.ProviderId = providerId;
            work.PosterUrl ??= detail["posterUrl"] as string;
            work.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
        }
        // A verified provider record's names belong on the work, whether it was just created or already known.
        if (verified != null) await names.RefreshAsync(workKey, verified, fetch: false, ct);
        if (watchId != null)
            await db.WatchListItems.Where(x => x.Id == watchId && x.UserId == LocalUser.Id).ExecuteUpdateAsync(x => x.SetProperty(w => w.WorkId, work.Id), ct);
        await db.CatalogEntries.Where(x => x.WorkKey == workKey).ExecuteUpdateAsync(x => x.SetProperty(c => c.WorkId, work.Id), ct);
        if (scope == "season")
        {
            // The server decides which episodes a season has; a list the browser rendered is never trusted.
            var shape = await seasonShapes.GetSeasonAsync(new(workKey, title, work.Year, work.MediaType, verified?.Source ?? work.Provider,
                verified?.ExternalId ?? work.ProviderId, season!.Value), ct);
            episodes = shape?.AiredEpisodes.Take(500).ToArray() ?? [];
            if (episodes.Length == 0)
                return Conflict(new { ok = false, message = shape is null
                    ? "We couldn't load this season's episode list right now. Try again in a minute."
                    : $"No episodes of season {season} have aired yet." });
        }
        // Every download is fire and forget: record what is wanted and return. The wanted queue runs the shared grab in
        // the background (the film grab, or the single-episode grab for each episode) and keeps retrying whatever is not
        // found yet. A dead release costs the queue a metadata timeout, never the click.
        if (scope == "season")
        {
            await wanted.EnqueueAsync(new(workKey, work.Id, season!.Value, episodes, resolution, cap, TorrentLane.Owner), CancellationToken.None);
            return Accepted(LibraryJson.Object(("ok", true), ("queued", true), ("message", $"Season {season} queued."),
                ("report", new { season, totalEpisodes = episodes.Length, coveredEpisodes = 0, strategy = "unknown", coverageConfirmed = false,
                    episodes = episodes.Select(e => new { episode = e, status = "not_measured" }),
                    planReason = "We'll get each episode and keep looking for any we can't find yet." })));
        }
        await wanted.EnqueueAsync(new(workKey, work.Id, season, episode is { } one ? [one] : [], resolution, cap, TorrentLane.Owner, Single: true),
            CancellationToken.None);
        return Accepted(LibraryJson.Object(("ok", true), ("queued", true),
            ("message", episode is { } clicked ? $"Looking for episode {clicked}." : $"Looking for {title}.")));
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
        await wanted.ClaimPickedAsync(workKey, key?.Season, tracked, row.WorkId, tracked.Values.Distinct().Select(ep => Transfer(result, ep)).ToArray(), ct);
    }

    private static bool IsUniqueViolation(DbUpdateException error) =>
        error.InnerException is SqliteException { SqliteExtendedErrorCode: 2067 or 1555 };
}
