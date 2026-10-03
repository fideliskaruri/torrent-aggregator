using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Library;

namespace TorrentFlow.Targets;

internal sealed partial class TargetTransfers(IServiceScopeFactory scopes, IEngine engine)
{
    private const string Prefix = "targets:";
    private readonly SemaphoreSlim gate = new(1, 1);

    internal async Task AdmitAsync(WorkSnapshot work, ImmutableArray<TargetRow> targets, Assignment assignment,
        Candidate candidate, ImmutableArray<TorrentFile> metadata, ProbeHandle? handle,
        Func<string, TargetState, WaitReason?, string?, Task> change, SemaphoreSlim stateGate, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        Failure? admissionFailure = null;
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var catalog = new CatalogState(store);
            var library = scope.ServiceProvider.GetRequiredService<ILibraryPlacement>();
            var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
            var current = await catalog.ReadAsync<TargetRow>(CatalogState.Query(workId: work.Work.Id), ct);
            targets = [.. targets.Where(t => current.Any(c => c.Id == t.Id && c.State == TargetState.Planning &&
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
            var oldDownload = (await catalog.ReadAsync<DownloadRow>(CatalogState.Query(), ct))
                .SingleOrDefault(d => d.Hash == assignment.Hash);
            if (oldDownload is not null)
            {
                // A shared hash must never be reinserted, nor silently bind a second target's files.
                foreach (var target in targets)
                    await change(target.Id, TargetState.Waiting, WaitReason.DownloadCap,
                        "This release is already downloading. Trying again after it finishes.");
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
            var files = DownloadFiling.BindUnwanted(id, assignment.Hash, itemFolder, metadata, placement.Files);
            var token = Guid.NewGuid().ToString("N");
            var now = DateTimeOffset.UtcNow;
            var claim = await engine.ClaimAdmissionAsync(new(token, assignment.Hash, id, handle, now.AddSeconds(90)), ct);
            if (!claim.Accepted)
            {
                foreach (var target in targets) await change(target.Id, TargetState.Waiting,
                    WaitReason.WaitingForSeeders, claim.Failure?.Message ?? "Waiting for the release to become available.");
                return;
            }
            try
            {
                var download = new DownloadRow(id, assignment.Hash, DownloadIntent.Run, root.Id, now, null, token, null, null, 1);
                await stateGate.WaitAsync(ct);
                try
                {
                    current = await catalog.ReadAsync<TargetRow>(CatalogState.Query(workId: work.Work.Id), ct);
                    var claimedTargets = targets.Select(t => current.Single(c => c.Id == t.Id)).ToArray();
                    if (claimedTargets.Any(t => t.State != TargetState.Planning || targets.All(p => p.Id != t.Id ||
                        p.LeaseToken != t.LeaseToken))) return;
                    await TargetPipeline.CommitAsync(store, [new(download, null, null),
                        .. claimedTargets.Select(t => new RowWrite(t with { State = TargetState.Fetching,
                            ChosenReleaseHash = assignment.Hash, LeaseUntil = null,
                            UpdatedAt = now, Version = t.Version + 1 }, t.Version, null)),
                        .. claimedTargets.Select(t => new RowWrite(new AttemptRow(Guid.NewGuid().ToString("N"), t.Id,
                            t.WorkId, assignment.Hash, t.CreatedBy, AttemptKind.Fetch, now, now, "Fetching", null,
                            null, null, null, t.BatchId, id, null, null), null, null)),
                        .. claimedTargets.Select(t => new RowWrite(new DownloadTargetRow($"{id}:{t.Id}", id, t.Id,
                            AssociationRole.Current, now), null, null))], [], ct);
                }
                finally { stateGate.Release(); }
                if (!await repository.SavePlacementAsync(files, placement.Folders, ct))
                    throw new IOException("The library placement changed.");
                var fresh = await catalog.ReadAsync<TargetRow>(CatalogState.Query(workId: work.Work.Id), ct);
                if (targets.Any(t => fresh.All(f => f.Id != t.Id || f.State != TargetState.Fetching)))
                    throw new IOException("The download intent changed before it could start.");
                var admission = new EngineAdmission(download, candidate,
                    [.. files.Select(f => new FileBinding(f.FileIndex, f.EnginePath!, f.Selected))], token);
                await engine.ApplyQueueAsync(new([])
                {
                    Order = TargetScheduling.Queue(await catalog.ReadAsync<DownloadRow>(CatalogState.Query(), ct),
                        await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query(), ct),
                        await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct), DateTimeOffset.UtcNow,
                        await catalog.ReadAsync<RawIntentRow>(CatalogState.Query(), ct)),
                }, ct);
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
                await engine.DetachAsync(id, CancellationToken.None);
                await stateGate.WaitAsync(CancellationToken.None);
                try
                {
                    var persisted = (await catalog.ReadAsync<DownloadRow>(CatalogState.Query(id), CancellationToken.None))
                        .SingleOrDefault(d => d.AdmissionToken == token);
                    if (persisted is not null)
                    {
                        if (!await repository.RemoveDownloadFilesAsync(id, CancellationToken.None))
                            throw new IOException("The failed download could not be rolled back.");
                        var affected = await catalog.ReadAsync<TargetRow>(CatalogState.Query(workId: work.Work.Id), CancellationToken.None);
                        var links = await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query(), CancellationToken.None);
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
                                .. failed.Select(t => new RowWrite(new AttemptRow(Guid.NewGuid().ToString("N"), t.Id,
                                    t.WorkId, assignment.Hash, t.CreatedBy, AttemptKind.Fetch, failedAt, failedAt, "Waiting",
                                    admissionFailure?.Code ?? "admission_failed", message, null, null, t.BatchId, id, null, null),
                                    null, null))],
                            [.. links.Where(l => l.DownloadId == id).Select(l => new RowDelete(StoreTable.DownloadTarget, l.Id, null, l)),
                                new(StoreTable.Download, id, persisted.Version, null)], CancellationToken.None);
                        await ((IEngineRetirement)engine).ForgetAsync(id, CancellationToken.None);
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
        CancellationToken ct, ImmutableHashSet<string>? permitted = null)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
        var catalog = new CatalogState(store);
        var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
        var links = await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query(), ct);
        var downloads = (await catalog.ReadAsync<DownloadRow>(CatalogState.Query(), ct)).Where(d => d.Id.StartsWith(Prefix) &&
            (permitted is null || links.Any(l => l.DownloadId == d.Id && permitted.Contains(l.TargetId)))).ToImmutableArray();
        var bindings = (await repository.BindingsAsync(ct)).Where(f => downloads.Any(d => d.Id == f.DownloadId)).ToImmutableArray();
        var targets = await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct);
        if (permitted is not null) targets = [.. targets.Where(t => permitted.Contains(t.Id))];
        foreach (var interrupted in downloads.Where(d => links.Any(l => l.DownloadId == d.Id) &&
            links.Where(l => l.DownloadId == d.Id).All(l => l.Role == AssociationRole.Replacement)))
        {
            await engine.DetachAsync(interrupted.Id, ct);
            await CleanRetiredAsync(store, repository, interrupted,
                [.. bindings.Where(f => f.DownloadId == interrupted.Id)], links, ct);
        }
        downloads = [.. downloads.Where(d => !links.Any(l => l.DownloadId == d.Id &&
            l.Role == AssociationRole.Replacement))];
        foreach (var orphan in downloads.Where(d => bindings.All(f => f.DownloadId != d.Id)))
        {
            await engine.DetachAsync(orphan.Id, ct);
            foreach (var link in links.Where(l => l.DownloadId == orphan.Id))
                if (targets.Any(t => t.Id == link.TargetId && t.State != TargetState.Removed))
                    await change(link.TargetId, TargetState.Wanted, null, "The interrupted download will be found again.", ct);
            var retired = await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query(), ct);
            await TargetPipeline.CommitAsync(store, [], [.. retired.Where(l => l.DownloadId == orphan.Id)
                .Select(l => new RowDelete(StoreTable.DownloadTarget, l.Id, null, l)),
                new(StoreTable.Download, orphan.Id, orphan.Version, null)], ct);
            await ((IEngineRetirement)engine).ForgetAsync(orphan.Id, ct);
        }
        var resumable = downloads.Where(d => bindings.Any(f => f.DownloadId == d.Id) &&
            targets.Any(t => t.ChosenReleaseHash == d.Hash &&
                links.Any(l => l.TargetId == t.Id && l.DownloadId == d.Id) && t.State != TargetState.Removed))
            .Select(d => targets.Where(t => links.Any(l => l.TargetId == t.Id && l.DownloadId == d.Id))
                .All(t => t.State is TargetState.Paused or TargetState.Removed)
                ? d with { Intent = DownloadIntent.Paused } : d).ToImmutableArray();
        if (resumable.Length > 0) await engine.RecoverAsync(resumable, bindings, ct);
    }

    internal async Task TickAsync(Func<string, TargetState, WaitReason?, string?, CancellationToken, Task> change,
        SemaphoreSlim stateGate, CancellationToken ct, ImmutableHashSet<string>? permitted = null)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var catalog = new CatalogState(store);
            var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
            var targets = await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct);
            if (permitted is not null) targets = [.. targets.Where(t => permitted.Contains(t.Id))];
            var associations = await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query(), ct);
            var downloads = (await catalog.ReadAsync<DownloadRow>(CatalogState.Query(), ct)).Where(d => d.Id.StartsWith(Prefix) &&
                (permitted is null || associations.Any(a => a.DownloadId == d.Id && permitted.Contains(a.TargetId)))).ToArray();
            await engine.ApplyQueueAsync(new([]) { Order = TargetScheduling.Queue(downloads,
                associations, targets, DateTimeOffset.UtcNow) }, ct);
            foreach (var download in downloads)
            {
                var members = targets.Where(t => associations.Any(a => a.DownloadId == download.Id && a.TargetId == t.Id)).ToArray();
                var files = (await repository.BindingsAsync(ct)).Where(f => f.DownloadId == download.Id).ToImmutableArray();
                if (members.Length > 0 && members.All(t => t.ChosenReleaseHash != download.Hash))
                {
                    await engine.DetachAsync(download.Id, ct);
                    if (members.All(t => t.State is TargetState.Done or TargetState.Removed))
                        await CleanRetiredAsync(store, repository, download, files, associations, ct);
                    continue;
                }
                if (members.All(t => t.State == TargetState.Removed))
                {
                    await engine.DetachAsync(download.Id, ct);
                    var library = scope.ServiceProvider.GetRequiredService<ILibraryPlacement>();
                    foreach (var media in (await repository.MediaAsync(null, ct)).Where(m => m.DownloadId == download.Id))
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
                    await ((IEngineRetirement)engine).ForgetAsync(download.Id, ct);
                    if (engine is MonoTorrentEngine removedEngine) await removedEngine.SaveDevStateAsync(ct);
                    continue;
                }
                foreach (var retry in members.Where(t => t.State == TargetState.Waiting &&
                    t.ResumeState == TargetState.Fetching && t.NextTryAt <= DateTimeOffset.UtcNow))
                {
                    if ((await engine.SnapshotAsync(ct)).All(s => s.DownloadId != download.Id))
                        await engine.RecoverAsync([download], files, ct);
                    await change(retry.Id, TargetState.Fetching, null, null, ct);
                }
                members = (await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct))
                    .Where(t => (permitted is null || permitted.Contains(t.Id)) &&
                        associations.Any(a => a.DownloadId == download.Id && a.TargetId == t.Id)).ToArray();
                var runnable = members.Where(t => t.State is TargetState.Fetching or TargetState.Filing ||
                    t.State == TargetState.Waiting && t.ResumeState == TargetState.Filing).ToArray();
                var run = runnable.Length > 0 && members.Any(t => t.State == TargetState.Fetching);
                await engine.SetIntentAsync(download.Id, run, ct);
                var desired = members.All(t => t.State is TargetState.Paused or TargetState.Removed)
                    ? DownloadIntent.Paused : run ? DownloadIntent.Run : DownloadIntent.Stopped;
                var latestDownload = download;
                if (download.Intent != desired && download.FinishedAt is null)
                {
                    latestDownload = download with { Intent = desired, Version = download.Version + 1 };
                    await TargetPipeline.CommitAsync(store, [new(latestDownload, download.Version, null)], [], ct);
                }
                var live = (await engine.SnapshotAsync(ct)).SingleOrDefault(s => s.DownloadId == download.Id);
                var selected = files.Select(f => new FileBinding(f.FileIndex, f.EnginePath!, f.Selected &&
                    !f.Filed && members.Any(t => t.Id == f.TargetId && t.State == TargetState.Fetching))).ToImmutableArray();
                if (live is not null && selected.Any(f => live.Files.FirstOrDefault(l => l.Index == f.FileIndex)?.Selected != f.Selected))
                {
                    await engine.SelectAsync(download.Id, selected, ct);
                    live = (await engine.SnapshotAsync(ct)).SingleOrDefault(s => s.DownloadId == download.Id);
                }
                if (live is null || runnable.Length == 0) continue;
                foreach (var binding in files.Where(f => f.Selected && !f.Filed && runnable.Any(t => t.Id == f.TargetId)))
                {
                    var target = runnable.Single(t => t.Id == binding.TargetId);
                    if (target.State == TargetState.Waiting && target.NextTryAt > DateTimeOffset.UtcNow) continue;
                    var file = live.Files.Single(f => f.Index == binding.FileIndex);
                    if (!file.AllTouchingPiecesComplete) continue;
                    if (files.Where(f => f.TargetId == target.Id && f.Selected && !f.Filed)
                        .Any(f => !live.Files.Single(l => l.Index == f.FileIndex).AllTouchingPiecesComplete)) continue;
                    await change(target.Id, TargetState.Filing, null, null, ct);
                    var permit = await engine.PrepareFilingAsync(new(binding.Id, download.Id,
                        [new(binding.FileIndex, binding.FinalPath!, false)]), ct);
                    if (permit.Failure is { } failure)
                    {
                        await change(target.Id, TargetState.Waiting, WaitReason.FileBusy, failure.Message, ct);
                        continue;
                    }
                    var committed = false;
                    try
                    {
                        if (DownloadFiling.ValidatePartial(binding, file) is { } invalid)
                        {
                            await change(target.Id, invalid.NeedsOwner ? TargetState.Wanted : TargetState.Waiting,
                                invalid.NeedsOwner ? null : WaitReason.FileBusy, invalid.Message, ct);
                            continue;
                        }
                        var digest = await DownloadFiling.DigestAsync(file.PhysicalPath!, ct);
                        if (!await repository.BeginFilingAsync(binding, digest, ct)) continue;
                        if (engine is not IEngineFilePublisher publisher) throw new InvalidOperationException("Engine filing is unavailable.");
                        var publication = await publisher.PublishFilingAsync(permit, ct);
                        if (!publication.Accepted)
                        {
                            await change(target.Id, TargetState.Waiting, WaitReason.FileBusy, publication.Failure?.Message, ct);
                            continue;
                        }
                        var work = (await store.ReadAsync<WorkRow>(CatalogState.Query(target.WorkId), ct)).Single();
                        var release = (await store.ReadAsync<ReleaseRow>(CatalogState.Query(download.Hash), ct)).Single();
                        var media = DownloadFiling.Media(new(download, new(work, [], [], [], []), [target],
                            release.Parsed.Quality.Resolution, release.Parsed.Quality.Source), binding) with { ContentDigest = digest };
                        await stateGate.WaitAsync(ct);
                        try
                        {
                            var current = (await store.ReadAsync<TargetRow>(CatalogState.Query(target.Id), ct)).Single();
                            if (current.State is TargetState.Removed or TargetState.Paused) continue;
                            var proposal = await repository.ProposeFiledAsync(binding, binding with
                            {
                                EnginePath = binding.FinalPath, PartialPath = null, Selected = false, Filed = true, MediaFileId = media.Id,
                            }, media, ct);
                            if (proposal is null) continue;
                            var siblings = (await repository.BindingsAsync(ct)).Where(f => f.DownloadId == download.Id && f.TargetId == target.Id &&
                                f.Role != FileRole.Unwanted);
                            var done = siblings.All(f => f.Id == binding.Id || f.Filed);
                            var now = DateTimeOffset.UtcNow;
                            await TargetPipeline.CommitAsync(store, [new(current with
                                { State = done ? TargetState.Done : TargetState.Filing, UpdatedAt = now,
                                  Version = current.Version + 1 }, current.Version, null),
                                new(new AttemptRow(Guid.NewGuid().ToString("N"),
                                    target.Id, target.WorkId, download.Hash, target.CreatedBy, AttemptKind.File,
                                    now, now, done ? "Done" : "Filed", null, null, null, null, target.BatchId,
                                    download.Id, null, null), null, null)], [], ct, proposal);
                            committed = true;
                        }
                        finally { stateGate.Release(); }
                    }
                    finally { await engine.CompleteFilingAsync(permit, committed, CancellationToken.None); }
                }
                var after = (await repository.BindingsAsync(ct)).Where(f => f.DownloadId == download.Id &&
                    f.Role != FileRole.Unwanted).ToArray();
                foreach (var target in runnable)
                    if (after.Any(f => f.TargetId == target.Id && f.Role == FileRole.Video) &&
                        after.Where(f => f.TargetId == target.Id).All(f => f.Filed))
                        await change(target.Id, TargetState.Done, null, null, ct);
                if (after.Length > 0 && after.All(f => f.Filed) && download.FinishedAt is null)
                {
                    await engine.DetachAsync(download.Id, ct);
                    await TargetPipeline.CommitAsync(store, [new(latestDownload with { Intent = DownloadIntent.Stopped,
                        FinishedAt = DateTimeOffset.UtcNow, Version = latestDownload.Version + 1 }, latestDownload.Version, null)], [], ct);
                    if (engine is MonoTorrentEngine concrete) await concrete.SaveDevStateAsync(ct);
                }
            }
        }
        finally { gate.Release(); }
    }
}
