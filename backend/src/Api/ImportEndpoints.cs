using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Library;

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
            { return Results.BadRequest(new { error = "invalid_import", message = "The import request could not be read. Choose the files and mode again." }); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            { return Results.BadRequest(new { error = "import_failed", message = ex.Message }); }
        });
        group.MapPost("/imports/scan", (ImportScanInput input, ImportJobs jobs) =>
        {
            var scan = jobs.Start(MediaImport.ValidateFolder(input.Path));
            return Results.Json(new { scanId = scan.Id, state = scan.State }, Json, statusCode: 202);
        });
        group.MapGet("/imports/operations", async (ILibraryImportRepository repository, CancellationToken ct) =>
            Results.Json(new { operations = (await repository.ImportOperationsAsync(ct))
                .Where(o => o.State is not FileOperationState.Done and not FileOperationState.Superseded)
                .Select(o => new { o.Id, o.SourcePath, o.DestinationPath, o.State, o.LastError, o.ExpectedBytes }) }, Json));
        group.MapGet("/imports/{id}", (string id, ImportJobs jobs) =>
            jobs.Get(id) is { } scan ? Results.Json(new
            {
                scan.Id, scan.Path, scan.State, scan.Total, scan.Scanned, scan.Items, scan.Error,
                confident = scan.Items.Where(i => i.Group == ImportConfidence.Confident),
                needsPick = scan.Items.Where(i => i.Group == ImportConfidence.NeedsPick),
                unmatched = scan.Items.Where(i => i.Group == ImportConfidence.Unmatched),
                duplicates = scan.Items.Where(i => i.DuplicateKey is not null).GroupBy(i => i.DuplicateKey)
                    .Where(g => g.Count() > 1).Select(g => new { key = g.Key, itemIds = g.Select(i => i.Id) }),
            }, Json) : Results.NotFound(new { message = "This scan expired. Scan the folder again." }));
        group.MapPost("/imports/{id}/confirm", async (string id, HttpContext http, ImportJobs jobs,
            MediaImport importer, CancellationToken ct) =>
        {
            var input = await http.Request.ReadFromJsonAsync<ImportConfirmInput>(Json, ct) ??
                throw new ArgumentException("Choose files and an import mode.");
            var scan = jobs.Get(id);
            if (scan is null) return Results.NotFound(new { message = "This scan expired. Scan the folder again." });
            using var held = await jobs.LockAsync(id, ct);
            return Results.Json(await importer.ConfirmAsync(scan, input, ct), Json);
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

internal sealed class ImportJobs(IServiceScopeFactory scopes, IHostApplicationLifetime lifetime)
{
    private readonly ConcurrentDictionary<string, ImportScanView> scans = new();
    private readonly ConcurrentDictionary<string, SemaphoreSlim> locks = new();
    private readonly SemaphoreSlim scanning = new(2);

    internal ImportScanView? Get(string id) => scans.GetValueOrDefault(id);
    internal ImportScanView Start(string path)
    {
        if (scans.Count >= 20) throw new ArgumentException("There are 20 scans in this session. Restart the app before scanning more folders.");
        var id = Guid.NewGuid().ToString("N");
        var scan = new ImportScanView(id, path, "queued", 0, 0, [], null);
        scans[id] = scan;
        locks[id] = new(1);
        _ = Task.Run(async () =>
        {
            var acquired = false;
            try
            {
                await scanning.WaitAsync(lifetime.ApplicationStopping);
                acquired = true;
                await using var scope = scopes.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<MediaImport>()
                    .ScanAsync(id, path, update => scans[id] = update, lifetime.ApplicationStopping);
            }
            catch (Exception ex)
            { scans[id] = scans[id] with { State = "failed", Error = ex.Message }; }
            finally { if (acquired) scanning.Release(); }
        }, CancellationToken.None);
        return scan;
    }
    internal async Task<IDisposable> LockAsync(string id, CancellationToken ct)
    {
        var gate = locks[id];
        await gate.WaitAsync(ct);
        return new Releaser(gate);
    }
    private sealed class Releaser(SemaphoreSlim gate) : IDisposable
    { public void Dispose() => gate.Release(); }
}
