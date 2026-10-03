using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Library;

namespace TorrentFlow.Targets;

internal sealed partial class TargetTransfers
{
    internal sealed record Replacement(Assignment Assignment, Candidate Candidate,
        ImmutableArray<TorrentFile> Metadata, ProbeHandle? Handle);

    internal async Task<bool> SwapAsync(WorkSnapshot work, ImmutableArray<TargetRow> targets,
        DownloadRow old, ImmutableArray<Replacement> replacements, string? stall,
        SemaphoreSlim stateGate, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        var prepared = new List<(Replacement Replacement, DownloadRow Download, ImmutableArray<DownloadFileRow> Files)>();
        var claims = new List<string>();
        var committed = false;
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var catalog = new CatalogState(store);
            var library = scope.ServiceProvider.GetRequiredService<ILibraryPlacement>();
            var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
            if (replacements.IsEmpty || !targets.Select(t => t.Id).Order().SequenceEqual(
                replacements.SelectMany(r => r.Assignment.TargetIds).Order())) return false;
            foreach (var replacement in replacements)
            {
                var assignment = replacement.Assignment;
                var members = targets.Where(t => assignment.TargetIds.Contains(t.Id)).ToImmutableArray();
                if ((await catalog.ReadAsync<DownloadRow>(CatalogState.Query(), ct)).Any(d => d.Hash == assignment.Hash))
                    return false;
                var placement = await library.PlaceAsync(new(work, members, assignment, replacement.Metadata,
                    await library.RootsAsync(ct), [], old.RootId, null, null), ct);
                if (placement.Failure is not null) return false;
                var root = (await library.RootsAsync(ct)).Single(r => r.Id == placement.RootId);
                var folder = LibraryPaths.Within(root.Path, placement.Folders.First().RelativeItemFolder!);
                var id = Prefix + assignment.Hash;
                var files = DownloadFiling.BindUnwanted(id, assignment.Hash, folder, replacement.Metadata, placement.Files);
                var now = DateTimeOffset.UtcNow;
                var token = Guid.NewGuid().ToString("N");
                claims.Add(token);
                var download = new DownloadRow(id, assignment.Hash, DownloadIntent.Run, root.Id, now, null, token, null, null, 1);
                if (!(await engine.ClaimAdmissionAsync(new(token, assignment.Hash, id, replacement.Handle, now.AddSeconds(90))
                    { SharedSlotDownloadId = old.Id }, ct)).Accepted) return false;
                await TargetPipeline.CommitAsync(store, [new(download, null, null),
                    .. members.Select(t => new RowWrite(new DownloadTargetRow($"{id}:{t.Id}", id, t.Id,
                        AssociationRole.Replacement, now), null, null))], [], ct);
                prepared.Add((replacement, download, files));
                if (!await repository.SavePlacementAsync(files, placement.Folders, ct)) return false;
                await engine.ApplyQueueAsync(new([]) { Order = [new(id, members.Min(t => t.Rank),
                    members.Min(t => t.Priority), false, true)] }, ct);
                var admission = new EngineAdmission(download, replacement.Candidate,
                    [.. files.Select(f => new FileBinding(f.FileIndex, f.EnginePath!, f.Selected))], token);
                var start = replacement.Handle is null ? await engine.StartAsync(admission, ct) :
                    await engine.AdmitFromProbeAsync(replacement.Handle, admission, ct);
                if (!start.Accepted) return false;
            }
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(90));
            while (true)
            {
                if (deadline.IsCancellationRequested) return false;
                var current = await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct);
                if (!Unchanged(current)) return false;
                var live = await engine.SnapshotAsync(ct);
                if (live.SingleOrDefault(l => l.DownloadId == old.Id)?.Complete == true) return false;
                if (prepared.All(p => live.SingleOrDefault(l => l.DownloadId == p.Download.Id) is
                    { MetadataAvailable: true } proof && p.Replacement.Assignment.TargetIds.All(targetId =>
                    {
                        var selected = p.Files.Where(f => f.Selected && f.TargetId == targetId).ToArray();
                        var bytes = selected.Sum(f => f.ExpectedBytes);
                        var received = selected.Sum(f => proof.Files.Single(s => s.Index == f.FileIndex).CompletedBytes);
                        return bytes > 0 && received >= Math.Min(64 * 1024, bytes);
                    }))) break;
                try { await Task.Delay(250, deadline.Token); }
                catch (OperationCanceledException) when (deadline.IsCancellationRequested) { return false; }
            }
            await stateGate.WaitAsync(ct);
            try
            {
                if (!Unchanged(await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct))) return false;
                var links = await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query(), ct);
                var now = DateTimeOffset.UtcNow;
                var oldLive = (await engine.SnapshotAsync(ct)).SingleOrDefault(l => l.DownloadId == old.Id);
                await TargetPipeline.CommitAsync(store,
                    [.. targets.Select(t => new RowWrite(t with { ChosenReleaseHash = replacements.Single(r =>
                        r.Assignment.TargetIds.Contains(t.Id)).Assignment.Hash,
                        ReasonCode = null, ReasonText = null, UpdatedAt = now, Version = t.Version + 1 }, t.Version, null)),
                     .. links.Where(l => targets.Any(t => t.Id == l.TargetId) &&
                         (l.DownloadId == old.Id || prepared.Any(p => p.Download.Id == l.DownloadId)))
                         .Select(l => new RowWrite(l with
                         { Role = l.DownloadId == old.Id ? AssociationRole.Retired : AssociationRole.Current }, null, l)),
                     new(new BlockRow(Guid.NewGuid().ToString("N"), old.Hash, work.Work.Id,
                         stall ?? "Owner chose another release", stall is null ? BlockOrigin.Swap : BlockOrigin.Stalled,
                         replacements[0].Assignment.Hash, now, now.AddHours(6)), null, null),
                     new(new AttemptRow(Guid.NewGuid().ToString("N"), targets[0].Id, work.Work.Id, old.Hash,
                         targets[0].CreatedBy, AttemptKind.Swap, prepared[0].Download.AddedAt, now, "Swapped", stall,
                         "Every replacement item delivered checked bytes before Current was retired.", null, null,
                         targets[0].BatchId, prepared[0].Download.Id, null, new(old.Id,
                             [.. prepared.Select(p => p.Download.Id)], [.. targets.Select(t => t.Id)],
                             oldLive?.CompletedSelectedBytes ?? 0, [], null, false)), null, null)], [], ct);
                committed = true;
            }
            finally { stateGate.Release(); }
            if (!(await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query(), ct))
                .Any(l => l.DownloadId == old.Id && l.Role == AssociationRole.Current))
                await engine.DetachAsync(old.Id, ct);
            if (engine is MonoTorrentEngine concrete) await concrete.SaveDevStateAsync(ct);
            return true;

            bool Unchanged(ImmutableArray<TargetRow> current) => targets.All(t => current.Any(c =>
                c.Id == t.Id && c.Version == t.Version && c.State == TargetState.Fetching && c.ChosenReleaseHash == old.Hash));
        }
        finally
        {
            try
            {
                foreach (var token in claims) await engine.ReleaseAdmissionClaimAsync(token, CancellationToken.None);
                foreach (var replacement in replacements)
                    if (replacement.Handle is { } handle) await engine.ReleaseProbeAsync(handle, CancellationToken.None);
                if (!committed)
                {
                    await using var scope = scopes.CreateAsyncScope();
                    var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
                    var catalog = new CatalogState(store);
                    var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
                    foreach (var entry in prepared)
                    {
                        await engine.DetachAsync(entry.Download.Id, CancellationToken.None);
                        var row = (await catalog.ReadAsync<DownloadRow>(CatalogState.Query(entry.Download.Id), CancellationToken.None)).Single();
                        await CleanRetiredAsync(store, repository, row, entry.Files,
                            await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query(), CancellationToken.None), CancellationToken.None);
                    }
                }
            }
            finally { gate.Release(); }
        }
    }

    private async Task CleanRetiredAsync(IStore store, ILibraryDownloadRepository repository,
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
        await ((IEngineRetirement)engine).ForgetAsync(download.Id, ct);
    }
}
