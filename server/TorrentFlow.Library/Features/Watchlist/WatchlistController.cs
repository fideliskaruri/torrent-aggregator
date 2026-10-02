using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Engine;
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
    IMetadataResolver metadata, ITorrentSearchService search, AutomationWake wake, IAirDateLookup airDates, WorkNamesRefresh names,
    ILogger<WatchlistController>? logger = null) : ControllerBase
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
        var workIds = items.Where(x => x.WorkId != null).Select(x => x.WorkId!).ToList();
        // Ready = a download of the title promoted into the library (the one done-ness predicate) whose recorded files are
        // all still on disk (not removed, failed or moved away), so the card can say so.
        var ready = (await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkId != null && workIds.Contains(t.WorkId)
                && t.Status != EngineTorrentStatus.Error && t.Status != EngineTorrentStatus.Removed).Where(EngineTorrent.Downloaded)
            .Select(t => new { WorkId = t.WorkId!, t.VerifiedFilesJson }).ToListAsync(ct))
            .Where(t => VerifiedFiles.StillOnDisk(t.VerifiedFilesJson) != false).Select(t => t.WorkId).ToHashSet();
        return Ok(new { items = items.Select(x => { var row = WithWorkKey(LibraryJson.Row(x), x.Work?.WorkKey); row["ready"] = x.WorkId != null && ready.Contains(x.WorkId); return row; }) });
    }

    /// <summary>A row with its linked work's key: the page it opens ("doctor-who-2005"), never one rebuilt from its title.</summary>
    private static Dictionary<string, object?> WithWorkKey(Dictionary<string, object?> row, string? workKey)
    {
        row["workKey"] = workKey;
        return row;
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
        // The provider's own format (Movie, Series, Special, or AniList's MOVIE, TV...), a hint for when its record can't be read.
        var formatHint = patch ? null : f.String("format", max: 16, nullable: true);
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
        // Two adds of the same new title at once both create its work or row; the loser of the unique index reads the
        // winner's and links to it on the next attempt, so every add succeeds against one work and one row.
        for (var attempt = 0; ; attempt++)
        {
            try { return await SaveOnce(); }
            catch (DbUpdateException error) when (!patch && IsUniqueViolation(error) && attempt < 6)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(Random.Shared.Next(10, 60)), ct);
            }
        }

        async Task<IActionResult> SaveOnce()
        {
        await using var db = await factory.CreateDbContextAsync(ct);
        WorkChoice? choice = null;
        if (!patch)
        {
            choice = await WorkFor(db, workKey, provider, providerId ?? externalId, type!, externalId!, title!, poster, formatHint, ct);
            if (choice.Conflict != null) return Conflict(new { error = choice.Conflict });
        }
        // The row's type is the work's kind: an AniList film is a film the hunter grabs once, not a series.
        var rowType = choice?.RowType ?? type;
        // A row is its catalog's: TMDB movie 123 and AniList film 123 are two rows. An existing row is reused only when
        // it is this work's, has the same catalog and id, or is an unlinked row saved before rows named their catalog that
        // is this same title (LegacyRowAsync); it never keeps a different work.
        var rowProvider = choice?.Provider ?? "";
        var chosenId = choice?.Work?.Id;
        var item = patch
            ? await db.WatchListItems.FirstOrDefaultAsync(x => x.Id == id && x.UserId == LocalUser.Id, ct)
            : (chosenId != null ? await db.WatchListItems.FirstOrDefaultAsync(x => x.WorkId == chosenId && x.UserId == LocalUser.Id, ct) : null)
              ?? await db.WatchListItems.FirstOrDefaultAsync(x => x.UserId == LocalUser.Id && x.MediaType == rowType && x.ExternalId == externalId &&
                  x.Provider == rowProvider, ct)
              ?? (rowProvider != "" ? await LegacyRowAsync(db, rowType!, externalId!, title!, ct) : null);
        if (!patch && rowProvider != "" && item is { Provider: "" } && item.MediaType == rowType && item.ExternalId == externalId) item.Provider = rowProvider;
        if (patch && item == null) return NotFound(new { error = "Not found" });
        var existed = item != null;
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
            item = new WatchListItem { Id = Ids.New(), UserId = LocalUser.Id, Title = title!, MediaType = rowType!,
                ExternalId = externalId!, Provider = rowProvider, Status = status ?? "watching", Monitored = monitored ?? true,
                MonitorMode = HuntCursor.OngoingMode, CreatedAt = now, LastChecked = now };
            // A series added without a start season is "New episodes only": the absence is the answer.
            mode ??= EpisodeCursor.IsSeries(rowType) && fromSeason == null ? HuntCursor.NewEpisodesMode : null;
            db.WatchListItems.Add(item);
        }
        if (!patch)
        {
            item.Title = title!;
            if (!string.IsNullOrEmpty(poster)) item.PosterUrl = poster;
            if (!string.IsNullOrEmpty(synopsis)) item.Synopsis = synopsis;
            if (rating != null) item.Rating = rating;
            // The row follows the work its catalog id belongs to; a different work is never kept.
            if (chosenId != null) item.WorkId = chosenId;
            if (choice?.Work is { } w && w.PosterUrl == null && !string.IsNullOrEmpty(item.PosterUrl)) w.PosterUrl = item.PosterUrl;
        }
        if (patch || !existed)
        {
            if (status != null) item.Status = status;
            if (monitored != null) item.Monitored = monitored;
        }
        else
        {
            // An add never lowers a row that is already there: a rail's "planned, not monitored" (or one that reached the
            // row through a crosswalk) leaves a show the owner watches as it is. It may only start watching or monitoring it.
            if (status == "watching") item.Status = status;
            if (monitored == true) item.Monitored = true;
        }
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
        // The provider record read for a new or newly identified work: its names, ids and links go through the one writer.
        if (choice is { Work: { } saved, Record: { } record }) await names.RefreshAsync(saved.WorkKey, record, fetch: false, ct);
        if (EpisodeCursor.AwaitingFirstNewEpisode(item))
            await NewEpisodes.PinAsync(db, airDates, item, TimeSpan.FromSeconds(5), ct);
        wake.Wake();
        // The row's linked work names the page it opens.
        var linked = item.WorkId == null ? null : choice?.Work is { } chosen && chosen.Id == item.WorkId ? chosen.WorkKey
            : await db.Works.Where(x => x.Id == item.WorkId).Select(x => x.WorkKey).FirstOrDefaultAsync(ct);
        return Ok(new { item = WithWorkKey(LibraryJson.Row(item), linked) });
        }
    }

    /// <summary>The work a new row links to, the row's type, the provider record read for it, or why the add is refused.</summary>
    /// <param name="Provider">The catalog the row's external id belongs to ("" when none), part of the row's identity.</param>
    private sealed record WorkChoice(Work? Work, string RowType, MediaMetadata? Record = null, string? Conflict = null, string Provider = "");

    /// <summary>
    /// The work a new row belongs to, so the hunter and on-demand grabs carry its catalog identity: the title page's
    /// work (filled with the supplied identity when it has none), else the work holding this catalog id, else a new work
    /// read from that provider so its format (film or series), anime verdict and names are stored from the start. An
    /// AniList id is what an anime row's external id has always been. A keyed work that already has a different identity
    /// is never attached silently: the work holding the supplied identity is used, else the add is refused. No catalog
    /// id and no work leaves the row unlinked, as before. The work is tracked; the caller's save writes it.
    /// </summary>
    private async Task<WorkChoice> WorkFor(TorrentFlowDbContext db, string? workKey, string? provider, string? providerId, string type,
        string externalId, string title, string? poster, string? formatHint, CancellationToken ct)
    {
        var identity = TitleIdentity.From(provider, providerId)
            ?? (type == "anime" && int.TryParse(externalId, out var anilist) && anilist > 0 ? new("anilist", externalId) : null);
        var key = workKey?.Trim().ToLowerInvariant() is { Length: > 0 } k ? k
            : externalId.StartsWith("work:", StringComparison.Ordinal) ? externalId[5..] : null;
        var keyed = key == null ? null : await db.Works.FirstOrDefaultAsync(w => w.WorkKey == key, ct);
        if (identity == null) return new(keyed, keyed != null ? RowType(type, keyed.Format, keyed.Provider) : type);
        // The row's external id is this catalog's id only when it is the supplied one (a "work:" key is no catalog's).
        var rowProvider = identity.ProviderId == externalId ? identity.Provider : "";
        var holder = await db.Works.FirstOrDefaultAsync(w => w.Provider == identity.Provider && w.ProviderId == identity.ProviderId &&
            (w.MediaType == type || identity.Provider == "anilist" || type == "anime"), ct);
        if (keyed != null && (keyed.Id == holder?.Id || Same(keyed, identity))) return new(keyed, RowType(type, keyed.Format, keyed.Provider), Provider: rowProvider);
        if (holder != null)
        {
            if (keyed != null) logger?.LogInformation("Watchlist add for {WorkKey} carries {Provider}:{ProviderId}, which {Holder} holds; linked to {Holder}",
                keyed.WorkKey, identity.Provider, identity.ProviderId, holder.WorkKey, holder.WorkKey);
            return new(holder, RowType(type, holder.Format, holder.Provider), Provider: rowProvider);
        }
        if (keyed?.Provider != null)
            return new(null, type, Conflict: "This title is already in your library under a different catalog entry.");

        var record = await RecordAsync(identity, type, ct);
        var format = WorkFormats.Of(record) ?? Format(formatHint) ?? WorkFormats.FromMediaType(type);
        var anime = record != null ? (bool?)AnimeIdentity.IsAnime(record) : AnimeIdentity.IsAnime(identity.Provider, null, identity.ProviderId) ? true : null;
        var mediaType = identity.Provider == "anilist" ? format == WorkFormat.Movie ? "movie" : "anime" : type;
        if (keyed != null)
        {
            // One library per show (WorkKinds.AnimeVerdict), read before the identity is attached so the work reads as it did.
            if (keyed.Anime == null && anime == false && keyed.IsAnime() == true && await AnimeFiling.PathAsync(db, keyed.Id, keyed.WorkKey, ct) is { } filed)
            {
                anime = WorkKinds.AnimeVerdict(false, true, filedInAnimeLibrary: true);
                AnimeFiling.LogKept(logger, keyed.WorkKey, identity.Provider, filed);
            }
            // A work with no catalog identity takes the one supplied: no other work holds it.
            keyed.Provider = identity.Provider;
            keyed.ProviderId = identity.ProviderId;
            keyed.Format ??= format;
            keyed.Anime ??= anime;
            keyed.OriginalLanguage ??= WorkFormats.LanguageOf(record);
            keyed.UpdatedAt = DateTime.UtcNow;
            return new(keyed, RowType(type, keyed.Format, keyed.Provider), record, Provider: rowProvider);
        }
        key ??= WorkKeySlug.WorkKeyFor(record?.Title ?? title, record?.Year);
        // A key another work already holds names this work only when that work is this identity (crosswalked to it);
        // otherwise the new work takes a key of its own catalog id, so the add never fails on the key.
        if (await db.Works.FirstOrDefaultAsync(w => w.WorkKey == key, ct) is { } taken)
        {
            if (Same(taken, identity)) return new(taken, RowType(type, taken.Format, taken.Provider), Provider: rowProvider);
            key = $"{key}-{identity.Provider}-{identity.ProviderId}".ToLowerInvariant();
        }
        var now = DateTime.UtcNow;
        var created = new Work { Id = Ids.New(), WorkKey = key, CanonicalTitle = record?.Title ?? title, MediaType = mediaType, Year = record?.Year,
            NamesJson = (record != null ? WorkNames.Of(record) : WorkNames.Legacy(title, null, identity.Provider)).ToJson(),
            IdsJson = (record?.Ids ?? new()).Merge(WorkIds.From(identity.Provider, identity.ProviderId)).ToJson() ?? "{}",
            Format = format, Anime = anime, OriginalLanguage = WorkFormats.LanguageOf(record),
            Provider = identity.Provider, ProviderId = identity.ProviderId, PosterUrl = poster ?? record?.PosterUrl, CreatedAt = now, UpdatedAt = now };
        db.Works.Add(created);
        return new(created, RowType(type, format, identity.Provider), record, Provider: rowProvider);
    }

    /// <summary>Whether the keyed work already is, or is crosswalked to, the supplied identity.</summary>
    private static bool Same(Work work, TitleIdentity identity)
    {
        if (work.Provider == identity.Provider && work.ProviderId == identity.ProviderId) return true;
        var mine = (WorkIds.FromJson(work.IdsJson) ?? new()).Merge(WorkIds.From(work.Provider, work.ProviderId));
        var theirs = WorkIds.From(identity.Provider, identity.ProviderId);
        return theirs.Tmdb != null && theirs.Tmdb == mine.Tmdb || theirs.AniList != null && theirs.AniList == mine.AniList
            || theirs.Mal != null && theirs.Mal == mine.Mal || theirs.Imdb != null && string.Equals(theirs.Imdb, mine.Imdb, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>An AniList row is "anime" (a series the hunter walks) unless its work is a film; other rows keep their type.</summary>
    private static string RowType(string type, WorkFormat? format, string? provider) =>
        format == WorkFormat.Movie && (type == "anime" || provider == "anilist") ? "movie"
        : type == "movie" && provider == "anilist" && format is WorkFormat.Series ? "anime"
        : type;

    private static WorkFormat? Format(string? hint) =>
        Enum.TryParse<WorkFormat>(hint, ignoreCase: true, out var format) && Enum.IsDefined(format) ? format : WorkFormats.FromAniList(hint);

    /// <summary>The provider's own record, within 3 s; null when it can't be read (the work's first grab or open asks again).</summary>
    private async Task<MediaMetadata?> RecordAsync(TitleIdentity identity, string type, CancellationToken ct)
    {
        if (!IMetadataResolver.SupportsProvider(identity.Provider)) return null;
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(TimeSpan.FromSeconds(3));
        try
        {
            var record = await metadata.GetByIdAsync(identity.Provider, type == "movie" ? "movie" : "tv", identity.ProviderId, budget.Token);
            return record != null && record.Source == identity.Provider && record.ExternalId == identity.ProviderId ? record : null;
        }
        catch (Exception error) when (!ct.IsCancellationRequested)
        {
            logger?.LogInformation("Could not read {Provider}:{ProviderId} for a watchlist add: {Error}", identity.Provider, identity.ProviderId, error.Message);
            return null;
        }
    }

    private static bool IsUniqueViolation(DbUpdateException error) =>
        error.InnerException is Microsoft.Data.Sqlite.SqliteException { SqliteExtendedErrorCode: 2067 or 1555 };

    /// <summary>
    /// An unlinked row saved before rows named their catalog, reused only when it is this same title: the same type and id,
    /// and the same title once normalized. TMDB movie 437 (Cube 2) is never taken over by AniList film 437 (Perfect Blue).
    /// </summary>
    private static async Task<WatchListItem?> LegacyRowAsync(TorrentFlowDbContext db, string type, string externalId, string title, CancellationToken ct)
    {
        var key = WorkKeySlug.WorkKeyFor(title);
        if (key.Length == 0) return null;
        var rows = await db.WatchListItems.Where(x => x.UserId == LocalUser.Id && x.MediaType == type && x.ExternalId == externalId &&
            x.Provider == "" && x.WorkId == null).ToListAsync(ct);
        return rows.FirstOrDefault(x => WorkKeySlug.SameKey(WorkKeySlug.WorkKeyFor(x.Title), key));
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
