using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Library;

namespace TorrentFlow.Targets;

internal sealed partial class TargetTransfers
{
    internal async Task<bool> SwapAsync(WorkSnapshot work, ImmutableArray<TargetRow> targets,
        DownloadRow old, Assignment assignment, Candidate candidate, ImmutableArray<TorrentFile> metadata,
        ProbeHandle? handle, string? stall, SemaphoreSlim stateGate, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        var token = Guid.NewGuid().ToString("N");
        var id = Prefix + assignment.Hash;
        var committed = false;
        var inserted = false;
        ImmutableArray<DownloadFileRow> files = [];
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var catalog = new CatalogState(store);
            var library = scope.ServiceProvider.GetRequiredService<ILibraryPlacement>();
            var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
            if ((await catalog.ReadAsync<DownloadRow>(CatalogState.Query(), ct)).Any(d => d.Hash == assignment.Hash))
                return false;
            var placement = await library.PlaceAsync(new(work, targets, assignment, metadata,
                await library.RootsAsync(ct), [], null, null, null), ct);
            if (placement.Failure is not null) return false;
            var root = (await library.RootsAsync(ct)).Single(r => r.Id == placement.RootId);
            var folder = LibraryPaths.Within(root.Path, placement.Folders.First().RelativeItemFolder!);
            files = DownloadFiling.BindUnwanted(id, assignment.Hash, folder, metadata, placement.Files);
            // Different releases can name the same final file. Never let a replacement
            // hash-check, truncate or delete the Current release's partial.
            files = [.. files.Select(f =>
            {
                var path = f.EnginePath! + "." + assignment.Hash;
                return f with { PartialPath = path, EnginePath = path, PhysicalKey = LibraryPaths.PhysicalKey(path) };
            })];
            var now = DateTimeOffset.UtcNow;
            var download = new DownloadRow(id, assignment.Hash, DownloadIntent.Run, root.Id, now, null, token, null, null, 1);
            if (!(await engine.ClaimAdmissionAsync(new(token, assignment.Hash, id, handle, now.AddSeconds(90))
                { SharedSlotDownloadId = old.Id }, ct)).Accepted)
                return false;
            await TargetPipeline.CommitAsync(store, [new(download, null, null),
                .. targets.Select(t => new RowWrite(new DownloadTargetRow($"{id}:{t.Id}", id, t.Id,
                    AssociationRole.Replacement, now), null, null))], [], ct);
            inserted = true;
            if (!await repository.SavePlacementAsync(files, placement.Folders, ct)) return false;
            await engine.ApplyQueueAsync(new([]) { Order = [new(id, targets.Min(t => t.Rank),
                targets.Min(t => t.Priority), false, true)] }, ct);
            var admission = new EngineAdmission(download, candidate,
                [.. files.Select(f => new FileBinding(f.FileIndex, f.EnginePath!, f.Selected))], token);
            var start = handle is null ? await engine.StartAsync(admission, ct) :
                await engine.AdmitFromProbeAsync(handle, admission, ct);
            if (!start.Accepted) return false;
            EngineSnapshot? proof = null;
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(90));
            while (!deadline.IsCancellationRequested)
            {
                var current = await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct);
                if (targets.Any(t => current.All(c => c.Id != t.Id || c.Version != t.Version ||
                    c.State != TargetState.Fetching || c.ChosenReleaseHash != old.Hash))) return false;
                var live = await engine.SnapshotAsync(ct);
                if (live.SingleOrDefault(l => l.DownloadId == old.Id)?.Complete == true) return false;
                proof = live.SingleOrDefault(l => l.DownloadId == id);
                if (proof is { MetadataAvailable: true } &&
                    (proof.Complete || proof.CompletedSelectedBytes >= Math.Min(64 * 1024, proof.SelectedBytes) &&
                        proof.SelectedBytes > 0)) break;
                try { await Task.Delay(250, deadline.Token); }
                catch (OperationCanceledException) when (deadline.IsCancellationRequested) { return false; }
            }
            if (proof is null || deadline.IsCancellationRequested) return false;
            await stateGate.WaitAsync(ct);
            try
            {
                var current = await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct);
                if (targets.Any(t => current.All(c => c.Id != t.Id || c.Version != t.Version ||
                    c.State != TargetState.Fetching || c.ChosenReleaseHash != old.Hash))) return false;
                var links = await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query(), ct);
                now = DateTimeOffset.UtcNow;
                var oldLive = (await engine.SnapshotAsync(ct)).SingleOrDefault(l => l.DownloadId == old.Id);
                await TargetPipeline.CommitAsync(store,
                    [.. targets.Select(t => new RowWrite(t with { ChosenReleaseHash = assignment.Hash,
                        ReasonCode = null, ReasonText = null, UpdatedAt = now, Version = t.Version + 1 }, t.Version, null)),
                     .. links.Where(l => targets.Any(t => t.Id == l.TargetId) &&
                         (l.DownloadId == old.Id || l.DownloadId == id)).Select(l => new RowWrite(l with
                         { Role = l.DownloadId == id ? AssociationRole.Current : AssociationRole.Retired }, null, l)),
                     new(new BlockRow(Guid.NewGuid().ToString("N"), old.Hash, work.Work.Id,
                         stall ?? "Owner chose another release", stall is null ? BlockOrigin.Swap : BlockOrigin.Stalled,
                         assignment.Hash, now, now.AddHours(6)), null, null),
                     new(new AttemptRow(Guid.NewGuid().ToString("N"), targets[0].Id, work.Work.Id, old.Hash,
                         targets[0].CreatedBy, AttemptKind.Swap, download.AddedAt, now, "Swapped", stall,
                         "Replacement delivered checked bytes before the current release was retired.", null, null,
                         targets[0].BatchId, id, null, new(old.Id, [id], [.. targets.Select(t => t.Id)],
                             oldLive?.CompletedSelectedBytes ?? 0, [], null, false)), null, null)], [], ct);
                committed = true;
            }
            finally { stateGate.Release(); }
            var remaining = await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query(), ct);
            if (!remaining.Any(l => l.DownloadId == old.Id && l.Role == AssociationRole.Current))
                await engine.DetachAsync(old.Id, ct);
            if (engine is MonoTorrentEngine concrete) await concrete.SaveDevStateAsync(ct);
            return true;
        }
        finally
        {
            try
            {
                await engine.ReleaseAdmissionClaimAsync(token, CancellationToken.None);
                if (handle is not null) await engine.ReleaseProbeAsync(handle, CancellationToken.None);
                if (!committed && inserted)
                {
                    await engine.DetachAsync(id, CancellationToken.None);
                    await using var scope = scopes.CreateAsyncScope();
                    var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
                    var catalog = new CatalogState(store);
                    var row = (await catalog.ReadAsync<DownloadRow>(CatalogState.Query(id), CancellationToken.None)).Single();
                    await CleanRetiredAsync(store,
                        (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>(),
                        row, files, await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query(), CancellationToken.None),
                        CancellationToken.None);
                }
            }
            finally { gate.Release(); }
        }
    }

    private static async Task CleanRetiredAsync(IStore store, ILibraryDownloadRepository repository,
        DownloadRow download, ImmutableArray<DownloadFileRow> files,
        ImmutableArray<DownloadTargetRow> links, CancellationToken ct)
    {
        foreach (var file in files.Where(f => !f.Filed && f.EnginePath is not null))
        {
            LibraryPaths.NoLinks(file.EnginePath!);
            if (File.Exists(file.EnginePath)) File.Delete(file.EnginePath);
        }
        if (!await repository.RemoveDownloadFilesAsync(download.Id, ct))
            throw new IOException("The previous release's files could not be cleaned. Trying again.");
        await TargetPipeline.CommitAsync(store, [], [.. links.Where(l => l.DownloadId == download.Id)
            .Select(l => new RowDelete(StoreTable.DownloadTarget, l.Id, null, l)),
            new(StoreTable.Download, download.Id, download.Version, null)], ct);
    }
}
