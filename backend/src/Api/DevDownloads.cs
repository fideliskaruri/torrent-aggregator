using System.Collections.Immutable;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Store;

namespace TorrentFlow.Api;

// Isolated phase-4 proof composition. Library/Targets replace this harness in phase 5.
internal sealed class DevDownloads(MonoTorrentEngine engine, IServiceScopeFactory scopes)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
        { Converters = { new JsonStringEnumConverter() } };
    private static readonly string Prefix = "dev-download:";
    private readonly List<EngineEvent> events = [];

    internal static void Map(WebApplication app)
    {
        if (!app.Environment.IsDevelopment()) return;
        var group = app.MapGroup("/api/dev/downloads").AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var actor = AccessIdentity.Actor(http);
            if (actor.Role != UserRole.Owner || !actor.TrustedLocal ||
                http.Connection.RemoteIpAddress is not { } ip || !IPAddress.IsLoopback(ip))
                return Results.StatusCode(403);
            try { return await next(context); }
            catch (Exception ex) when (ex is ArgumentException or FormatException or InvalidDataException)
            { return Results.BadRequest(new { error = "invalid_input", message = ex.Message }); }
            catch (InvalidOperationException ex)
            { return Results.Conflict(new { error = "download_conflict", message = ex.Message }); }
            catch (IOException ex)
            { return Results.Conflict(new { error = "file_busy", message = ex.Message }); }
        });
        group.MapGet("/", async (DevDownloads proof, CancellationToken ct) =>
            Results.Json(await proof.ReadAsync(ct), Json));
        group.MapPost("/", async (Input input, DevDownloads proof, CancellationToken ct) =>
            Results.Json(await proof.AddAsync(input, ct), Json));
        group.MapPut("/settings", async (SettingsInput input, DevDownloads proof, CancellationToken ct) =>
            Results.Json(await proof.SettingsAsync(input, ct), Json));
        group.MapPut("/{hash}/order", async (string hash, OrderInput input, DevDownloads proof, CancellationToken ct) =>
            Results.Json(await proof.OrderAsync(MonoTorrentEngine.NormalizeHash(hash), input, ct), Json));
        group.MapDelete("/{hash}", async (string hash, bool? data, DevDownloads proof, CancellationToken ct) =>
            Results.Json(await proof.RemoveAsync(MonoTorrentEngine.NormalizeHash(hash), data == true, ct), Json));
    }

    internal async Task<object> ReadAsync(CancellationToken ct)
    {
        await TickAsync(ct);
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            return new
            {
                rows = (await AccessState.AllAsync<DownloadRow>(store, ct)).Where(d => d.Id.StartsWith(Prefix)).ToArray(),
                intents = (await AccessState.AllAsync<RawIntentRow>(store, ct)).Where(d => d.Id.StartsWith(Prefix)).ToArray(),
                live = await engine.SnapshotAsync(ct),
                managers = await engine.DiagnosticsAsync(ct),
                events = events.ToArray(),
            };
        }
        finally { gate.Release(); }
    }

    internal async Task<EngineResult> AddAsync(Input input, CancellationToken ct)
    {
        var magnet = input.Magnet ?? input.Hash ?? throw new ArgumentException("Provide a hash or magnet.");
        var hash = MonoTorrentEngine.NormalizeHash(magnet);
        if (!Path.IsPathFullyQualified(input.SavePath) || input.Files is not { Length: > 0 } || input.Files.Any(i => i < 0) ||
            input.Files.Distinct().Count() != input.Files.Length)
            throw new ArgumentException("Provide an absolute destination and distinct selected file indices.");
        SafePath(input.SavePath);
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var existing = (await AccessState.AllAsync<DownloadRow>(store, ct)).SingleOrDefault(d => d.Hash == hash);
            if (existing is not null)
                return new(true, (await engine.SnapshotAsync(ct)).SingleOrDefault(s => s.DownloadId == existing.Id), null);
            var xs = magnet.Split('&').FirstOrDefault(p => p.StartsWith("xs=", StringComparison.Ordinal));
            var candidate = MonoTorrentEngine.CandidateFor(magnet,
                input.TorrentUri ?? (xs is null ? null : Uri.UnescapeDataString(xs[3..])));
            ProbeHandle? handle = input.ProbeToken is null ? null : await engine.FindProbeAsync(input.ProbeToken, ct);
            if (input.ProbeToken is not null && handle is null)
                throw new InvalidOperationException("The retained metadata capability expired.");
            var metadata = await engine.MetadataAsync(hash, ct);
            var token = Guid.NewGuid().ToString("N");
            try
            {
                if (handle is not null || candidate.Release.TorrentUri is not null)
                {
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    deadline.CancelAfter(TimeSpan.FromSeconds(30));
                    if (handle is null)
                    {
                        var attachment = await engine.AttachProbeAsync(candidate, deadline.Token);
                        handle = attachment.Handle ?? throw new InvalidOperationException(attachment.Failure?.Message);
                    }
                    metadata = await engine.WaitMetadataAsync(handle, deadline.Token);
                }
                var bindings = metadata is { } files ? Bindings(hash, input.SavePath, files, input.Files) : [];
                var id = Prefix + hash;
                var claim = await engine.ClaimAdmissionAsync(new(token, hash, id, handle, DateTimeOffset.UtcNow.AddSeconds(90)), ct);
                if (!claim.Accepted) return claim;
                var now = DateTimeOffset.UtcNow;
                var release = candidate.Release with { Files = metadata, TotalBytes = metadata?.Sum(f => f.Bytes) };
                var findStore = scope.ServiceProvider.GetRequiredKeyedService<IStore>("find");
                var oldRelease = (await findStore.ReadAsync<ReleaseRow>(AccessState.Query(hash), ct)).SingleOrDefault();
                await CommitAsync(findStore, StoreOwner.Find, [new(release, null, oldRelease)], [], ct);
                var raw = new RawIntentRow(id, "local", hash, null, [.. input.Files], null,
                    Path.GetFullPath(input.SavePath), null, input.Paused ? RawDownloadState.Paused : RawDownloadState.Fetching,
                    null, null, null, null, input.Now ? now : null, true, input.Rank, null, null, token, now, now, 1);
                await CommitAsync(store, StoreOwner.Targets, [new(raw, null, null)], [], ct);
                var download = new DownloadRow(id, hash, input.Paused ? DownloadIntent.Paused : DownloadIntent.Run,
                    null, now, null, token, null, id, 1);
                await CommitAsync(store, StoreOwner.Targets, [new(download, null, null)], [], ct);
                await CommitAsync(store, StoreOwner.Targets, [new(raw with { DownloadId = id, Version = 2 }, 1, null)], [], ct);
                await engine.ApplyQueueAsync(new([])
                {
                    Order = [new(id, input.Rank, input.Priority, input.Now, !input.Paused)],
                }, ct);
                var admission = new EngineAdmission(download, candidate, bindings, token);
                var result = handle is null ? await engine.StartAsync(admission, ct)
                    : await engine.AdmitFromProbeAsync(handle, admission, ct);
                if (!result.Accepted) throw new InvalidOperationException(result.Failure?.Message);
                await engine.SaveDevStateAsync(ct);
                return result;
            }
            finally
            {
                await engine.ReleaseAdmissionClaimAsync(token, CancellationToken.None);
                if (handle is not null) await engine.ReleaseProbeAsync(handle, CancellationToken.None);
            }
        }
        finally { gate.Release(); }
    }

    internal async Task RecoverAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var raws = (await AccessState.AllAsync<RawIntentRow>(store, ct)).Where(r => r.Id.StartsWith(Prefix)).ToArray();
            var rows = (await AccessState.AllAsync<DownloadRow>(store, ct)).Where(r => r.Id.StartsWith(Prefix)).ToArray();
            var live = await engine.SnapshotAsync(ct);
            foreach (var row in rows.Where(r => r.FinishedAt is null && live.All(s => s.Hash != r.Hash)))
            {
                var raw = raws.Single(r => r.Id == row.RawIntentId);
                var release = (await store.ReadAsync<ReleaseRow>(AccessState.Query(row.Hash), ct)).Single();
                var bindings = release.Files is { } files ? Bindings(row.Hash, raw.ExplicitDirectory!, files,
                    raw.SelectedFiles.ToArray(), recovery: true) : [];
                await engine.ClaimAdmissionAsync(new(row.AdmissionToken, row.Hash, row.Id, null,
                    DateTimeOffset.UtcNow.AddSeconds(90)), ct);
                await engine.StartAsync(new(row with { Intent = DownloadIntent.Paused },
                    MonoTorrentEngine.CandidateFor(release.Magnet ?? row.Hash, release.TorrentUri), bindings, row.AdmissionToken), ct);
            }
            await ApplyOrderAsync(raws, ct);
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
            var rawRows = (await AccessState.AllAsync<RawIntentRow>(store, ct)).Where(r => r.Id.StartsWith(Prefix)).ToArray();
            if (rawRows.Length == 0) return;
            foreach (var snapshot in await engine.SnapshotAsync(ct))
            {
                var raw = rawRows.SingleOrDefault(r => r.Id == snapshot.DownloadId);
                if (raw is null) continue;
                var row = (await store.ReadAsync<DownloadRow>(AccessState.Query(snapshot.DownloadId), ct)).Single();
                if (snapshot.MetadataAvailable && snapshot.Files.All(f => !f.Selected) && row.FinishedAt is null &&
                    await engine.MetadataAsync(snapshot.Hash, ct) is { } metadata)
                {
                    await engine.SelectAsync(snapshot.DownloadId, Bindings(snapshot.Hash, raw.ExplicitDirectory!,
                        metadata, raw.SelectedFiles.ToArray()), ct);
                    var findStore = scope.ServiceProvider.GetRequiredKeyedService<IStore>("find");
                    var oldRelease = (await findStore.ReadAsync<ReleaseRow>(AccessState.Query(snapshot.Hash), ct)).Single();
                    await CommitAsync(findStore, StoreOwner.Find, [new(oldRelease with
                    {
                        Files = metadata, TotalBytes = metadata.Sum(f => f.Bytes),
                    }, null, oldRelease)], [], ct);
                }
                var nextIntent = snapshot.Complete ? DownloadIntent.Stopped :
                    raw.State == RawDownloadState.Paused ? DownloadIntent.Paused :
                    snapshot.Active ? DownloadIntent.Run : DownloadIntent.Queued;
                if (row.Intent != nextIntent || snapshot.Complete && row.FinishedAt is null)
                {
                    var next = row with { Intent = nextIntent, FinishedAt = snapshot.Complete ? DateTimeOffset.UtcNow : null,
                        Version = row.Version + 1 };
                    await CommitAsync(store, StoreOwner.Targets, [new(next, row.Version, null)], [], ct);
                }
                if (snapshot.Complete && raw.State != RawDownloadState.Done)
                {
                    await PublishAsync(snapshot, raw.ExplicitDirectory!, ct);
                    await CommitAsync(store, StoreOwner.Targets, [new(raw with
                    {
                        State = RawDownloadState.Done, UpdatedAt = DateTimeOffset.UtcNow, Version = raw.Version + 1,
                    }, raw.Version, null)], [], ct);
                }
            }
            events.AddRange(await engine.ReadEventsAsync(ct));
            if (events.Count > 500) events.RemoveRange(0, events.Count - 500);
        }
        finally { gate.Release(); }
    }

    private async Task PublishAsync(EngineSnapshot snapshot, string root, CancellationToken ct)
    {
        var final = snapshot.Files.Where(f => f.Selected).Select(f => new FileBinding(f.Index,
            f.PhysicalPath![..^".partial".Length], false)).ToImmutableArray();
        var permit = await engine.PrepareFilingAsync(new(Guid.NewGuid().ToString("N"), snapshot.DownloadId, final), ct);
        if (permit.Failure is not null) throw new InvalidOperationException(permit.Failure.Message);
        foreach (var file in snapshot.Files)
        {
            SafePath(file.PhysicalPath!);
            if (file.Selected)
            {
                var path = file.PhysicalPath![..^".partial".Length];
                if (File.Exists(file.PhysicalPath)) File.Move(file.PhysicalPath, path, false);
                else if (!File.Exists(path)) throw new IOException("A completed file is missing.");
            }
            else if (File.Exists(file.PhysicalPath)) File.Delete(file.PhysicalPath!);
        }
        PruneUnwanted(root, snapshot.Hash);
        await engine.CompleteFilingAsync(permit, true, ct);
        await engine.SaveDevStateAsync(ct);
    }

    internal async Task<object> SettingsAsync(SettingsInput input, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var old = (await store.ReadAsync<SettingRow>(AccessState.Query("engine"), ct)).Single();
            var value = SettingsCatalog.Read<EngineSettings>(old);
            value = value with { MaxActiveDownloads = input.Cap ?? value.MaxActiveDownloads,
                MetadataStallSeconds = input.MetadataStallSeconds ?? value.MetadataStallSeconds,
                ProgressStallSeconds = input.ProgressStallSeconds ?? value.ProgressStallSeconds,
                ProgressStallBytes = input.ProgressStallBytes ?? value.ProgressStallBytes };
            var next = old with { Value = JsonSerializer.SerializeToElement(value, Json),
                Revision = old.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
            if (value.MaxActiveDownloads is < 1 or > 20 || value.MetadataStallSeconds < 1 ||
                value.ProgressStallSeconds < 1 || value.ProgressStallBytes < 1)
                throw new ArgumentException("The cap must be 1..20 and stall thresholds must be positive.");
            await CommitAsync(store, StoreOwner.Targets, [new(next, old.Revision, null)], [], ct);
            await engine.UpdateSettingsAsync(value, ct);
            if (input.DownloadBytesPerSecond is { } rate) await engine.LimitDevRateAsync(rate, ct);
            await engine.SaveDevStateAsync(ct);
            return new { settings = value, live = await engine.SnapshotAsync(ct) };
        }
        finally { gate.Release(); }
    }

    internal async Task<object> OrderAsync(string hash, OrderInput input, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var old = (await store.ReadAsync<RawIntentRow>(AccessState.Query(Prefix + hash), ct)).Single();
            var next = old with { Rank = input.Rank ?? old.Rank, NowAt = input.Now is { } now
                ? now ? DateTimeOffset.UtcNow : null : old.NowAt,
                State = input.Paused is { } paused ? paused ? RawDownloadState.Paused : RawDownloadState.Fetching : old.State,
                UpdatedAt = DateTimeOffset.UtcNow, Version = old.Version + 1 };
            await CommitAsync(store, StoreOwner.Targets, [new(next, old.Version, null)], [], ct);
            await ApplyOrderAsync((await AccessState.AllAsync<RawIntentRow>(store, ct))
                .Where(r => r.Id.StartsWith(Prefix)).ToArray(), ct);
            await engine.SaveDevStateAsync(ct);
            return new { live = await engine.SnapshotAsync(ct) };
        }
        finally { gate.Release(); }
    }

    private Task ApplyOrderAsync(RawIntentRow[] rows, CancellationToken ct) => engine.ApplyQueueAsync(new(
        [.. rows.Select(r => new QueueAdmission(r.Id, r.State is not (RawDownloadState.Paused or RawDownloadState.Done)))])
    {
        Order = [.. rows.Select(r => new EngineQueueOrder(r.Id, r.Rank, TargetPriority.OwnerRank,
            r.NowAt is not null, r.State is not (RawDownloadState.Paused or RawDownloadState.Done)))],
    }, ct);

    internal async Task<object> RemoveAsync(string hash, bool data, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var raw = (await store.ReadAsync<RawIntentRow>(AccessState.Query(Prefix + hash), ct)).SingleOrDefault();
            if (raw is null) return new { removed = true, files = 0 };
            var paths = await engine.RemoveDevAsync(hash, ct);
            if (data)
            {
                var release = (await store.ReadAsync<ReleaseRow>(AccessState.Query(hash), ct)).Single();
                if (release.Files is { } metadata)
                    paths = Bindings(hash, raw.ExplicitDirectory!, metadata, raw.SelectedFiles.ToArray(), true)
                        .SelectMany(b => b.Selected ? new[] { b.AbsolutePath, b.AbsolutePath[..^".partial".Length] }
                            : [b.AbsolutePath]).ToImmutableArray();
                foreach (var path in paths) { SafePath(path); if (File.Exists(path)) File.Delete(path); }
                PruneUnwanted(raw.ExplicitDirectory!, hash);
                var unwanted = Path.Combine(raw.ExplicitDirectory!, ".unwanted");
                if (Directory.Exists(unwanted) && Directory.EnumerateFileSystemEntries(unwanted)
                    .All(p => Path.GetFileName(p) == ".ignore"))
                {
                    File.Delete(Path.Combine(unwanted, ".ignore"));
                    Directory.Delete(unwanted);
                }
            }
            var row = (await store.ReadAsync<DownloadRow>(AccessState.Query(raw.DownloadId), ct)).Single();
            await CommitAsync(store, StoreOwner.Targets,
                [new(raw with { DownloadId = null, Version = raw.Version + 1 }, raw.Version, null)], [], ct);
            await CommitAsync(store, StoreOwner.Targets, [], [new(StoreTable.Download, row.Id, row.Version, null)], ct);
            await CommitAsync(store, StoreOwner.Targets, [], [new(StoreTable.RawIntent, raw.Id, raw.Version + 1, null)], ct);
            await engine.SaveDevStateAsync(ct);
            return new { removed = true, files = paths.Length };
        }
        finally { gate.Release(); }
    }

    private static ImmutableArray<FileBinding> Bindings(string hash, string root, ImmutableArray<TorrentFile> files,
        int[] selected, bool recovery = false)
    {
        if (selected.Any(i => files.All(f => f.Index != i))) throw new ArgumentException("A selected file index does not exist.");
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return [.. files.Select(f =>
        {
            var keep = selected.Contains(f.Index);
            var path = Path.GetFullPath(Path.Combine(fullRoot, keep ? "" : $".unwanted\\{hash}\\{f.Index}", f.RelativePath));
            if (!path.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("A torrent file escapes the destination.");
            SafePath(path);
            if (!recovery && (File.Exists(path) || File.Exists(path + ".partial")))
                throw new ArgumentException("A destination file already exists. Choose an empty folder.");
            return new FileBinding(f.Index, path + ".partial", keep);
        })];
    }

    private static void SafePath(string path)
    {
        for (var current = path; current is not null; current = Path.GetDirectoryName(current))
            if ((File.Exists(current) || Directory.Exists(current)) &&
                (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("Download paths cannot traverse links or junctions.");
    }

    private static void PruneUnwanted(string root, string hash)
    {
        var unwanted = Path.Combine(root, ".unwanted", hash);
        SafePath(unwanted);
        if (Directory.Exists(unwanted))
        {
            Prune(unwanted);
        }
        static void Prune(string path)
        {
            SafePath(path);
            foreach (var child in Directory.EnumerateDirectories(path)) Prune(child);
            if (!Directory.EnumerateFileSystemEntries(path).Any()) Directory.Delete(path);
        }
    }

    private static async Task CommitAsync(IStore store, StoreOwner owner, ImmutableArray<RowWrite> writes,
        ImmutableArray<RowDelete> deletes, CancellationToken ct)
    {
        var key = Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        var receipt = new AttemptRow($"commit:dev-download:{key}", null, null, null, null, AttemptKind.LegacyEvent,
            now, now, "applied", "dev-download", null, null, null, null, null, null, null);
        if (!(await store.CommitAsync(new(key, owner, writes.Add(new(receipt, null, null)), deletes), ct)).Applied)
            throw new InvalidOperationException("The download changed during this operation. Retry the action.");
    }

    internal sealed record Input(string SavePath, int[] Files, string? Magnet = null, string? Hash = null,
        string? TorrentUri = null, string? ProbeToken = null, long Rank = 0,
        TargetPriority Priority = TargetPriority.OwnerRank, bool Now = false, bool Paused = false);
    internal sealed record OrderInput(long? Rank = null, bool? Now = null, bool? Paused = null);
    internal sealed record SettingsInput(int? Cap = null, int? MetadataStallSeconds = null,
        int? ProgressStallSeconds = null, long? ProgressStallBytes = null, int? DownloadBytesPerSecond = null);
}

internal static class DevDownloadsEndpoints
{
    internal static void MapDevDownloads(this WebApplication app) => DevDownloads.Map(app);
}
