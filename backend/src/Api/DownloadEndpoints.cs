using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.Access;
using TorrentFlow.Api.Catalog;
using TorrentFlow.Domain;
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
        group.MapGet("/client/torrents", async (DownloadsApi api, CancellationToken ct) =>
            Reply(await api.ListAsync(ct)));
        group.MapPost("/client/torrents", async (DownloadAction input, DownloadsApi api, CancellationToken ct) =>
            Reply(await api.ActionAsync(input, ct)));
        group.MapPost("/title/{workKey}", async (string workKey, TitleDownload input, HttpContext http,
            TargetPipeline targets, CancellationToken ct) =>
        {
            if (input.Season is < 0 or > 999 || input.Episode is < 1 or > 99999 ||
                input.PreferredResolution is < 1 or > 4320)
                return Results.BadRequest(new { message = "Choose a valid season, episode and quality." });
            var reply = await targets.AcquireAsync(new(workKey, input.Season, input.Episode,
                input.PreferredResolution), AccessIdentity.Actor(http).UserId, ct);
            return Results.Ok(new { ok = reply.Accepted, queued = reply.Queued, owned = reply.Owned,
                message = reply.Message });
        });
        group.MapPut("/client/torrents/rank", async (TargetEndpoints.RankInput input,
            TargetPipeline targets, CancellationToken ct) =>
        {
            await targets.RankAsync(input.TargetIds, ct);
            return Results.Ok(new { ok = true, ranked = input.TargetIds.Length });
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
        group.MapGet("/settings/download-recovery/sources", () => Results.Ok(new
        {
            candidates = Array.Empty<object>(),
            warnings = new[] { "Importing downloads from other clients is not available in this build." },
        }));
        group.MapPost("/settings/download-recovery/sources", () => Results.Json(new
        {
            ok = false, message = "Importing downloads from other clients is not available in this build.",
        }, statusCode: 501));
    }

    internal sealed record DownloadAction(string Action, string? Hash = null, string[]? Hashes = null,
        string? OwnerClientType = null, bool DeleteFiles = false);
    internal sealed record TitleDownload(int? Season = null, int? Episode = null, int? PreferredResolution = null);
}

internal sealed class DownloadsApi(TargetPipeline targets, IEngine engine, IServiceScopeFactory scopes,
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
            var work = works.FirstOrDefault(w => w.Id == target?.WorkId);
            var episode = episodes.FirstOrDefault(e => e.Id == target?.EpisodeId);
            var season = seasons.FirstOrDefault(s => s.Id == episode?.SeasonId);
            var release = releases.FirstOrDefault(r => r.Id == download.Hash);
            var done = download.FinishedAt is not null || target?.State == TargetState.Done ||
                rawIntent?.State == RawDownloadState.Done;
            var paused = target?.State == TargetState.Paused || rawIntent?.State == RawDownloadState.Paused ||
                live?.Intent == DownloadIntent.Paused;
            var failed = live?.Failure is not null || live is null &&
                target?.State == TargetState.Waiting && target.ReasonCode != WaitReason.DownloadCap;
            var state = done ? "complete" : paused ? "paused" : failed ? "error" :
                live?.Complete == true || target?.State == TargetState.Filing ? "finishing" :
                live?.Active == true ? !live.MetadataAvailable ? "metaDL" :
                    live.StalledProgress ? "stalledDL" : "downloading" : "queued";
            var selected = files.Where(f => f.DownloadId == download.Id && f.Role != FileRole.Unwanted).ToArray();
            var size = selected.Length > 0 ? selected.Sum(f => f.ExpectedBytes) : live?.SelectedBytes ?? 0;
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
                forced = target?.NowAt is not null || rawIntent?.NowAt is not null,
                queuePosition = state == "queued" ? (int?)++queuePosition : null,
                waitReason = state == "queued" && live is not null ? "queue-full" : null,
                waitingReason = target?.ReasonText ?? (state == "queued" ? "Waiting for a download slot." :
                    live?.StalledProgress == true ? "Waiting for peers to send data." : null),
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
        return new { torrents = rows, clientType = "builtin", host = (string?)null, offline = false, hasExternal = false,
            externalClientType = (string?)null, partial = false, clientIssues = Array.Empty<object>() };
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
        if (input.DeleteFiles) throw new ArgumentException("Deleting media files is not available here yet. Remove the download without deleting files.");
        var hashes = input.Hashes ?? (input.Hash is { } singleHash ? [singleHash] : []);
        if (hashes.Length == 0 || hashes.Length > 500) throw new ArgumentException("Choose downloads to change.");
        var snapshot = await targets.ReadAsync(ct);
        var links = await Rows<DownloadTargetRow>(ct);
        foreach (var hash in hashes.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var download = snapshot.Downloads.FirstOrDefault(d => d.Hash.Equals(hash, StringComparison.OrdinalIgnoreCase));
            if (download is null) continue;
            var ids = links.Where(l => l.DownloadId == download.Id).Select(l => l.TargetId).Distinct().ToArray();
            if (ids.Length == 0) throw new ArgumentException("This raw download does not support target actions yet.");
            foreach (var id in ids) await targets.ActionAsync(id, action, ct);
        }
        return new { ok = true };
    }

    private async Task<(TargetRow Target, WorkRow? Work, string? Title, int? Season, int? Episode)[]> WantedRows(CancellationToken ct)
    {
        var snapshot = await targets.ReadAsync(ct);
        var works = await Rows<WorkRow>(ct);
        var names = await Rows<WorkNameRow>(ct);
        var episodes = await Rows<EpisodeRow>(ct);
        var seasons = await Rows<SeasonRow>(ct);
        return snapshot.Targets.Where(t => t.State is TargetState.Wanted or TargetState.Waiting or
            TargetState.Finding or TargetState.Checking or TargetState.Planning).Select(t =>
        {
            var work = works.FirstOrDefault(w => w.Id == t.WorkId);
            var episode = episodes.FirstOrDefault(e => e.Id == t.EpisodeId);
            var season = seasons.FirstOrDefault(s => s.Id == episode?.SeasonId);
            return (t, work, work is null ? null : CatalogProjection.Title(new(work,
                [.. names.Where(n => n.WorkId == t.WorkId)], [], [], [])),
                season?.Number, episode?.Number);
        }).ToArray();
    }

    internal async Task<object> WantedAsync(CancellationToken ct) => new
    {
        wanted = (await WantedRows(ct)).Select(r => new
        {
            workKey = r.Work?.WorkKey ?? r.Target.WorkId, title = r.Title, year = r.Work?.Year,
            mediaType = r.Work?.Kind == WorkKind.Series ? "tv" : "movie", season = r.Season, episode = r.Episode,
            error = (string?)null, why = r.Target.ReasonText,
            looking = r.Target.State is TargetState.Finding or TargetState.Checking or TargetState.Planning,
            nextAttemptAt = r.Target.NextTryAt,
        }),
        queue = new { },
    };

    internal async Task<object> WantedActionAsync(string key, int? season, int? episode, TargetAction action, CancellationToken ct)
    {
        var rows = (await WantedRows(ct)).Where(r => (r.Work?.WorkKey == key || r.Target.WorkId == key) &&
            (season is null || r.Season == season) && (episode is null || r.Episode == episode)).ToArray();
        foreach (var row in rows) await targets.ActionAsync(row.Target.Id, action, ct);
        return new { ok = true, removed = action == TargetAction.Remove ? rows.Length : 0 };
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
            if (input is { } body)
            {
                if (body.TryGetProperty("maxActiveDownloads", out var cap))
                {
                    if (!cap.TryGetInt32(out var count) || count is < 1 or > 20)
                        throw new ArgumentException("Downloads at once must be a whole number from 1 to 20.");
                    value = value with { MaxActiveDownloads = count };
                }
                if (body.TryGetProperty("setupComplete", out var setup))
                    value = value with { SetupComplete = setup.GetBoolean() };
                if (body.TryGetProperty("verboseDiagnostics", out var verbose))
                    value = value with { VerboseDiagnostics = verbose.GetBoolean() };
                var next = row with { Value = JsonSerializer.SerializeToElement(value, Json),
                    Revision = row.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
                if (!(await AccessState.CommitAsync(store, next, row.Revision, null, ct)).Applied)
                    throw new InvalidOperationException("Settings changed. Try again.");
                await engine.UpdateSettingsAsync(value, ct);
            }
            var roots = await Rows<StorageRootRow>(ct);
            var quality = SettingsCatalog.Read<QualitySettings>(
                (await store.ReadAsync<SettingRow>(AccessState.Query("quality"), ct)).Single());
            var scheduler = SettingsCatalog.Read<SchedulerSettings>(
                (await store.ReadAsync<SettingRow>(AccessState.Query("scheduler"), ct)).Single());
            var media = await Rows<MediaFileRow>(ct);
            var maximum = roots.FirstOrDefault(r => r.Enabled)?.MaxAllocatedBytes;
            return new { settings = new
            {
                clientType = "builtin", externalClientType = (string?)null, externalClientsEnabled = false,
                host = "", username = (string?)null, hasPassword = false, category = (string?)null,
                savePath = (string?)null, baseDownloadPath = roots.FirstOrDefault(r => r.Enabled)?.Path,
                maxStorageBytes = maximum, maxStorageGb = maximum / 1_000_000_000d,
                storageCapConfigured = maximum is not null,
                setupComplete = value.SetupComplete, verboseDiagnostics = value.VerboseDiagnostics,
                preferredResolution = quality.PreferredResolution, audioLanguage = quality.AudioLanguage ?? "auto",
                automationIntervalMinutes = scheduler.Enabled ? scheduler.IntervalMinutes : 0,
                maxActiveDownloads = value.MaxActiveDownloads, maxActiveDownloadsDefault = 4,
                effectiveMaxActive = value.MaxActiveDownloads, maxActiveSource = "setting",
                downloadWindows = Array.Empty<object>(), downloadWindowOpen = true,
                categories = new[] { "Movies", "TV", "Anime", "Other" }, pathRules = new { },
                pathWarnings = Array.Empty<object>(), hasExternal = false,
                defaultRetentionPolicy = "KEPT", defaultRetentionPolicyPersisted = true,
                storageUsage = new { totalBytes = media.Sum(m => m.Bytes), keptBytes = media.Sum(m => m.Bytes),
                    indeterminateBytes = 0, items = Array.Empty<object>() },
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
