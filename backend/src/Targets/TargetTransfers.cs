using System.Collections.Immutable;
using System.Collections.Concurrent;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Library;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

internal sealed partial class TargetTransfers(IServiceScopeFactory scopes, IEngine engine,
    ILogger<TargetPipeline> logger)
{
    private const string Prefix = "targets:";
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly ConcurrentDictionary<string, Task> filingTasks = new(StringComparer.Ordinal);

    private async Task CleanRetiredAsync(TargetStore store, ILibraryDownloadRepository repository,
        DownloadRow download, ImmutableArray<DownloadFileRow> files,
        IEnumerable<DownloadTargetRow> links, CancellationToken ct)
    {
        foreach (var file in files.Where(f => !f.Filed && f.EnginePath is not null))
        {
            LibraryPaths.NoLinks(file.EnginePath!);
            if (File.Exists(file.EnginePath)) File.Delete(file.EnginePath);
        }
        if (!await repository.RemoveDownloadFilesAsync(download.Id, ct))
            throw new IOException("The previous source's files could not be cleaned. Trying again.");
        await TargetPipeline.CommitAsync(store, [], [.. links.Where(l => l.DownloadId == download.Id)
            .Select(l => new RowDelete(StoreTable.DownloadTarget, l.Id, null, l)),
            new(StoreTable.Download, download.Id, download.Version, null)], ct);
        await engine.DeleteTorrentAsync(download.Id, ct);
    }

    internal async Task AdmitAsync(WorkSnapshot work, ImmutableArray<TargetRow> targets, Assignment assignment,
        Candidate candidate, ImmutableArray<TorrentFile> metadata, ProbeHandle? handle,
        Func<string, TargetState, WaitReason?, string?, Task> change, SemaphoreSlim stateGate, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        Failure? admissionFailure = null;
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var library = scope.ServiceProvider.GetRequiredService<ILibraryPlacement>();
            var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
            var current = await store.ListAsync<TargetRow>(row => row.WorkId == work.Work.Id, ct);
            targets = [.. targets.Where(t => current.Any(c => c.Id == t.Id && c.State == TargetState.Searching &&
                c.LeaseToken == t.LeaseToken))];
            if (targets.IsEmpty) return;
            var owned = await library.OwnedAsync(new(work.Work.Id,
                [.. targets.Where(t => t.EpisodeId is not null).Select(t => t.EpisodeId!)], targets[0].EpisodeId is null), ct);
            targets = [.. targets.Where(t => !owned.Any(o => o.EpisodeId == t.EpisodeId))];
            if (targets.IsEmpty) return;
            assignment = assignment with
            {
                TargetIds = [.. targets.Select(t => t.Id)],
                Files = [.. assignment.Files.Where(f => targets.Any(t => t.Id == f.TargetId))],
            };
            var oldDownload = (await store.ListAsync<DownloadRow>(null, ct))
                .SingleOrDefault(d => d.Hash == assignment.Hash);
            if (oldDownload is not null)
            {
                await JoinExistingAsync(store, library, repository, work, targets, assignment, metadata,
                    owned, oldDownload, change, stateGate, ct);
                return;
            }
            var placement = await library.PlaceAsync(new(work, targets, assignment, metadata,
                await library.RootsAsync(ct), owned, null, null, null), ct);
            if (placement.Failure is { } failure)
            {
                foreach (var target in targets) await change(target.Id, TargetState.Waiting,
                    failure.Code.Contains("Offline", StringComparison.OrdinalIgnoreCase) ? WaitReason.DriveOffline : WaitReason.NoDriveSpace,
                    failure.Message);
                return;
            }
            var root = (await library.RootsAsync(ct)).Single(r => r.Id == placement.RootId);
            var itemFolder = LibraryPaths.Within(root.Path, placement.Folders.First().RelativeItemFolder!);
            var id = Prefix + assignment.Hash;
            var files = TorrentFlow.Library.DownloadFiling.BindUnwanted(id, assignment.Hash, itemFolder, metadata, placement.Files);
            var token = Guid.NewGuid().ToString("N");
            var now = DateTimeOffset.UtcNow;
            var claim = await engine.ClaimAdmissionAsync(new(token, assignment.Hash, id, handle, now.AddSeconds(90)), ct);
            if (!claim.Accepted)
            {
                foreach (var target in targets) await change(target.Id, TargetState.Waiting,
                    WaitReason.WaitingForSeeders, claim.Failure?.Message ?? "Waiting for the source to become available.");
                return;
            }
            try
            {
                var download = new DownloadRow { Id = id, Hash = assignment.Hash, Intent = DownloadIntent.Run, RootId = root.Id, AddedAt = now, FinishedAt = null, AdmissionToken = token, ResumeArtifact = null, RawIntentId = null, Version = 1 };
                await stateGate.WaitAsync(ct);
                try
                {
                    current = await store.ListAsync<TargetRow>(row => row.WorkId == work.Work.Id, ct);
                    var claimedTargets = targets.Select(t => current.Single(c => c.Id == t.Id)).ToArray();
                    if (claimedTargets.Any(t => t.State != TargetState.Searching || targets.All(p => p.Id != t.Id ||
                        p.LeaseToken != t.LeaseToken))) return;
                    await TargetPipeline.CommitAsync(store, [new(download, null, null),
                        .. FetchingWrites(claimedTargets, assignment.Hash, id, now),
                        .. claimedTargets.Select(t => new RowWrite(new DownloadTargetRow { Id = $"{id}:{t.Id}", DownloadId = id, TargetId = t.Id, Role = AssociationRole.Current, CreatedAt = now }, null, null))], [], ct);
                }
                finally { stateGate.Release(); }
                if (!await repository.SavePlacementAsync(files, placement.Folders, ct))
                    throw new IOException("The library placement changed.");
                var fresh = await store.ListAsync<TargetRow>(row => row.WorkId == work.Work.Id, ct);
                if (targets.Any(t => fresh.All(f => f.Id != t.Id || f.State != TargetState.Fetching)))
                    throw new IOException("The download intent changed before it could start.");
                var admission = new EngineAdmission(download, candidate,
                    [.. files.Select(f => new FileBinding(f.FileIndex, f.EnginePath!, f.Selected))], token);
                await TargetQueue.ApplyAsync(engine, store, ct);
                var result = handle is null ? await engine.StartAsync(admission, ct) :
                    await engine.AdmitFromProbeAsync(handle, admission, ct);
                if (!result.Accepted)
                {
                    admissionFailure = result.Failure;
                    throw new IOException(result.Failure?.Message ?? "The download could not start. Trying again later.");
                }
                if (engine is MonoTorrentEngine concrete) await concrete.SaveDevStateAsync(ct);
            }
            catch (Exception ex)
            {
                await engine.StopAndReleaseFilesAsync(id, CancellationToken.None);
                await stateGate.WaitAsync(CancellationToken.None);
                try
                {
                    var persisted = (await store.ListAsync<DownloadRow>(row => row.Id == id, CancellationToken.None))
                        .SingleOrDefault(d => d.AdmissionToken == token);
                    if (persisted is not null)
                    {
                        if (!await repository.RemoveDownloadFilesAsync(id, CancellationToken.None))
                            throw new IOException("The failed download could not be rolled back.");
                        var affected = await store.ListAsync<TargetRow>(row => row.WorkId == work.Work.Id, CancellationToken.None);
                        var links = await store.ListAsync<DownloadTargetRow>(null, CancellationToken.None);
                        var failedAt = DateTimeOffset.UtcNow;
                        var reason = admissionFailure?.Code.Contains("metadata", StringComparison.OrdinalIgnoreCase) == true
                            ? WaitReason.MetadataUnavailable : WaitReason.SourceFailure;
                        var message = admissionFailure?.Message ?? ex.Message;
                        var retryAt = admissionFailure?.RetryAt is { } due && due > failedAt.AddMinutes(5)
                            ? due : failedAt.AddMinutes(5);
                        var failed = affected.Where(t => targets.Any(a => a.Id == t.Id && a.LeaseToken == t.LeaseToken) &&
                            t.ChosenReleaseHash == assignment.Hash && t.State == TargetState.Fetching).ToArray();
                        await TargetPipeline.CommitAsync(store,
                            [.. failed.Select(t => new RowWrite(t with { State = TargetState.Waiting, ChosenReleaseHash = null,
                                    ReasonCode = reason, ReasonText = $"{admissionFailure?.Code ?? "admission_failed"}: {message}",
                                    NextTryAt = retryAt, ResumeState = TargetState.Wanted, LeaseToken = null, LeaseUntil = null,
                                    UpdatedAt = failedAt, Version = t.Version + 1 }, t.Version, null)),
                                .. failed.Select(t => new RowWrite(new AttemptRow { Id = Guid.NewGuid().ToString("N"), TargetId = t.Id, WorkId = t.WorkId, ReleaseHash = assignment.Hash, ActorUserId = t.CreatedBy, Kind = AttemptKind.Fetch, StartedAt = failedAt, EndedAt = failedAt, Outcome = "Waiting", ReasonCode = admissionFailure?.Code ?? "admission_failed", ReasonText = message, Decision = null, LegacyContext = null, BatchId = t.BatchId, DownloadId = id, DeadlineAt = null, Swap = null },
                                    null, null))],
                            [.. links.Where(l => l.DownloadId == id).Select(l => new RowDelete(StoreTable.DownloadTarget, l.Id, null, l)),
                                new(StoreTable.Download, id, persisted.Version, null)], CancellationToken.None);
                        await engine.DeleteTorrentAsync(id, CancellationToken.None);
                    }
                }
                finally { stateGate.Release(); }
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

    internal async Task RecoverAsync(Func<string, TargetState, WaitReason?, string?, CancellationToken, Task> change,
        CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
        var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
        var links = await store.ListAsync<DownloadTargetRow>(null, ct);
        var downloads = (await store.ListAsync<DownloadRow>(null, ct)).Where(d => d.Id.StartsWith(Prefix)).ToImmutableArray();
        var bindings = (await repository.BindingsAsync(ct)).Where(f => downloads.Any(d => d.Id == f.DownloadId)).ToImmutableArray();
        var targets = await store.ListAsync<TargetRow>(null, ct);
        foreach (var interrupted in downloads.Where(d => links.Any(l => l.DownloadId == d.Id) &&
            links.Where(l => l.DownloadId == d.Id).All(l => l.Role == AssociationRole.Replacement)))
        {
            await engine.StopAndReleaseFilesAsync(interrupted.Id, ct);
            await CleanRetiredAsync(store, repository, interrupted,
                [.. bindings.Where(f => f.DownloadId == interrupted.Id)], links, ct);
        }
        downloads = [.. downloads.Where(d => !links.Any(l => l.DownloadId == d.Id &&
            l.Role == AssociationRole.Replacement))];
        foreach (var orphan in downloads.Where(d => bindings.All(f => f.DownloadId != d.Id)))
        {
            await engine.StopAndReleaseFilesAsync(orphan.Id, ct);
            foreach (var link in links.Where(l => l.DownloadId == orphan.Id))
                if (targets.Any(t => t.Id == link.TargetId && t.State != TargetState.Removed))
                    await change(link.TargetId, TargetState.Wanted, null, "The interrupted download will be found again.", ct);
            var retired = await store.ListAsync<DownloadTargetRow>(null, ct);
            await TargetPipeline.CommitAsync(store, [], [.. retired.Where(l => l.DownloadId == orphan.Id)
                .Select(l => new RowDelete(StoreTable.DownloadTarget, l.Id, null, l)),
                new(StoreTable.Download, orphan.Id, orphan.Version, null)], ct);
            await engine.DeleteTorrentAsync(orphan.Id, ct);
        }
        var resumable = downloads.Where(d => bindings.Any(f => f.DownloadId == d.Id) &&
            targets.Any(t => t.ChosenReleaseHash == d.Hash &&
                links.Any(l => l.TargetId == t.Id && l.DownloadId == d.Id) && t.State != TargetState.Removed))
            .Select(d => targets.Where(t => links.Any(l => l.TargetId == t.Id && l.DownloadId == d.Id))
                .All(t => t.IsPaused() || t.State == TargetState.Removed)
                ? d with { Intent = DownloadIntent.Paused } : d).ToImmutableArray();
        if (resumable.Length > 0) await engine.RecoverAsync(resumable, bindings, ct);
    }

    internal async Task TickAsync(Func<string, TargetState, WaitReason?, string?, CancellationToken, Task> change,
        SemaphoreSlim stateGate, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
            var targets = await store.ListAsync<TargetRow>(null, ct);
            var associations = await store.ListAsync<DownloadTargetRow>(null, ct);
            var downloads = (await store.ListAsync<DownloadRow>(null, ct)).Where(d => d.Id.StartsWith(Prefix)).ToArray();
            await TargetQueue.ApplyAsync(engine, store, ct);
            foreach (var download in downloads)
            {
                if (filingTasks.ContainsKey(download.Id)) continue;
                try
                {
                    var members = targets.Where(t => associations.Any(a =>
                        a.DownloadId == download.Id && a.TargetId == t.Id)).ToArray();
                    var files = (await repository.BindingsAsync(ct))
                        .Where(f => f.DownloadId == download.Id).ToImmutableArray();
                    if (members.Length > 0 && members.All(t => t.ChosenReleaseHash != download.Hash))
                    {
                        await engine.StopAndReleaseFilesAsync(download.Id, ct);
                        if (members.All(t => t.State is TargetState.Done or TargetState.Removed) &&
                            !files.Any(f => f.Filed))
                            await CleanRetiredAsync(store, repository, download, files, associations, ct);
                        continue;
                    }
                    if (members.All(t => t.State == TargetState.Removed))
                    {
                        await engine.StopAndReleaseFilesAsync(download.Id, ct);
                        var library = scope.ServiceProvider.GetRequiredService<ILibraryPlacement>();
                        foreach (var media in (await repository.MediaAsync(null, ct))
                            .Where(m => m.DownloadId == download.Id))
                        {
                            var failure = await library.RecordAsync(media with { DownloadId = null, FileIndex = null,
                                Version = media.Version + 1 }, null, ct);
                            if (failure is not null) throw new IOException(failure.Message);
                        }
                        if (!await repository.RemoveDownloadFilesAsync(download.Id, ct))
                            throw new IOException("The download cleanup changed. Trying again.");
                        await TargetPipeline.CommitAsync(store, [], [.. associations.Where(a => a.DownloadId == download.Id)
                            .Select(a => new RowDelete(StoreTable.DownloadTarget, a.Id, null, a)),
                            new(StoreTable.Download, download.Id, download.Version, null)], ct);
                        await engine.DeleteTorrentAsync(download.Id, ct);
                        if (engine is MonoTorrentEngine removedEngine) await removedEngine.SaveDevStateAsync(ct);
                        continue;
                    }
                    foreach (var retry in members.Where(t => t.State == TargetState.Waiting && !t.IsPaused() &&
                        t.ResumeState == TargetState.Fetching && t.NextTryAt <= DateTimeOffset.UtcNow))
                    {
                        if ((await engine.SnapshotAsync(ct)).All(s => s.DownloadId != download.Id))
                            await engine.RecoverAsync([download], files, ct);
                        await change(retry.Id, TargetState.Fetching, null, null, ct);
                    }
                    members = (await store.ListAsync<TargetRow>(null, ct))
                        .Where(t => associations.Any(a => a.DownloadId == download.Id && a.TargetId == t.Id)).ToArray();
                    var runnable = members.Where(t => t.State is TargetState.Fetching or TargetState.Filing ||
                        t.State == TargetState.Waiting && t.ResumeState == TargetState.Filing).ToArray();
                    var run = runnable.Length > 0 && members.Any(t => t.State == TargetState.Fetching);
                    await engine.SetIntentAsync(download.Id, run, ct);
                    var desired = members.All(t => t.IsPaused() || t.State == TargetState.Removed)
                        ? DownloadIntent.Paused : run ? DownloadIntent.Run : DownloadIntent.Stopped;
                    var latestDownload = download;
                    if (download.Intent != desired && download.FinishedAt is null)
                    {
                        latestDownload = download with { Intent = desired, Version = download.Version + 1 };
                        await TargetPipeline.CommitAsync(store, [new(latestDownload, download.Version, null)], [], ct);
                    }
                    var live = (await engine.SnapshotAsync(ct)).SingleOrDefault(s => s.DownloadId == download.Id);
                    if (live is null && members.Any(t => t.State == TargetState.Fetching))
                    {
                        await engine.RecoverAsync([latestDownload], files, ct);
                        live = (await engine.SnapshotAsync(ct)).SingleOrDefault(s => s.DownloadId == download.Id);
                    }
                    var selected = files.Select(f => new FileBinding(f.FileIndex, f.EnginePath!, f.Selected &&
                        !f.Filed && members.Any(t => t.Id == f.TargetId && t.State == TargetState.Fetching)))
                        .ToImmutableArray();
                    if (live is not null && selected.Any(f =>
                        live.Files.FirstOrDefault(l => l.Index == f.FileIndex)?.Selected != f.Selected))
                    {
                        await engine.SelectAsync(download.Id, selected, ct);
                        live = (await engine.SnapshotAsync(ct)).SingleOrDefault(s => s.DownloadId == download.Id);
                    }
                    var now = DateTimeOffset.UtcNow;
                    var filingReady = members.Any(t => !t.IsPaused() && t.State == TargetState.Filing &&
                        t.ReasonCode != WaitReason.FilingBlocked &&
                        (t.NextTryAt is null || t.NextTryAt <= now));
                    var fetchingReady = live?.Complete == true &&
                        members.Any(t => !t.IsPaused() && t.State == TargetState.Fetching);
                    if (runnable.Length == 0 || !filingReady && !fetchingReady) continue;
                    StartFiling(download.Id, latestDownload, live, stateGate, ct);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Target download tick failed for {DownloadId}", download.Id);
                }
            }
        }
        finally { gate.Release(); }
    }

    private void StartFiling(string downloadId, DownloadRow download, EngineSnapshot? snapshot,
        SemaphoreSlim stateGate, CancellationToken ct)
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!filingTasks.TryAdd(downloadId, completion.Task)) return;
        _ = FileDownloadAsync(downloadId, download, snapshot, stateGate, ct, completion);
    }

    private async Task FileDownloadAsync(string downloadId, DownloadRow download, EngineSnapshot? snapshot,
        SemaphoreSlim stateGate, CancellationToken ct, TaskCompletionSource completion)
    {
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var repository = (ILibraryDownloadRepository)scope.ServiceProvider
                .GetRequiredService<ILibraryRepository>();
            var links = await store.ListAsync<DownloadTargetRow>(null, ct);
            var members = (await store.ListAsync<TargetRow>(null, ct))
                .Where(t => links.Any(a => a.DownloadId == downloadId && a.TargetId == t.Id))
                .ToImmutableArray();
            var files = (await repository.BindingsAsync(ct))
                .Where(f => f.DownloadId == downloadId).ToImmutableArray();
            await DownloadFiling.FileAsync(store, repository, engine, download, snapshot, files,
                members, stateGate, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception ex)
        {
            logger.LogError(ex, "Target download filing failed for {DownloadId}", downloadId);
        }
        finally
        {
            filingTasks.TryRemove(downloadId, out _);
            completion.TrySetResult();
        }
    }
}
