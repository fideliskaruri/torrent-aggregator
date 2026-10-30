using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Library.Jellyfin;
using TorrentFlow.Store;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class ImportEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
        { Converters = { new JsonStringEnumConverter() } };

    internal static void MapImports(this WebApplication app, JellyfinLibrarySync jellyfinSync)
    {
        var group = app.MapGroup("/api/library").AddEndpointFilter(async (context, next) =>
        {
            if (AccessIdentity.Actor(context.HttpContext).Role != UserRole.Owner) return Results.StatusCode(403);
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            try { return await next(context); }
            catch (Exception ex) when (ex is JsonException or BadHttpRequestException)
            { return Results.BadRequest(new { error = "invalid_import", message = "The import request could not be read. Choose the files again." }); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            { return Results.BadRequest(new { error = "import_failed", message = ex.Message }); }
        });
        group.MapPost("/imports/scan", (ImportScanInput input, ImportJobs jobs) =>
        {
            var path = MediaImport.ValidateFolder(input.Path);
            var scan = jobs.Start(path);
            return Results.Json(new { scanId = scan.Id, state = scan.State }, Json, statusCode: 202);
        });
        group.MapGet("/imports", async (ImportReviewRepository reviews, CancellationToken ct) =>
            Results.Json(new { scans = (await reviews.ListAsync(ct)).Where(s => !s.Items.IsEmpty ||
                s.State is "queued" or "scanning" or "failed").Select(s => new { s.Id, s.Path, s.State,
                    s.Error, pending = s.Items.Length,
                    title = s.Items.IsEmpty ? null : Path.GetFileName(s.Items[0].Path) }) }, Json));
        group.MapGet("/imports/{id}", async (string id, ImportJobs jobs, CancellationToken ct) =>
            await jobs.GetAsync(id, ct) is { } scan ? Results.Json(new
            {
                scan.Id, scan.Path, scan.State, scan.Total, scan.Scanned, scan.Items, scan.Error,
                confident = scan.Items.Where(i => i.Group == ImportConfidence.Confident),
                needsPick = scan.Items.Where(i => i.Group == ImportConfidence.NeedsPick),
                unmatched = scan.Items.Where(i => i.Group == ImportConfidence.Unmatched),
            }, Json) : Results.NotFound(new { message = "This scan expired. Scan the folder again." }));
        group.MapPost("/imports/{id}/confirm", async (string id, HttpContext http, ImportJobs jobs,
            MediaImport importer, OldTorrentHandoff handoff, CancellationToken ct) =>
        {
            var input = await http.Request.ReadFromJsonAsync<ImportConfirmInput>(Json, ct) ??
                throw new ArgumentException("Choose files to import.");
            using var held = await jobs.LockAsync(id, ct);
            var scan = await jobs.GetAsync(id, ct);
            if (scan is null) return Results.NotFound(new { message = "This scan does not exist. Scan the folder again." });
            var result = await importer.ConfirmAsync(scan, input, ct);
            await using var scope = jobs.CreateScope();
            var reviews = scope.ServiceProvider.GetRequiredService<ImportReviewRepository>();
            foreach (var item in result.Items.Where(i => i.Error is null && (i.Imported || i.AlreadyInLibrary)))
                await reviews.DecideAsync(id, item.ItemId, "confirmed", ct);
            handoff.Kick();
            return Results.Json(result, Json);
        });
        group.MapPost("/imports/{id}/dismiss", async (string id, ImportDismissInput input, ImportJobs jobs,
            ImportReviewRepository reviews, CancellationToken ct) =>
        {
            using var held = await jobs.LockAsync(id, ct);
            var scan = await jobs.GetAsync(id, ct);
            if (scan is null) return Results.NotFound();
            if (input.ItemIds.Any(item => scan.Items.All(i => i.Id != item)))
                throw new ArgumentException("Choose files from this review.");
            foreach (var item in input.ItemIds) await reviews.DecideAsync(id, item, "dismissed", ct);
            return Results.Ok(new { dismissed = input.ItemIds.Length });
        });
        group.MapPost("/roots/{id}/rescan", async (string id, MediaImport importer, TargetPipeline targets,
            CancellationToken ct) =>
        {
            var result = await importer.RescanAsync(id, ct);
            if (result.Online) await targets.WakeStorageWaitsAsync(ct);
            return Results.Json(result, Json);
        });
        group.MapGet("/roots", async (ILibraryPlacement library, ILibraryRepository inventory,
            IStorageStatus storage, CancellationToken ct) =>
        {
            var roots = await library.RootsAsync(ct);
            var media = await inventory.MediaAsync(null, ct);
            var downloads = await inventory.DownloadsAsync(ct);
            var bindings = await inventory.BindingsAsync(ct);
            var jellyfin = await jellyfinSync.GetStatusesAsync(roots, ct);
            return Results.Json(new { roots = roots.Select((root, index) =>
                RootView(root, media, downloads, bindings, storage, jellyfin[index])) }, Json);
        });
        group.MapPost("/roots", async (HttpContext http, ILibraryPlacement library,
            ILibraryRepository inventory, IStorageStatus storage, TargetPipeline targets,
            CancellationToken ct) =>
        {
            var result = await library.AddRootAsync(await http.Request.ReadFromJsonAsync<LibraryRootInput>(Json, ct) ??
                throw new ArgumentException("Choose a folder path."), ct);
            if (result.Failure is null) await targets.WakeStorageWaitsAsync(ct);
            if (result.Failure is null) jellyfinSync.RequestSync();
            return await RootReplyAsync(result, inventory, storage, jellyfinSync, ct);
        });
        group.MapPut("/roots/{id}", async (string id, HttpContext http, ILibraryPlacement library,
            ILibraryRepository inventory, IStorageStatus storage, TargetPipeline targets, CancellationToken ct) =>
        {
            var result = await library.ConfigureRootAsync(id,
                await http.Request.ReadFromJsonAsync<LibraryRootConfiguration>(Json, ct) ??
                    throw new ArgumentException("Choose the drive settings."), ct);
            if (result.Failure is null) await targets.WakeStorageWaitsAsync(ct);
            if (result.Failure is null) jellyfinSync.RequestSync();
            return await RootReplyAsync(result, inventory, storage, jellyfinSync, ct);
        });
        group.MapPut("/roots/order", async (RootOrderInput input, ILibraryPlacement library,
            TargetPipeline targets, CancellationToken ct) =>
        {
            if (input.Ids is null || input.Ids.Length == 0)
                return Results.BadRequest(new { message = "Send every storage location id once, in the order you want." });
            var roots = await library.RootsAsync(ct);
            if (input.Ids.Length != roots.Length || input.Ids.Distinct(StringComparer.Ordinal).Count() != input.Ids.Length ||
                input.Ids.Any(id => roots.All(root => root.Id != id)))
                return Results.BadRequest(new { message = "The order must include every storage location id exactly once. Reload the list and try again." });
            if (!await library.ReorderRootsAsync([.. input.Ids], ct))
                return Results.Conflict(new { message = "The storage locations changed while saving. Reload and try again." });
            await targets.WakeStorageWaitsAsync(ct);
            return Results.Ok(new { roots = input.Ids });
        });
        group.MapDelete("/roots/{id}", async (string id, ILibraryPlacement library,
            ILibraryRepository inventory, IStorageStatus storage, CancellationToken ct) =>
        {
            var result = await library.RemoveRootAsync(id, ct);
            if (result.Failure is null) jellyfinSync.RequestSync();
            return await RootReplyAsync(result, inventory, storage, jellyfinSync, ct);
        });
        group.MapPost("/roots/{id}/jellyfin/sync", async (string id, ILibraryPlacement library,
            CancellationToken ct) =>
        {
            var root = (await library.RootsAsync(ct)).SingleOrDefault(item => item.Id == id);
            if (root is null) return Results.NotFound(new { message = "This storage location no longer exists." });
            if (!root.Enabled) return Results.Conflict(new { message = "Turn on this storage location before syncing it to Jellyfin." });
            var status = await jellyfinSync.SyncNowAsync(id, ct);
            return Results.Json(new { jellyfin = new { state = status.State, libraries = status.Libraries, status.Message } }, Json,
                statusCode: status.State == "failed" ? 503 : 200);
        });
        group.MapPost("/roots/{id}/jellyfin/remove", async (string id, CancellationToken ct) =>
        {
            try { return Results.Json(await jellyfinSync.RemoveRootPathsAsync(id, ct), Json); }
            catch (JellyfinException ex)
            {
                return Results.Json(new { removed = 0, ignored = 0, message = ex.Message },
                    statusCode: ex.Kind == JellyfinErrorKind.Unauthorized ? 403 : 503);
            }
        });
        app.MapGet("/api/jellyfin/orphan-paths", async (HttpContext http, CancellationToken ct) =>
        {
            if (AccessIdentity.Actor(http).Role != UserRole.Owner) return Results.StatusCode(403);
            http.Response.Headers.CacheControl = "no-store";
            return Results.Json(new { paths = await jellyfinSync.OrphanPathsAsync(ct) }, Json);
        });
        group.MapGet("/owned/{workId}", async (string workId, string? episodeId, bool? film,
            ILibraryPlacement library, CancellationToken ct) =>
            Results.Json(new { items = (await library.OwnedAsync(new(workId,
                episodeId is null ? [] : [episodeId], film == true), ct)).Select(LibraryPlacement.PublicOwned) }, Json));
    }

    private static async Task<IResult> RootReplyAsync(LibraryRootResult result,
        ILibraryRepository inventory, IStorageStatus storage, JellyfinLibrarySync jellyfinSync,
        CancellationToken ct)
    {
        object? view = null;
        if (result.Root is { } root)
        {
            var statuses = await jellyfinSync.GetStatusesAsync([root], ct);
            view = RootView(root, await inventory.MediaAsync(null, ct), await inventory.DownloadsAsync(ct),
                await inventory.BindingsAsync(ct), storage, statuses[0]);
        }
        return Results.Json(new { root = view, result.Failure }, Json,
            statusCode: result.Failure is null ? 200 : result.Failure.Code == "RootConflict" ? 409 : 400);
    }

    private static object RootView(StorageRootRow root, ImmutableArray<MediaFileRow> media,
        ImmutableArray<DownloadRow> downloads, ImmutableArray<DownloadFileRow> bindings, IStorageStatus storage,
        JellyfinRootStatus jellyfin)
    {
        var observed = storage.Status(root.Path);
        var online = root.Enabled && !root.ReviewRequired && observed.Online;
        long? total = null;
        try { if (online) total = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(root.Path))!).TotalSize; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { }
        var free = online ? observed.FreeBytes : null;
        var reserve = StorageCapacity.EffectiveReserve(root, total);
        var committed = StorageCapacity.CommittedBytes(root.Id, downloads, bindings);
        var used = media.Where(m => m.RootId == root.Id).Sum(m => m.Bytes);
        var missing = root.ReviewRequired ? media.Count(m => m.RootId == root.Id && m.Status == FilePresence.Missing) : 0;
        var state = !root.Enabled ? "off" : root.ReviewRequired ? "review" : !online ? "offline" :
            free is { } available && Math.Max(0, available - reserve) < 1_000_000_000L ? "full" : "online";
        return new { root.Id, root.Path, root.Kinds, root.Priority, root.Enabled, online,
            root.ReviewRequired, root.LastCheckedAt, root.LastError, root.Version, totalBytes = total,
            freeBytes = free, committedBytes = committed, maxAllocatedBytes = root.MaxAllocatedBytes,
            usedBytes = used, reserveBytes = reserve, reserveSetting = root.ReserveBytes, status = state, missingCount = missing,
            label = storage.Label(root.Path),
            jellyfin = new { state = jellyfin.State, libraries = jellyfin.Libraries, message = jellyfin.Message } };
    }
}

internal sealed record ImportDismissInput(string[] ItemIds);
internal sealed record RootOrderInput(string[] Ids);

internal sealed class ImportJobs(IServiceScopeFactory scopes, IHostApplicationLifetime lifetime)
{
    private readonly ConcurrentDictionary<string, ImportScanView> scans = new();
    private readonly ConcurrentDictionary<string, SemaphoreSlim> locks = new();
    private readonly SemaphoreSlim scanning = new(2);

    internal AsyncServiceScope CreateScope() => scopes.CreateAsyncScope();
    internal async Task<ImportScanView?> GetAsync(string id, CancellationToken ct)
    {
        if (scans.TryGetValue(id, out var running) && running.State is "queued" or "scanning") return running;
        await using var scope = scopes.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ImportReviewRepository>().GetAsync(id, ct) ?? running;
    }
    internal ImportScanView Start(string path)
    {
        if (scans.Values.Count(s => s.State is "queued" or "scanning") >= 20)
            throw new ArgumentException("There are 20 scans running. Wait for one to finish before scanning more folders.");
        var id = Guid.NewGuid().ToString("N");
        var scan = new ImportScanView(id, path, "queued", 0, 0, [], null);
        scans[id] = scan;
        locks[id] = new(1);
        _ = Task.Run(async () =>
        {
            var acquired = false;
            await using var scope = scopes.CreateAsyncScope();
            var reviews = scope.ServiceProvider.GetRequiredService<ImportReviewRepository>();
            try
            {
                await reviews.SaveAsync(scan, lifetime.ApplicationStopping);
                await scanning.WaitAsync(lifetime.ApplicationStopping);
                acquired = true;
                await scope.ServiceProvider.GetRequiredService<MediaImport>()
                    .ScanAsync(id, path, update => scans[id] = update, lifetime.ApplicationStopping);
                await reviews.SaveAsync(scans[id], lifetime.ApplicationStopping);
            }
            catch (Exception ex)
            {
                scans[id] = scans[id] with { State = "failed", Error = ex.Message };
                await reviews.SaveAsync(scans[id], CancellationToken.None);
            }
            finally { if (acquired) scanning.Release(); }
        }, CancellationToken.None);
        return scan;
    }
    internal async Task<IDisposable> LockAsync(string id, CancellationToken ct)
    {
        var gate = locks.GetOrAdd(id, _ => new(1));
        await gate.WaitAsync(ct);
        return new Releaser(gate);
    }
    private sealed class Releaser(SemaphoreSlim gate) : IDisposable
    { public void Dispose() => gate.Release(); }
}
