using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Store;

namespace TorrentFlow.Api;

internal static class ImportEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
        { Converters = { new JsonStringEnumConverter() } };

    internal static void MapImports(this WebApplication app)
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
        group.MapPost("/roots/{id}/rescan", async (string id, MediaImport importer, CancellationToken ct) =>
            Results.Json(await importer.RescanAsync(id, ct), Json));
        group.MapGet("/roots", async (ILibraryPlacement library, CancellationToken ct) =>
            Results.Json(new { roots = (await library.RootsAsync(ct)).OrderBy(r => r.Priority).Select(RootView) }, Json));
        group.MapPost("/roots", async (HttpContext http, ILibraryPlacement library, CancellationToken ct) =>
            RootReply(await library.AddRootAsync(await http.Request.ReadFromJsonAsync<LibraryRootInput>(Json, ct) ??
                throw new ArgumentException("Choose a folder path."), ct)));
        group.MapPut("/roots/{id}", async (string id, HttpContext http, ILibraryPlacement library, CancellationToken ct) =>
            RootReply(await library.ConfigureRootAsync(id, await http.Request.ReadFromJsonAsync<LibraryRootConfiguration>(Json, ct) ??
                throw new ArgumentException("Choose the drive settings."), ct)));
        group.MapDelete("/roots/{id}", async (string id, ILibraryPlacement library, CancellationToken ct) =>
            RootReply(await library.RemoveRootAsync(id, ct)));
        group.MapGet("/owned/{workId}", async (string workId, string? episodeId, bool? film,
            ILibraryPlacement library, CancellationToken ct) =>
            Results.Json(new { items = (await library.OwnedAsync(new(workId,
                episodeId is null ? [] : [episodeId], film == true), ct)).Select(LibraryPlacement.PublicOwned) }, Json));
    }

    private static IResult RootReply(LibraryRootResult result) =>
        Results.Json(new { root = result.Root is null ? null : RootView(result.Root), result.Failure }, Json,
            statusCode: result.Failure is null ? 200 : 409);

    // Free space is read live from the drive; it is never stored.
    private static object RootView(StorageRootRow root)
    {
        long? free = null;
        try { if (root.Online && Directory.Exists(root.Path)) free = new DriveInfo(root.Path).AvailableFreeSpace; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { }
        return new { root.Id, root.Path, root.Kinds, root.Priority, root.ReserveBytes, root.Enabled, root.Online,
            root.ReviewRequired, root.LastCheckedAt, root.LastError, root.Version, freeBytes = free };
    }
}

internal sealed record ImportDismissInput(string[] ItemIds);

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
