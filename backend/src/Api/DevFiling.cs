using System.Collections.Immutable;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Library;

namespace TorrentFlow.Api;

// Phase-5 composition only. Module code consumes Domain contracts; no module references another.
internal sealed class DevFiling(MonoTorrentEngine engine, IServiceScopeFactory scopes)
{
    private const string Prefix = "filing:";
    private readonly SemaphoreSlim gate = new(1, 1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
        { Converters = { new JsonStringEnumConverter() } };
    private readonly Dictionary<string, Failure> reasons = [];

    internal static void Map(WebApplication app)
    {
        if (!app.Environment.IsDevelopment()) return;
        var group = app.MapGroup("/api/dev/filing").AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var actor = AccessIdentity.Actor(http);
            if (actor.Role != UserRole.Owner || !actor.TrustedLocal ||
                http.Connection.RemoteIpAddress is not { } ip || !IPAddress.IsLoopback(ip))
                return Results.StatusCode(403);
            try { return await next(context); }
            catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or IOException)
            { return Results.Conflict(new { message = ex.Message }); }
            catch (OperationCanceledException) when (!http.RequestAborted.IsCancellationRequested)
            { return Results.Json(new { waiting = true, message = "No file list arrived. Check the connection or choose another torrent." }, statusCode: 408); }
        });
        group.MapPost("/", async (Input input, DevFiling filing, CancellationToken ct) =>
            Results.Json(await filing.AddAsync(input, ct), Json));
        group.MapGet("/", async (DevFiling filing, CancellationToken ct) =>
            Results.Json(await filing.ReadAsync(ct), Json));
        group.MapDelete("/{hash}", async (string hash, DevFiling filing, CancellationToken ct) =>
            Results.Json(await filing.RemoveAsync(MonoTorrentEngine.NormalizeHash(hash), ct), Json));
        group.MapPost("/{hash}/prioritize/{index:int}", async (string hash, int index, MonoTorrentEngine engine, CancellationToken ct) =>
        {
            await engine.PrioritizeDevFileAsync(Prefix + MonoTorrentEngine.NormalizeHash(hash), index, ct);
            return Results.Ok(new { prioritized = index });
        });
    }

    private async Task<object> AddAsync(Input input, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
            var library = scope.ServiceProvider.GetRequiredService<ILibraryPlacement>();
            var hash = MonoTorrentEngine.NormalizeHash(input.Magnet);
            var id = Prefix + hash;
            if ((await AccessState.AllAsync<DownloadRow>(store, ct)).Any(d => d.Id == id))
                return new { accepted = true, duplicate = true };
            var candidate = MonoTorrentEngine.CandidateFor(input.Magnet, input.TorrentUri);
            var attachment = await engine.AttachProbeAsync(candidate, ct);
            if (attachment.Handle is not { } handle) return new { accepted = false, failure = attachment.Failure };
            var token = Guid.NewGuid().ToString("N");
            try
            {
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                deadline.CancelAfter(TimeSpan.FromSeconds(30));
                var metadata = await engine.WaitMetadataAsync(handle, deadline.Token);
                var placement = await library.PlaceAsync(input.Placement with
                {
                    Files = metadata, Assignment = input.Placement.Assignment with { Hash = hash },
                }, ct);
                if (placement.Failure is { } failure)
                {
                    reasons[id] = failure;
                    return new { accepted = false, waiting = !failure.NeedsOwner, failure };
                }
                var root = (await library.RootsAsync(ct)).Single(r => r.Id == placement.RootId);
                var folder = placement.Folders.Single();
                var itemFolder = LibraryPaths.Within(root.Path, folder.RelativeItemFolder!);
                var files = DownloadFiling.BindUnwanted(id, hash, itemFolder, metadata, placement.Files);
                var now = DateTimeOffset.UtcNow;
                var download = new DownloadRow(id, hash, DownloadIntent.Run, root.Id, now, null, token, null, null, 1);
                var claim = await engine.ClaimAdmissionAsync(new(token, hash, id, handle, now.AddSeconds(90)), ct);
                if (!claim.Accepted) return new { accepted = false, failure = claim.Failure };
                var targets = input.Placement.Targets;
                var find = scope.ServiceProvider.GetRequiredKeyedService<IStore>("find");
                var oldRelease = (await find.ReadAsync<ReleaseRow>(AccessState.Query(hash), ct)).SingleOrDefault();
                var release = candidate.Release with { Files = metadata, TotalBytes = metadata.Sum(f => f.Bytes) };
                await CommitAsync(find, [new(release, null, oldRelease)], [], ct, StoreOwner.Find);
                var targetWrites = ImmutableArray.CreateBuilder<RowWrite>();
                foreach (var target in targets)
                {
                    var oldTarget = (await store.ReadAsync<TargetRow>(AccessState.Query(target.Id), ct)).SingleOrDefault();
                    targetWrites.Add(new(target with { Version = oldTarget is null ? 1 : oldTarget.Version + 1 },
                        oldTarget?.Version, null));
                }
                var writes = targetWrites.ToImmutable().Add(new(download, null, null));
                await CommitAsync(store, writes, [], ct);
                if (!await repository.SavePlacementAsync(files, placement.Folders, ct))
                    throw new InvalidOperationException("Library placement changed. Reload the library and retry.");
                var result = await engine.AdmitFromProbeAsync(handle, new(download, candidate,
                    [.. files.Select(f => new FileBinding(f.FileIndex, f.EnginePath!, f.Selected))], token), ct);
                if (!result.Accepted) throw new InvalidOperationException(result.Failure?.Message);
                reasons.Remove(id);
                await engine.SaveDevStateAsync(ct);
                return new { accepted = true, placement, snapshot = result.Snapshot };
            }
            finally
            {
                await engine.ReleaseAdmissionClaimAsync(token, CancellationToken.None);
                await engine.ReleaseProbeAsync(handle, CancellationToken.None);
            }
        }
        finally { gate.Release(); }
    }

    internal async Task TickAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
            var downloads = (await AccessState.AllAsync<DownloadRow>(store, ct)).Where(d => d.Id.StartsWith(Prefix)).ToArray();
            if (downloads.Length == 0) return;
            var allFiles = await repository.BindingsAsync(ct);
            foreach (var download in downloads)
            {
                var files = allFiles.Where(f => f.DownloadId == download.Id).ToImmutableArray();
                var snapshot = (await engine.SnapshotAsync(ct)).SingleOrDefault(s => s.DownloadId == download.Id);
                if (snapshot is null && download.FinishedAt is null)
                {
                    await engine.ClaimAdmissionAsync(new(download.AdmissionToken, download.Hash, download.Id, null,
                        DateTimeOffset.UtcNow.AddSeconds(90)), ct);
                    var restored = await engine.StartAsync(new(download, MonoTorrentEngine.CandidateFor(download.Hash),
                        [.. files.Select(f => new FileBinding(f.FileIndex, f.EnginePath!, f.Selected))],
                        download.AdmissionToken), ct);
                    snapshot = restored.Snapshot;
                }
                if (snapshot is null) continue;
                foreach (var binding in files.Where(f => f.Selected && !f.Filed))
                {
                    var live = snapshot.Files.Single(f => f.Index == binding.FileIndex);
                    if (!live.AllTouchingPiecesComplete) continue;
                    var permit = await engine.PrepareFilingAsync(new(binding.Id, download.Id,
                        [new(binding.FileIndex, binding.FinalPath!, false)]), ct);
                    if (permit.Failure is { } failure) { reasons[download.Id] = failure; continue; }
                    var committed = false;
                    try
                    {
                        if (DownloadFiling.ValidatePartial(binding, live) is { } invalid)
                        { reasons[download.Id] = invalid; continue; }
                        var digest = await DownloadFiling.DigestAsync(live.PhysicalPath!, ct);
                        if (!await repository.BeginFilingAsync(binding, digest, ct))
                        { reasons[download.Id] = new("FilingConflict", "The completed file changed. Check the library.", null, true); continue; }
                        var publication = await engine.PublishFilingAsync(permit, ct);
                        if (!publication.Accepted) { reasons[download.Id] = publication.Failure!; continue; }
                        await engine.SaveDevStateAsync(ct);
                        var target = (await store.ReadAsync<TargetRow>(AccessState.Query(binding.TargetId!), ct)).Single();
                        var work = (await store.ReadAsync<WorkRow>(AccessState.Query(target.WorkId), ct)).Single();
                        var release = (await store.ReadAsync<ReleaseRow>(AccessState.Query(download.Hash), ct)).Single();
                        var context = new DownloadFilingContext(download, new(work, [], [], [], []), [target],
                            release.Parsed.Quality.Resolution, release.Parsed.Quality.Source);
                        var media = DownloadFiling.Media(context, binding) with { ContentDigest = digest };
                        var after = binding with { EnginePath = binding.FinalPath, PartialPath = null,
                            Selected = false, Filed = true, MediaFileId = media.Id };
                        committed = await repository.CommitFiledAsync(binding, after, media, ct);
                        if (!committed) { reasons[download.Id] = new("InventoryConflict", "The library changed. Retry filing.", null, false); continue; }
                        reasons.Remove(download.Id);
                    }
                    finally { await engine.CompleteFilingAsync(permit, committed, CancellationToken.None); }
                }
                var updated = (await repository.BindingsAsync(ct)).Where(f => f.DownloadId == download.Id).ToArray();
                if (updated.Any(f => f.Role != FileRole.Unwanted) && updated.Where(f => f.Role != FileRole.Unwanted).All(f => f.Filed) &&
                    download.FinishedAt is null)
                {
                    await engine.DetachAsync(download.Id, ct);
                    foreach (var fragment in updated.Where(f => f.Role == FileRole.Unwanted))
                    {
                        LibraryPaths.NoLinks(fragment.EnginePath!);
                        if (File.Exists(fragment.EnginePath)) File.Delete(fragment.EnginePath!);
                    }
                    await CommitAsync(store, [new(download with { Intent = DownloadIntent.Stopped,
                        FinishedAt = DateTimeOffset.UtcNow, Version = download.Version + 1 }, download.Version, null)], [], ct);
                    await engine.SaveDevStateAsync(ct);
                }
            }
        }
        finally { gate.Release(); }
    }

    private async Task<object> ReadAsync(CancellationToken ct)
    {
        await TickAsync(ct);
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var repository = scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
            return new { live = await engine.SnapshotAsync(ct), bindings = await repository.BindingsAsync(ct),
                media = await repository.MediaAsync(null, ct), reasons = reasons.ToDictionary() };
        }
        finally { gate.Release(); }
    }

    private async Task<object> RemoveAsync(string hash, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var id = Prefix + hash;
            var download = (await store.ReadAsync<DownloadRow>(AccessState.Query(id), ct)).SingleOrDefault();
            if (download is null) return new { removed = true };
            var bindings = (await repository.BindingsAsync(ct)).Where(f => f.DownloadId == id).ToImmutableArray();
            await engine.RemoveDevAsync(hash, ct);
            var root = (await repository.RootsAsync(ct)).Single(r => r.Id == download.RootId);
            var targets = (await AccessState.AllAsync<TargetRow>(store, ct)).Where(t => bindings.Any(f => f.TargetId == t.Id)).ToArray();
            var folder = (await repository.FoldersAsync(ct)).Single(f => targets.Any(t => t.WorkId == f.WorkId));
            await DownloadFiling.DeletePayloadAsync(bindings, LibraryPaths.Within(root.Path, folder.RelativeItemFolder!), hash,
                await repository.FilingOperationsAsync(ct), await repository.MediaAsync(null, ct), ct);
            if (!await repository.RemoveDownloadFilesAsync(id, ct)) throw new IOException("The library changed while removing files.");
            await CommitAsync(store, [], [new(StoreTable.Download, id, download.Version, null)], ct);
            reasons.Remove(id);
            await engine.SaveDevStateAsync(ct);
            return new { removed = true };
        }
        finally { gate.Release(); }
    }

    private static async Task CommitAsync(IStore store, ImmutableArray<RowWrite> writes, ImmutableArray<RowDelete> deletes,
        CancellationToken ct, StoreOwner owner = StoreOwner.Targets)
    {
        var key = Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        var receipt = new AttemptRow($"commit:filing:{key}", null, null, null, null, AttemptKind.LegacyEvent,
            now, now, "applied", "filing", null, null, null, null, null, null, null);
        if (!(await store.CommitAsync(new(key, owner, writes.Add(new(receipt, null, null)), deletes), ct)).Applied)
            throw new InvalidOperationException("The download changed. Retry the action.");
    }

    internal sealed record Input(string Magnet, string? TorrentUri, PlacementInput Placement);
}

internal sealed class DevFilingHost(DevFiling filing, IHostEnvironment environment, ILogger<DevFilingHost> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!environment.IsDevelopment()) return;
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
                try { await filing.TickAsync(stoppingToken); }
                catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
                { logger.LogWarning(ex, "Filing waits for the next tick."); }
        }

        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }

}

internal sealed class FilingFileState(IServiceScopeFactory scopes) : IEngineFileState
{
    public async Task<ImmutableArray<EngineRecoveryFiles>> ReadAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
        return await DownloadFiling.RecoveryAsync(repository, ct);
    }
}
