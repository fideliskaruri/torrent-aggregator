using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.Access;
using TorrentFlow.Api.Catalog;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Library;
using TorrentFlow.Store;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class DownloadEndpoints
{
    private static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web);
    private static IResult Reply(object body) => Results.Json(body, Wire);

    internal static void MapDownloads(this WebApplication app)
    {
        var group = app.MapGroup("/api").AddEndpointFilter(async (context, next) =>
        {
            if (AccessIdentity.Actor(context.HttpContext).Role != UserRole.Owner)
                return Results.StatusCode(403);
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            try { return await next(context); }
            catch (ArgumentException ex) { return Results.BadRequest(new { message = ex.Message }); }
            catch (InvalidOperationException ex) { return Results.Conflict(new { message = ex.Message }); }
        });
        ReleaseReplacementEndpoints.Map(group);
        TorrentSendEndpoints.Map(group);
        group.MapGet("/client/torrents", async (DownloadsApi api, CancellationToken ct) =>
            Reply(await api.ListAsync(ct)));
        group.MapPost("/client/torrents", async (DownloadAction input, DownloadsApi api, CancellationToken ct) =>
            Reply(await api.ActionAsync(input, ct)));
        group.MapPost("/client/torrents/tidy", async (DownloadsApi api, CancellationToken ct) =>
            Reply(await api.TidyAsync(ct)));
        group.MapPost("/downloads/{transferId}/keep", async (string transferId, DownloadsApi api, CancellationToken ct) =>
            await api.KeepAsync(transferId, ct));
        group.MapPost("/title/{workKey}", async (string workKey, TitleDownload input, HttpContext http,
            TargetPipeline targets, IMetadata metadata, CancellationToken ct) =>
        {
            if (input.Season is < 0 or > 999 || input.Episode is < 1 or > 99999 ||
                input.PreferredResolution is < 1 or > 4320)
                return Results.BadRequest(new { message = "Choose a valid season, episode and quality." });
            var work = (await metadata.GetWorkAsync(workKey, false, ct)).Work;
            if (work is null && input.Provider is { } provider && input.ProviderId is { } providerId)
            {
                if (provider is not ("tmdb" or "anilist" or "cinemeta" or "tvmaze" or "itunes"))
                    return Results.BadRequest(new { ok = false, message = "A supported title provider is required." });
                work = (await metadata.ResolveAsync(new(new(provider, providerId,
                    input.MediaType == "movie" ? "movie" : "tv"), input.Title, input.Year,
                    input.MediaType == "movie" ? WorkKind.Film : WorkKind.Series), ct)).Work;
            }
            var resolvedKey = work?.Work.WorkKey ?? workKey;
            var reply = await targets.AcquireAsync(new(resolvedKey, input.Season, input.Episode,
                input.PreferredResolution), AccessIdentity.Actor(http).UserId, ct);
            return Results.Ok(AdmissionProjection.Title(reply, resolvedKey));
        });
        group.MapGet("/wanted", async (DownloadsApi api, CancellationToken ct) =>
            Reply(await api.WantedAsync(ct)));
        group.MapDelete("/wanted", async (string workKey, int? season, int? episode,
            DownloadsApi api, CancellationToken ct) =>
            Reply(await api.WantedActionAsync(workKey, season, episode, TargetAction.Remove, ct)));
        group.MapPost("/wanted/try", async (string workKey, int? season, int? episode,
            DownloadsApi api, CancellationToken ct) =>
            Reply(await api.WantedActionAsync(workKey, season, episode, TargetAction.TryNow, ct)));
        group.MapGet("/settings/client", async (DownloadsApi api, CancellationToken ct) =>
            Reply(await api.SettingsAsync(null, ct)));
        group.MapPut("/settings/client", async (JsonElement input, DownloadsApi api, CancellationToken ct) =>
            Reply(await api.SettingsAsync(input, ct)));
        group.MapGet("/settings/download-recovery", async (DownloadsApi api, CancellationToken ct) =>
            Reply(await api.RecoveryAsync(false, ct)));
        group.MapPost("/settings/download-recovery", async (DownloadsApi api, CancellationToken ct) =>
            Reply(await api.RecoveryAsync(true, ct)));
        group.MapGet("/settings/download-recovery/sources", async (IConfiguration configuration,
            MediaImport importer, ImportReviews reviews, ILibraryRepository inventory, CancellationToken ct) =>
        {
            var scan = new ExternalDownloadScanner().Scan(configuration["TorrentFlow:ExternalDownloadScan:ScanRoot"], ct);
            var adoption = new ExternalMediaAdoption(importer, reviews, inventory);
            var candidates = new List<object>();
            foreach (var row in scan.Candidates)
                candidates.Add(new { row.Id, row.Source, row.Hash, row.Name, row.SizeBytes, row.SavePath,
                    row.DataExists, row.Complete, alreadyImported = await adoption.AlreadyOwnedAsync(row.Files, ct) });
            return Reply(new { candidates, scan.Warnings });
        });
        group.MapPost("/settings/download-recovery/sources", async (RecoverySourcesInput input,
            IConfiguration configuration, MediaImport importer, ImportReviews reviews,
            ILibraryRepository inventory, TargetPipeline targets, HttpContext http, CancellationToken ct) =>
        {
            if (!input.Acknowledged)
                return Results.BadRequest(new { error = "Confirm that the other client will not write to these files." });
            if (input.Ids is null || input.Ids.Length > 500 || input.Ids.Any(string.IsNullOrWhiteSpace))
                return Results.BadRequest(new { error = "Select between 1 and 500 torrents to import." });
            if (input.Ids.Length == 0)
                return Results.Ok(new { imported = 0, paused = 0, skipped = 0, failed = 0, errors = Array.Empty<string>() });
            var scan = new ExternalDownloadScanner().Scan(configuration["TorrentFlow:ExternalDownloadScan:ScanRoot"], ct);
            var adoption = new ExternalMediaAdoption(importer, reviews, inventory);
            var unfinished = scan.Candidates.Where(c => !c.Complete && input.Ids.Contains(c.Id)).ToArray();
            var result = await adoption.ImportAsync(input.Ids.Where(id => unfinished.All(c => c.Id != id)),
                [.. scan.Candidates.Select(c => new ExternalAdoptionSource(c.Id, c.Name, c.SavePath, c.Complete, c.Files))], ct);
            foreach (var candidate in unfinished)
            {
                try
                {
                    if ((await targets.ReadAsync(ct)).Downloads.Any(d => d.Hash == candidate.Hash))
                    {
                        result = result with { Skipped = result.Skipped + 1 };
                        continue;
                    }
                    var selected = input.Selections?.Where(s => s.SourceId == candidate.Id).ToArray() ?? [];
                    var review = await adoption.ReviewTransferAsync(new(candidate.Id, candidate.Name,
                        candidate.SavePath, candidate.Complete, candidate.Files),
                        [.. selected.Select(s => new ExternalIdentityPick(s.FileIndex, s.WorkId, s.EpisodeId))], ct);
                    var admitted = await targets.AdmitExternalAsync(new(candidate.Hash, candidate.Name,
                        candidate.TorrentBytes, candidate.Files, [.. selected.Select(s =>
                            new ExternalTransferItem(s.FileIndex, s.WorkId, s.EpisodeId))], input.Paused, review.Id,
                        [.. review.Items.Where(i => selected.Any(s => i.Path == candidate.Files[s.FileIndex])).Select(i => i.Id)]),
                        AccessIdentity.Actor(http).UserId, ct);
                    if (!admitted.Accepted) throw new IOException(admitted.Failure?.Message);
                    result = result with { Imported = result.Imported + 1, Paused = result.Paused + (input.Paused ? 1 : 0) };
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
                {
                    result = result with { Failed = result.Failed + 1,
                        Errors = result.Errors.Add($"{candidate.Name}: {ex.Message}") };
                }
            }
            return Reply(result);
        });
    }

    internal sealed record DownloadAction(string Action, string? Hash = null, string[]? Hashes = null,
        string? OwnerClientType = null, bool DeleteFiles = false);
    internal sealed record RecoverySourcesInput(string[]? Ids, bool Acknowledged,
        ExternalSelection[]? Selections = null, bool Paused = false);
    internal sealed record ExternalSelection(string SourceId, int FileIndex, string WorkId, string? EpisodeId = null);
    internal sealed record TitleDownload(int? Season = null, int? Episode = null, int? PreferredResolution = null,
        string? Provider = null, string? ProviderId = null, string? MediaType = null, string? Title = null, int? Year = null);
}

internal sealed class DownloadsApi(TargetPipeline targets, RawDownloads rawDownloads, IEngine engine, IServiceScopeFactory scopes,
    IConfiguration configuration)
{
    private readonly SemaphoreSlim settingsGate = new(1, 1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
        { Converters = { new JsonStringEnumConverter() } };

    private async Task<ImmutableArray<T>> Rows<T>(CancellationToken ct) where T : StoreRow
    {
        await using var scope = scopes.CreateAsyncScope();
        return await AccessState.AllAsync<T>(scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets"), ct);
    }

    internal async Task<object> ListAsync(CancellationToken ct)
    {
        var snapshot = await targets.ReadAsync(ct);
        var links = await Rows<DownloadTargetRow>(ct);
        var works = await Rows<WorkRow>(ct);
        var names = await Rows<WorkNameRow>(ct);
        var episodes = await Rows<EpisodeRow>(ct);
        var seasons = await Rows<SeasonRow>(ct);
        var releases = await Rows<ReleaseRow>(ct);
        var raw = await Rows<RawIntentRow>(ct);
        var files = await Rows<DownloadFileRow>(ct);
        var media = await Rows<MediaFileRow>(ct);
        var cap = SettingsCatalog.Read<EngineSettings>((await Rows<SettingRow>(ct)).Single(s => s.Id == "engine"))
            .MaxActiveDownloads;
        var full = snapshot.Live.Count(l => l.Active && !l.Complete) >= cap;
        var rows = new List<object>();
        var queuePosition = 0;
        foreach (var download in snapshot.Queue.Select(q => snapshot.Downloads.Single(d => d.Id == q.DownloadId)))
        {
            var associations = links.Where(l => l.DownloadId == download.Id).ToArray();
            var items = snapshot.Targets.Where(t => associations.Any(l => l.TargetId == t.Id)).ToArray();
            if (items.Length > 0 && items.All(t => t.State == TargetState.Removed)) continue;
            var target = items.FirstOrDefault(t => t.State != TargetState.Removed);
            var live = snapshot.Live.FirstOrDefault(l => l.DownloadId == download.Id);
            var rawIntent = raw.FirstOrDefault(r => r.Id == download.RawIntentId);
            var libraryFile = media.FirstOrDefault(m => m.DownloadId == download.Id && m.Role == FileRole.Video);
            var work = works.FirstOrDefault(w => w.Id == (target?.WorkId ?? libraryFile?.WorkId));
            var episode = episodes.FirstOrDefault(e => e.Id == (target?.EpisodeId ?? libraryFile?.EpisodeId));
            var season = seasons.FirstOrDefault(s => s.Id == episode?.SeasonId);
            var release = releases.FirstOrDefault(r => r.Id == download.Hash);
            var done = download.FinishedAt is not null || target?.State == TargetState.Done ||
                rawIntent?.State == RawDownloadState.Done;
            var paused = target?.State == TargetState.Paused || rawIntent?.State == RawDownloadState.Paused ||
                live?.Intent == DownloadIntent.Paused;
            var failed = live?.Failure is not null || live is null && !done && !paused;
            var state = done ? "complete" : paused ? "paused" : failed ? "error" :
                live?.Complete == true || target?.State == TargetState.Filing ? "finishing" :
                live?.Active == true ? !live.MetadataAvailable ? "metaDL" :
                    live.StalledProgress ? "stalledDL" : "downloading" :
                live?.Intent == DownloadIntent.Queued ? "queued" :
                live?.MetadataAvailable == false ? "metaDL" :
                live?.StalledProgress == true || live?.StalledMetadata == true ? "stalledDL" : "queued";
            var selected = files.Where(f => f.DownloadId == download.Id && f.Role != FileRole.Unwanted).ToArray();
            var size = selected.Length > 0 ? selected.Sum(f => f.ExpectedBytes) :
                live?.SelectedBytes ?? release?.TotalBytes ?? 0;
            size += media.Where(m => m.DownloadId == download.Id &&
                selected.All(f => f.FileIndex != m.FileIndex)).Sum(m => m.Bytes);
            var completed = selected.Length > 0 ? selected.Sum(f => f.Filed ? f.ExpectedBytes :
                live?.Files.FirstOrDefault(l => l.Index == f.FileIndex)?.CompletedBytes ?? 0) :
                live?.CompletedSelectedBytes ?? 0;
            var title = work is null ? null : CatalogProjection.Title(new(work,
                [.. names.Where(n => n.WorkId == work.Id)], [], [], []));
            rows.Add(new
            {
                hash = download.Hash, name = release?.Name ?? title ?? download.Hash,
                progress = done ? 1d : size > 0 ? Math.Clamp((double)completed / size, 0, 1) : 0,
                sizeBytes = size, dlspeed = live?.BytesPerSecond ?? 0, upspeed = 0,
                state, eta = live?.Eta?.TotalSeconds, peers = live?.Peers ?? 0,
                health = new { connectedPeers = live?.Peers ?? 0, downloadBytesPerSecond = live?.BytesPerSecond ?? 0,
                    stalledForSeconds = 0, state },
                error = live?.Failure?.Message ?? (failed ? target?.ReasonText : null),
                category = work?.Kind == WorkKind.Series ? "TV" : "Movies",
                savePath = rawIntent?.ExplicitDirectory ?? Path.GetDirectoryName(selected.FirstOrDefault()?.FinalPath),
                retentionState = "kept", lane = target?.Origin == IntentOrigin.Request ? "request" : "owner",
                forced = target?.Priority == TargetPriority.Now || rawIntent?.NowAt is not null,
                queuePosition = state == "queued" ? (int?)++queuePosition : null,
                waitReason = state == "queued" && full ? "queue-full" : null,
                waitingReason = target?.ReasonText ?? (state == "queued" ? full ?
                    "Waiting for a download slot." : "Waiting to start." :
                    live?.StalledProgress == true ? "Waiting for peers to send data." :
                    live?.StalledMetadata == true ? "Waiting for peers to share the torrent's file list." : null),
                verified = done, provenance = rawIntent is null ? "automatic" : "hand",
                magnet = release?.Magnet, imported = false, addedAt = download.AddedAt,
                filesMissing = done && selected.Any(f => media.Any(m => m.Id == f.MediaFileId && m.MissingSince is not null)),
                ownerClientType = "builtin", ownerClientLabel = "Built-in", transferId = "builtin:" + download.Hash,
                workId = work?.Id, workKey = work?.WorkKey, workTitle = title, workYear = work?.Year,
                workMediaType = work is null ? null : work.Kind == WorkKind.Series ? "tv" : "movie",
                posterUrl = work?.PosterUrl, targetScope = episode is null ? "movie" :
                    items.Length > 1 ? "season" : "episode",
                season = season?.Number, episode = items.Length > 1 ? null : episode?.Number,
                packEpisodes = items.Length > 1 ? (int?)items.Count(t => t.State != TargetState.Removed) : null,
            });
        }
        var body = JsonSerializer.SerializeToNode(new { torrents = rows, clientType = "builtin", host = "",
            offline = false, hasExternal = false, externalClientType = (string?)null,
            partial = false, clientIssues = Array.Empty<object>() }, Json)!;
        foreach (var row in body["torrents"]!.AsArray())
            foreach (var key in new[] { "eta", "queuePosition" })
                if (row![key] is null) row.AsObject().Remove(key);
        return body;
    }

    internal async Task<object> ActionAsync(DownloadEndpoints.DownloadAction input, CancellationToken ct)
    {
        if (input.OwnerClientType is not (null or "builtin"))
            throw new ArgumentException("Only the built-in client is available.");
        var action = input.Action switch
        {
            "pause" => TargetAction.Pause, "resume" => TargetAction.Resume,
            "delete" => TargetAction.Remove, "force" => TargetAction.DownloadNow,
            _ => throw new ArgumentException("Choose pause, resume, delete or force."),
        };
        if (input.DeleteFiles && action != TargetAction.Remove)
            throw new ArgumentException("Delete files is only available when removing a download.");
        var hashes = input.Hashes ?? (input.Hash is { } singleHash ? [singleHash] : []);
        if (hashes.Length == 0 || hashes.Length > 500) throw new ArgumentException("Choose downloads to change.");
        var snapshot = await targets.ReadAsync(ct);
        var links = await Rows<DownloadTargetRow>(ct);
        foreach (var hash in hashes.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var download = snapshot.Downloads.FirstOrDefault(d => d.Hash.Equals(hash, StringComparison.OrdinalIgnoreCase));
            if (download is null) continue;
            var ids = links.Where(l => l.DownloadId == download.Id).Select(l => l.TargetId).Distinct().ToArray();
            if (ids.Length == 0 && download.RawIntentId is not null)
            {
                if (action == TargetAction.Remove) await rawDownloads.RemoveAsync(download.Hash, input.DeleteFiles, ct);
                else if (action == TargetAction.DownloadNow)
                    await rawDownloads.OrderAsync(download.Hash, new(Now: true, Paused: false), ct);
                else await targets.RawActionAsync(download.RawIntentId, action, ct);
                continue;
            }
            if (ids.Length == 0) throw new ArgumentException("This download no longer has an action.");
            if (input.DeleteFiles) await targets.DeleteDownloadFilesAsync(hash, ct);
            foreach (var id in ids) await targets.ActionAsync(id, action, ct);
        }
        return new { ok = true };
    }

    internal async Task<object> TidyAsync(CancellationToken ct)
    {
        var downloads = (await targets.ReadAsync(ct)).Downloads;
        // Library reserves the final layout before admission; there are no legacy nested moves.
        return new { @checked = downloads.Length, tidied = 0, filesMoved = 0, stillNested = 0,
            skipped = downloads.Count(d => d.FinishedAt is null) };
    }

    internal async Task<IResult> KeepAsync(string transferId, CancellationToken ct)
    {
        var match = System.Text.RegularExpressions.Regex.Match(transferId.Trim(),
            "^(?:builtin:)?([0-9a-f]{40})$", System.Text.RegularExpressions.RegexOptions.IgnoreCase |
                System.Text.RegularExpressions.RegexOptions.CultureInvariant);
        if (!match.Success) return Results.BadRequest(new { ok = false, reason = "invalid-id",
            error = "That is not a download id.", message = "Reload the page and try again." });
        var hash = match.Groups[1].Value.ToLowerInvariant();
        var download = (await targets.ReadAsync(ct)).Downloads.SingleOrDefault(d => d.Hash == hash);
        if (download is null) return Results.NotFound(new { ok = false, reason = "not-found",
            error = "Torrent not found in engine.", message = "Torrent not found in engine." });
        if (download.FinishedAt is null) return Results.Conflict(new { ok = false, reason = "not-held",
            error = "This download is still finishing. Try again when it is ready.",
            message = "This download is still finishing. Try again when it is ready." });
        return Results.Ok(new { ok = true, message = "The download is already kept in your library." });
    }

    private async Task<(TargetRow Target, WorkRow? Work, string? Title, int? Season, int? Episode)[]> WantedRows(CancellationToken ct)
    {
        var snapshot = await targets.ReadAsync(ct);
        var works = await Rows<WorkRow>(ct);
        var names = await Rows<WorkNameRow>(ct);
        var episodes = await Rows<EpisodeRow>(ct);
        var seasons = await Rows<SeasonRow>(ct);
        var links = await Rows<DownloadTargetRow>(ct);
        return snapshot.Targets.Where(t => t.State is TargetState.Wanted or TargetState.Waiting or
            TargetState.Finding or TargetState.Checking or TargetState.Planning)
            .Where(t => !links.Any(l => l.TargetId == t.Id && snapshot.Downloads.Any(d => d.Id == l.DownloadId)))
            .Select(t =>
        {
            var work = works.FirstOrDefault(w => w.Id == t.WorkId);
            var episode = episodes.FirstOrDefault(e => e.Id == t.EpisodeId);
            var season = seasons.FirstOrDefault(s => s.Id == episode?.SeasonId);
            return (t, work, work is null ? null : CatalogProjection.Title(new(work,
                [.. names.Where(n => n.WorkId == t.WorkId)], [], [], [])),
                season?.Number, episode?.Number);
        }).ToArray();
    }

    internal async Task<object> WantedAsync(CancellationToken ct)
    {
        var rows = (await WantedRows(ct)).Select(r => (object)new
        {
            workKey = r.Work?.WorkKey ?? r.Target.WorkId, title = r.Title, year = r.Work?.Year,
            mediaType = r.Work?.Kind == WorkKind.Series ? "tv" : "movie", season = r.Season, episode = r.Episode,
            error = (string?)null, why = r.Target.ReasonText,
            looking = r.Target.State is TargetState.Wanted or TargetState.Finding or TargetState.Checking or TargetState.Planning,
            nextAttemptAt = r.Target.NextTryAt,
        }).ToList();
        var snapshot = await targets.ReadAsync(ct);
        var works = await Rows<WorkRow>(ct);
        var names = await Rows<WorkNameRow>(ct);
        foreach (var intent in snapshot.Scopes.Where(s => s.State == ScopeIntentState.Pending))
        {
            var work = works.FirstOrDefault(w => w.Id == intent.WorkId);
            var title = work is null ? intent.WorkId : CatalogProjection.Title(new(work,
                [.. names.Where(n => n.WorkId == work.Id)], [], [], []));
            var episode = intent.Scope == RequestScope.Episodes &&
                int.TryParse(intent.Id.Split(':')[^1], out var number) ? (int?)number : null;
            foreach (var season in intent.ScopeData.Seasons.Distinct())
                rows.Add(new
                {
                    workKey = work?.WorkKey ?? intent.WorkId, title, year = work?.Year,
                    mediaType = "tv", season = (int?)season, episode,
                    error = "Waiting for the show's season list", why = "Waiting for the episode list. Trying again soon.",
                    looking = false, nextAttemptAt = intent.NextTryAt,
                });
        }
        return new { wanted = rows, queue = snapshot.Queue };
    }

    internal async Task<object> WantedActionAsync(string key, int? season, int? episode, TargetAction action, CancellationToken ct)
    {
        var rows = (await WantedRows(ct)).Where(r => (r.Work?.WorkKey == key || r.Target.WorkId == key) &&
            (season is null || r.Season == season) && (episode is null || r.Episode == episode)).ToArray();
        foreach (var row in rows) await targets.ActionAsync(row.Target.Id, action, ct);
        var pending = await targets.ScopeActionAsync(key, season, episode, action, ct);
        return new { ok = true, removed = action == TargetAction.Remove ? rows.Length + pending : 0,
            retried = action == TargetAction.TryNow ? rows.Length + pending : 0 };
    }

    internal async Task<object> SettingsAsync(JsonElement? input, CancellationToken ct)
    {
        await settingsGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var row = (await store.ReadAsync<SettingRow>(AccessState.Query("engine"), ct)).Single();
            var value = SettingsCatalog.Read<EngineSettings>(row);
            var qualityRow = (await store.ReadAsync<SettingRow>(AccessState.Query("quality"), ct)).Single();
            var quality = SettingsCatalog.Read<QualitySettings>(qualityRow);
            if (input is { } body)
            {
                if (body.ValueKind != JsonValueKind.Object)
                    throw new ArgumentException("Send a settings object.");
                if (body.TryGetProperty("preferredResolution", out var resolution))
                {
                    if (resolution.ValueKind != JsonValueKind.Number || !resolution.TryGetInt32(out var pixels) ||
                        pixels is not (480 or 720 or 1080 or 2160))
                        throw new ArgumentException("Choose 480, 720, 1080 or 2160 for download quality.");
                    quality = quality with { PreferredResolution = pixels };
                }
                if (body.TryGetProperty("audioLanguage", out var audio))
                {
                    if (audio.ValueKind != JsonValueKind.String || audio.GetString() is not ("auto" or "english" or "en" or "any"))
                        throw new ArgumentException("Choose automatic, English or any audio language.");
                    quality = quality with { AudioLanguage = audio.GetString() };
                }
                if (body.TryGetProperty("maxActiveDownloads", out var cap))
                {
                    if (cap.ValueKind != JsonValueKind.Number || !cap.TryGetInt32(out var count) || count is < 1 or > 20)
                        throw new ArgumentException("Downloads at once must be a whole number from 1 to 20.");
                    value = value with { MaxActiveDownloads = count };
                }
                if (body.TryGetProperty("setupComplete", out var setup))
                    value = value with { SetupComplete = setup.GetBoolean() };
                if (body.TryGetProperty("verboseDiagnostics", out var verbose))
                    value = value with { VerboseDiagnostics = verbose.GetBoolean() };
                var next = row with { Value = JsonSerializer.SerializeToElement(value, Json),
                    Revision = row.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
                var nextQuality = qualityRow with { Value = JsonSerializer.SerializeToElement(quality, Json),
                    Revision = qualityRow.Revision + 1, UpdatedAt = next.UpdatedAt };
                var key = Guid.NewGuid().ToString("N");
                var receipt = new AttemptRow($"commit:settings:{key}", null, null, null, null, AttemptKind.LegacyEvent,
                    next.UpdatedAt, next.UpdatedAt, "applied", "settings", null, null, null, null, null, null, null);
                if (!(await store.CommitAsync(new StoreCommit(key, StoreOwner.Targets,
                    [new RowWrite(next, row.Revision, null), new RowWrite(nextQuality, qualityRow.Revision, null),
                        new RowWrite(receipt, null, null)], []), ct)).Applied)
                    throw new InvalidOperationException("Settings changed. Try again.");
                await engine.UpdateSettingsAsync(value, ct);
            }
            var roots = await Rows<StorageRootRow>(ct);
            var scheduler = SettingsCatalog.Read<SchedulerSettings>(
                (await store.ReadAsync<SettingRow>(AccessState.Query("scheduler"), ct)).Single());
            var media = await Rows<MediaFileRow>(ct);
            var maximum = roots.FirstOrDefault(r => r.Enabled)?.MaxAllocatedBytes;
            var rootPath = roots.FirstOrDefault(r => r.Enabled)?.Path;
            var categories = new[] { "Anime", "Movies", "TV", "Music", "Games", "Software", "Books", "Other" };
            // The write contract is the editable form, not the richer read-only settings view.
            if (input is not null)
                return new { settings = new
                {
                    clientType = "builtin", externalClientType = "",
                    host = "http://127.0.0.1:8080", username = "", password = "", category = "", savePath = "",
                    baseDownloadPath = rootPath ?? "",
                    maxStorageGb = (maximum / 1_000_000_000d ?? 0).ToString(CultureInfo.InvariantCulture),
                    preferredResolution = quality.PreferredResolution, audioLanguage = quality.AudioLanguage ?? "auto",
                    automationIntervalMinutes = scheduler.Enabled ? scheduler.IntervalMinutes : 0,
                    maxActiveDownloads = value.MaxActiveDownloads,
                    downloadWindows = Array.Empty<object>(), categories, pathRules = new { },
                }, testResult = (object?)null, retentionWarning = (string?)null };
            return new { settings = new
            {
                clientType = "builtin", externalClientType = (string?)null, externalClientsEnabled = false,
                host = "http://127.0.0.1:8080", username = (string?)null, hasPassword = false, category = (string?)null,
                savePath = (string?)null, baseDownloadPath = rootPath,
                maxStorageBytes = maximum, maxStorageGb = maximum / 1_000_000_000d ?? 0,
                storageCapConfigured = maximum is not null,
                setupComplete = value.SetupComplete, verboseDiagnostics = value.VerboseDiagnostics,
                preferredResolution = quality.PreferredResolution, audioLanguage = quality.AudioLanguage ?? "auto",
                automationIntervalMinutes = scheduler.Enabled ? scheduler.IntervalMinutes : 0,
                maxActiveDownloads = value.MaxActiveDownloads, maxActiveDownloadsDefault = 4,
                effectiveMaxActive = value.MaxActiveDownloads, maxActiveSource = "setting",
                downloadWindows = Array.Empty<object>(), downloadWindowOpen = true,
                categories, pathRules = new { },
                pathWarnings = Array.Empty<object>(), hasExternal = false,
                defaultRetentionPolicy = "KEPT", defaultRetentionPolicyPersisted = true,
                storageUsage = new { totalBytes = media.Sum(m => m.Bytes), keptBytes = media.Sum(m => m.Bytes),
                    indeterminateBytes = 0, items = Array.Empty<object>(),
                    diskBytes = 0L, orphanBytes = 0L, orphans = Array.Empty<object>(),
                    disk = new
                    {
                        root = rootPath, status = "not-scanned", authoritative = false,
                        observedBytes = 0L, trackedBytes = media.Sum(m => m.Bytes), internalBytes = 0L,
                        fileCount = 0, orphanFileCount = 0, truncated = false,
                        truncatedBy = Array.Empty<string>(), groupsTruncated = false,
                        unreadablePaths = Array.Empty<string>(), linksSkipped = 0, scannedAtMs = 0L,
                    } },
            }, defaults = new
            {
                categories, baseDownloadPath = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "TorrentFlow"),
                clientType = "builtin",
            } };
        }
        finally { settingsGate.Release(); }
    }

    internal async Task<object> RecoveryAsync(bool restore, CancellationToken ct)
    {
        var roots = await Rows<StorageRootRow>(ct);
        if (restore)
        {
            await engine.RecoverAsync(await Rows<DownloadRow>(ct), await Rows<DownloadFileRow>(ct), ct);
            return new { ok = true, message = "Saved downloads restored." };
        }
        return new { dataDirectory = HostPaths.DataDirectory(configuration),
            downloadDirectory = roots.FirstOrDefault(r => r.Enabled)?.Path,
            hasMedia = (await Rows<MediaFileRow>(ct)).Any(m => m.MissingSince is null) };
    }
}
