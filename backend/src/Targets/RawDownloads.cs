using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Store;
using TorrentFlow.Library;
using Microsoft.Extensions.DependencyInjection;
using static TorrentFlow.Library.RawDownloadFiles;

namespace TorrentFlow.Targets;

public sealed class RawDownloads(MonoTorrentEngine engine, IServiceScopeFactory scopes)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
        { Converters = { new JsonStringEnumConverter() } };
    private static readonly string Prefix = "dev-download:";
    private readonly List<EngineEvent> events = [];

    public async Task<EngineResult> SendAsync(string? magnet, string? torrentUrl, string? name,
        string actor, bool now, CancellationToken ct)
    {
        var hash = string.IsNullOrWhiteSpace(magnet)
            ? await engine.ResolveTorrentSourceAsync(torrentUrl!, ct)
            : MonoTorrentEngine.NormalizeHash(magnet);
        await using var scope = scopes.CreateAsyncScope();
        var root = (await scope.ServiceProvider.GetRequiredService<ILibraryPlacement>().RootsAsync(ct))
            .Where(r => r.Enabled && r.Online && !r.ReviewRequired).OrderBy(r => r.Priority).FirstOrDefault()
            ?? throw new InvalidOperationException("Add and confirm a download folder in Settings first.");
        var destination = RawDownloadFiles.Destination(root, hash);
        return await AddAsync(new(destination, [], Magnet: magnet ?? hash, TorrentUri: torrentUrl,
            Now: now, Actor: actor, Name: name), ct);
    }

    public async Task<object> ReadAsync(CancellationToken ct)
    {
        await TickAsync(ct);
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            return new
            {
                rows = (await store.ListAsync<DownloadRow>(null, ct)).Where(d => d.Id.StartsWith(Prefix)).ToArray(),
                intents = (await store.ListAsync<RawIntentRow>(null, ct)).Where(d => d.Id.StartsWith(Prefix)).ToArray(),
                live = await engine.SnapshotAsync(ct),
                managers = await engine.DiagnosticsAsync(ct),
                events = events.ToArray(),
            };
        }
        finally { gate.Release(); }
    }

    public async Task<EngineResult> AddAsync(Input input, CancellationToken ct)
    {
        var magnet = input.Magnet ?? input.Hash ?? throw new ArgumentException("Provide a hash or magnet.");
        var hash = MonoTorrentEngine.NormalizeHash(magnet);
        if (!Path.IsPathFullyQualified(input.SavePath) || input.Files.Any(i => i < 0) ||
            input.Files.Distinct().Count() != input.Files.Length)
            throw new ArgumentException("Provide an absolute destination and distinct selected file indices.");
        SafePath(input.SavePath);
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var existing = (await store.ListAsync<DownloadRow>(row => row.Hash == hash, ct)).SingleOrDefault();
            if (existing is not null)
                return new(true, (await engine.SnapshotAsync(ct)).SingleOrDefault(s => s.DownloadId == existing.Id), null);
            var xs = magnet.Split('&').FirstOrDefault(p => p.StartsWith("xs=", StringComparison.Ordinal));
            var candidate = MonoTorrentEngine.CandidateFor(magnet,
                input.TorrentUri ?? (xs is null ? null : Uri.UnescapeDataString(xs[3..])));
            ProbeHandle? handle = input.ProbeToken is null ? null : await engine.FindProbeAsync(input.ProbeToken, ct);
            if (input.ProbeToken is not null && handle is null)
                throw new InvalidOperationException("The retained metadata capability expired.");
            var metadata = await engine.MetadataAsync(hash, ct);
            if (metadata is null && Directory.Exists(input.SavePath) &&
                Directory.EnumerateFileSystemEntries(input.SavePath).Any())
                throw new ArgumentException("Choose an empty folder for this torrent.");
            var token = Guid.NewGuid().ToString("N");
            var id = Prefix + hash;
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
                var claim = await engine.ClaimAdmissionAsync(new(token, hash, id, handle, DateTimeOffset.UtcNow.AddSeconds(90)), ct);
                if (!claim.Accepted) return claim;
                var now = DateTimeOffset.UtcNow;
                var release = candidate.Release with { Name = input.Name ?? candidate.Release.Name,
                    Files = metadata, TotalBytes = metadata?.Sum(f => f.Bytes) };
                var findStore = scope.ServiceProvider.GetRequiredService<TargetStore>();
                await CommitAsync(findStore, [new(release, null, null)], [], ct);
                var raw = new RawIntentRow { Id = id, ActorUserId = input.Actor, ReleaseHash = hash, DownloadId = null, SelectedFiles = [.. input.Files], RootId = null, ExplicitDirectory = Path.GetFullPath(input.SavePath), ExplicitKind = null, State = input.Paused ? RawDownloadState.Paused : RawDownloadState.Fetching, ResumeState = null, ReasonCode = null, ReasonText = null, NextTryAt = null, NowAt = input.Now ? now : null, OwnerRanked = false, Rank = 0, LeaseUntil = null, LeaseToken = null, BatchId = token, CreatedAt = now, UpdatedAt = now, Version = 1 };
                await CommitAsync(store, [new(raw, null, null)], [], ct);
                var download = new DownloadRow { Id = id, Hash = hash, Intent = input.Paused ? DownloadIntent.Paused : DownloadIntent.Run, RootId = null, AddedAt = now, FinishedAt = null, AdmissionToken = token, ResumeArtifact = null, RawIntentId = id, Version = 1 };
                await CommitAsync(store, [new(download, null, null)], [], ct);
                await CommitAsync(store, [new(raw with { DownloadId = id, Version = 2 }, 1, null)], [], ct);
                await engine.ApplyQueueAsync(new([])
                {
                    Order = [new(id, 0, input.Now ? TargetPriority.Now : TargetPriority.BackCatalogue,
                        input.Now, !input.Paused)],
                }, ct);
                var admission = new EngineAdmission(download, candidate, bindings, token);
                var result = handle is null ? await engine.StartAsync(admission, ct)
                    : await engine.AdmitFromProbeAsync(handle, admission, ct);
                if (!result.Accepted) throw new InvalidOperationException(result.Failure?.Message);
                await engine.SaveDevStateAsync(ct);
                return result;
            }
            catch
            {
                await engine.StopAndReleaseFilesAsync(id, CancellationToken.None);
                var persisted = (await store.ListAsync<RawIntentRow>(row => row.Id == id, CancellationToken.None)).SingleOrDefault();
                if (persisted is not null)
                {
                    if (persisted.DownloadId is not null)
                    {
                        await CommitAsync(store, [new(persisted with
                            { DownloadId = null, Version = persisted.Version + 1 }, persisted.Version, null)], [], CancellationToken.None);
                        var download = (await store.ListAsync<DownloadRow>(row => row.Id == id, CancellationToken.None)).SingleOrDefault();
                        if (download is not null)
                            await CommitAsync(store, [], [new(StoreTable.Download,
                                id, download.Version, null)], CancellationToken.None);
                        persisted = persisted with { Version = persisted.Version + 1 };
                    }
                    await CommitAsync(store, [], [new(StoreTable.RawIntent,
                        id, persisted.Version, null)], CancellationToken.None);
                }
                await engine.DeleteTorrentAsync(id, CancellationToken.None);
                throw;
            }
            finally
            {
                await engine.ReleaseAdmissionClaimAsync(token, CancellationToken.None);
                if (handle is not null) await engine.ReleaseProbeAsync(handle, CancellationToken.None);
            }
        }
        finally { gate.Release(); }
    }

    public async Task RecoverAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var raws = (await store.ListAsync<RawIntentRow>(null, ct)).Where(r => r.Id.StartsWith(Prefix)).ToArray();
            var rows = (await store.ListAsync<DownloadRow>(null, ct)).Where(r => r.Id.StartsWith(Prefix)).ToArray();
            var live = await engine.SnapshotAsync(ct);
            foreach (var row in rows.Where(r => r.FinishedAt is null && live.All(s => s.Hash != r.Hash)))
            {
                var raw = raws.Single(r => r.Id == row.RawIntentId);
                var release = (await store.ListAsync<ReleaseRow>(r => r.Id == row.Hash, ct)).Single();
                var bindings = await engine.MetadataAsync(row.Hash, ct) is { } files ? Bindings(row.Hash, raw.ExplicitDirectory!, files,
                    raw.SelectedFiles.ToArray(), recovery: true) : [];
                await engine.ClaimAdmissionAsync(new(row.AdmissionToken, row.Hash, row.Id, null,
                    DateTimeOffset.UtcNow.AddSeconds(90)), ct);
                await engine.StartAsync(new(row with { Intent = DownloadIntent.Paused },
                    MonoTorrentEngine.CandidateFor(release.Magnet ?? row.Hash, release.TorrentUri), bindings, row.AdmissionToken), ct);
            }
            await ApplyOrderAsync(raws, ct);
            foreach (var raw in raws.Where(r => r.DownloadId is not null && r.State != RawDownloadState.Done))
                await engine.SetIntentAsync(raw.DownloadId!, raw.State != RawDownloadState.Paused, ct);
        }
        finally { gate.Release(); }
    }

    public async Task TickAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var rawRows = (await store.ListAsync<RawIntentRow>(null, ct)).Where(r => r.Id.StartsWith(Prefix)).ToArray();
            if (rawRows.Length == 0) return;
            foreach (var snapshot in await engine.SnapshotAsync(ct))
            {
                var raw = rawRows.SingleOrDefault(r => r.Id == snapshot.DownloadId);
                if (raw is null) continue;
                var row = (await store.ListAsync<DownloadRow>(d => d.Id == snapshot.DownloadId, ct)).Single();
                if (snapshot.MetadataAvailable && snapshot.Files.All(f => !f.Selected) && row.FinishedAt is null &&
                    await engine.MetadataAsync(snapshot.Hash, ct) is { } metadata)
                {
                    await engine.SelectAsync(snapshot.DownloadId, Bindings(snapshot.Hash, raw.ExplicitDirectory!,
                        metadata, raw.SelectedFiles.ToArray(), recovery: true), ct);
                    var findStore = scope.ServiceProvider.GetRequiredService<TargetStore>();
                    var oldRelease = (await findStore.ListAsync<ReleaseRow>(r => r.Id == snapshot.Hash, ct)).Single();
                    await CommitAsync(findStore, [new(oldRelease with
                    {
                        Files = metadata, TotalBytes = metadata.Sum(f => f.Bytes),
                    }, null, oldRelease)], [], ct);
                }
                if (snapshot.Complete && raw.State != RawDownloadState.Done)
                {
                    await PublishAsync(snapshot, raw.ExplicitDirectory!, ct);
                    await CommitAsync(store, [new(raw with
                    {
                        State = RawDownloadState.Done, UpdatedAt = DateTimeOffset.UtcNow, Version = raw.Version + 1,
                    }, raw.Version, null)], [], ct);
                }
                var nextIntent = snapshot.Complete ? DownloadIntent.Stopped :
                    raw.State == RawDownloadState.Paused ? DownloadIntent.Paused :
                    snapshot.Active ? DownloadIntent.Run : DownloadIntent.Queued;
                if (row.Intent != nextIntent || snapshot.Complete && row.FinishedAt is null)
                {
                    var next = row with { Intent = nextIntent, FinishedAt = snapshot.Complete ? DateTimeOffset.UtcNow : null,
                        Version = row.Version + 1 };
                    await CommitAsync(store, [new(next, row.Version, null)], [], ct);
                }
            }
            events.AddRange(await engine.ReadEventsAsync(ct));
            if (events.Count > 500) events.RemoveRange(0, events.Count - 500);
        }
        finally { gate.Release(); }
    }

    private async Task PublishAsync(EngineSnapshot snapshot, string root, CancellationToken ct)
    {
        var stopped = await engine.StopAndReleaseFilesAsync(snapshot.DownloadId, ct);
        if (!stopped.WritesDrained || stopped.Failure is not null)
            throw new IOException(stopped.Failure?.Message ?? "The download could not stop writing.");
        RawDownloadFiles.CompletePublication(snapshot, root);
        await engine.SaveDevStateAsync(ct);
    }

    public async Task<object> SettingsAsync(SettingsInput input, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var old = (await store.ListAsync<SettingRow>(setting => setting.Id == "engine", ct)).Single();
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
            await CommitAsync(store, [new(next, old.Revision, null)], [], ct);
            await engine.UpdateSettingsAsync(value, ct);
            if (input.DownloadBytesPerSecond is { } rate) await engine.LimitDevRateAsync(rate, ct);
            await engine.SaveDevStateAsync(ct);
            return new { settings = value, live = await engine.SnapshotAsync(ct) };
        }
        finally { gate.Release(); }
    }

    public async Task<object> OrderAsync(string hash, OrderInput input, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var old = (await store.ListAsync<RawIntentRow>(row => row.Id == Prefix + hash, ct)).Single();
            var next = old with { NowAt = input.Now is { } now
                ? now ? DateTimeOffset.UtcNow : null : old.NowAt,
                State = input.Paused is { } paused ? paused ? RawDownloadState.Paused : RawDownloadState.Fetching : old.State,
                UpdatedAt = DateTimeOffset.UtcNow, Version = old.Version + 1 };
            await CommitAsync(store, [new(next, old.Version, null)], [], ct);
            await ApplyOrderAsync((await store.ListAsync<RawIntentRow>(null, ct))
                .Where(r => r.Id.StartsWith(Prefix)).ToArray(), ct);
            if (next.DownloadId is not null)
                await engine.SetIntentAsync(next.DownloadId, next.State != RawDownloadState.Paused, ct);
            await engine.SaveDevStateAsync(ct);
            return new { live = await engine.SnapshotAsync(ct) };
        }
        finally { gate.Release(); }
    }

    private Task ApplyOrderAsync(RawIntentRow[] rows, CancellationToken ct)
    {
        var ordered = rows.OrderBy(r => r.NowAt is null).ThenBy(r => r.NowAt ?? r.CreatedAt)
            .ThenBy(r => r.CreatedAt).ThenBy(r => r.Id, StringComparer.Ordinal).ToArray();
        return engine.ApplyQueueAsync(new(
            [.. ordered.Select(r => new QueueAdmission(r.Id, r.State is not (RawDownloadState.Paused or RawDownloadState.Done)))])
        {
            Order = [.. ordered.Select((r, index) => new EngineQueueOrder(r.Id, index,
                r.NowAt is not null ? TargetPriority.Now : TargetPriority.BackCatalogue,
                r.NowAt is not null, r.State is not (RawDownloadState.Paused or RawDownloadState.Done)))],
        }, ct);
    }

    public async Task<object> RemoveAsync(string hash, bool data, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var raw = (await store.ListAsync<RawIntentRow>(row => row.Id == Prefix + hash, ct)).SingleOrDefault();
            if (raw is null) return new { removed = true, files = 0 };
            var paths = await engine.RemoveDevAsync(hash, ct);
            if (data)
            {
                var release = (await store.ListAsync<ReleaseRow>(row => row.Id == hash, ct)).Single();
                if (release.Files is { } metadata)
                    paths = Bindings(hash, raw.ExplicitDirectory!, metadata, raw.SelectedFiles.ToArray(), true)
                        .SelectMany(b => b.Selected ? new[] { b.AbsolutePath, b.AbsolutePath[..^".partial".Length] }
                            : [b.AbsolutePath]).ToImmutableArray();
                RawDownloadFiles.DeletePayload(raw.ExplicitDirectory!, hash, paths);
            }
            var row = (await store.ListAsync<DownloadRow>(download => download.Id == raw.DownloadId, ct)).Single();
            await CommitAsync(store,
                [new(raw with { DownloadId = null, Version = raw.Version + 1 }, raw.Version, null)], [], ct);
            await CommitAsync(store, [], [new(StoreTable.Download, row.Id, row.Version, null)], ct);
            await CommitAsync(store, [], [new(StoreTable.RawIntent, raw.Id, raw.Version + 1, null)], ct);
            await engine.DeleteTorrentAsync(row.Id, ct);
            await engine.SaveDevStateAsync(ct);
            return new { removed = true, files = paths.Length };
        }
        finally { gate.Release(); }
    }

    private static async Task CommitAsync(TargetStore store, IEnumerable<RowWrite> writes,
        IEnumerable<RowDelete> deletes, CancellationToken ct)
    {
        if (!await store.SaveAsync(writes, deletes, ct))
            throw new InvalidOperationException("The download changed during this operation. Retry the action.");
    }

    public sealed record Input(string SavePath, int[] Files, string? Magnet = null, string? Hash = null,
        string? TorrentUri = null, string? ProbeToken = null, bool Now = false, bool Paused = false,
        string Actor = "local", string? Name = null);
    public sealed record OrderInput(bool? Now = null, bool? Paused = null);
    public sealed record SettingsInput(int? Cap = null, int? MetadataStallSeconds = null,
        int? ProgressStallSeconds = null, long? ProgressStallBytes = null, int? DownloadBytesPerSecond = null);
}
