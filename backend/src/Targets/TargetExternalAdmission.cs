using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Library;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

public sealed record ExternalTransferInput(string Hash, string Name, byte[] TorrentBytes,
    ImmutableArray<string> Paths, ImmutableArray<ExternalTransferItem> Items, bool Paused = false,
    string? ReviewId = null, ImmutableArray<string> ReviewItemIds = default,
    ImmutableArray<MediaFileRow> Replaces = default);
public sealed record ExternalTransferItem(int FileIndex, string WorkId, string? EpisodeId);

public sealed partial class TargetPipeline
{
    public async Task<EngineResult> AdmitExternalAsync(ExternalTransferInput input, string actor, CancellationToken ct)
    {
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var hash = MonoTorrentEngine.NormalizeHash(input.Hash);
            var existing = (await store.ListAsync<DownloadRow>(row => row.Hash == hash, ct)).SingleOrDefault();
            if (existing is not null)
                return new(true, (await engine.SnapshotAsync(ct)).SingleOrDefault(s => s.DownloadId == existing.Id), null);
            var external = (IExternalEngineAdmission)engine;
            var metadata = await external.PrepareExternalAsync(input.TorrentBytes, hash, ct);
            if (input.Paths.Length != metadata.Length || input.Items.IsDefaultOrEmpty)
                throw new ArgumentException("Every original path and a confirmed video identity are required.");
            if (input.Items.Any(i => i.FileIndex < 0 || i.FileIndex >= metadata.Length) ||
                input.Items.Select(i => i.FileIndex).Distinct().Count() != input.Items.Length ||
                input.Paths.Any(p => !Path.IsPathFullyQualified(p)) ||
                input.Paths.Select(LibraryPaths.PhysicalKey).Distinct().Count() != input.Paths.Length)
                throw new ArgumentException("Choose valid original file indices and distinct absolute paths.");
            var inventory = scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
            var repository = (ILibraryDownloadRepository)inventory;
            // Library rows being handed over are swapped for the download in the same commit.
            var replaces = input.Replaces.IsDefault ? [] : input.Replaces;
            var owned = (await inventory.MediaAsync(null, ct)).Where(m => replaces.All(r => r.Id != m.Id)).ToArray();
            var bindings = await repository.BindingsAsync(ct);
            var selectedPaths = input.Items.Select(item => input.Paths[item.FileIndex]).ToArray();
            if (selectedPaths.Any(p => owned.Any(m => m.PhysicalKey == LibraryPaths.PhysicalKey(p))) ||
                input.Paths.Any(p => bindings.Any(b => b.PhysicalKey == LibraryPaths.PhysicalKey(p))))
                throw new InvalidOperationException("A file in this transfer is already managed. Keep the existing file.");
            var targets = new List<TargetRow>();
            var previous = new Dictionary<string, TargetRow?>();
            var now = DateTimeOffset.UtcNow;
            var token = Guid.NewGuid().ToString("N");
            var id = "targets:" + hash;
            foreach (var item in input.Items.DistinctBy(i => (i.WorkId, i.EpisodeId)))
            {
                var work = await scope.ServiceProvider.GetRequiredService<IMetadata>().GetWorkAsync(item.WorkId, false, ct);
                if (work.Work is null || (item.EpisodeId is null ? work.Work.Work.Kind != WorkKind.Film :
                    !work.Work.Episodes.Any(e => e.Id == item.EpisodeId && e.MappingStatus == MappingStatus.Confirmed)))
                    throw new ArgumentException("Confirm the video's catalog identity in Import first.");
                var targetId = $"target:{item.WorkId}:{item.EpisodeId ?? "film"}";
                var prior = (await store.ListAsync<TargetRow>(row => row.Id == targetId, ct)).SingleOrDefault();
                if (prior is not null && prior.State != TargetState.Removed &&
                    !(prior.State == TargetState.Done && !replaces.IsEmpty))
                    throw new InvalidOperationException("This item already has download intent. Remove it before handing over another transfer.");
                previous[targetId] = prior;
                targets.Add(new TargetRow
                {
                    Id = targetId,
                    WorkId = item.WorkId,
                    EpisodeId = item.EpisodeId,
                    Kind = TargetKind.Acquire,
                    State = input.Paused ? TargetState.Waiting : TargetState.Fetching,
                    ResumeState = input.Paused ? TargetState.Fetching : null,
                    ReasonCode = input.Paused ? WaitReason.Paused : null,
                    ReasonText = input.Paused ? "Paused by you." : null,
                    NextTryAt = null,
                    ExpectedAt = null,
                    ResolutionFloor = null,
                    PreferredResolution = null,
                    MaxBytes = null,
                    DownloadNow = false,
                    CreatedBy = actor,
                    Origin = IntentOrigin.Owner,
                    AutoRuleId = null,
                    ChosenReleaseHash = hash,
                    ReplaceMediaFileId = null,
                    ReplacementMode = null,
                    BatchId = token,
                    ClickedAt = now,
                    SubstantiveMisses = 0,
                    HelpNotifiedAt = null,
                    LeaseUntil = null,
                    LeaseToken = null,
                    CreatedAt = prior?.CreatedAt ?? now,
                    UpdatedAt = now,
                    Version = (prior?.Version ?? 0) + 1,
                });
            }
            var files = metadata.Select(f =>
            {
                var path = Path.GetFullPath(input.Paths[f.Index]);
                LibraryPaths.NoLinks(path);
                var item = input.Items.SingleOrDefault(i => i.FileIndex == f.Index);
                if (item is not null && !MediaImport.IsVideo(path))
                    throw new ArgumentException("Choose a supported video file for each catalog item.");
                return new DownloadFileRow { Id = $"{id}:{f.Index}", DownloadId = id, FileIndex = f.Index, Selected = item is not null, TargetId = item is null ? null : targets.Single(t => t.WorkId == item.WorkId && t.EpisodeId == item.EpisodeId).Id, PartialPath = item is null ? null : path, FinalPath = item is null ? null : path, PhysicalKey = LibraryPaths.PhysicalKey(path), MediaFileId = null, Role = item is null ? FileRole.Unwanted : FileRole.Video, ExpectedBytes = f.Bytes, EnginePath = path, Filed = false };
            }).ToImmutableArray();
            var claim = await engine.ClaimAdmissionAsync(new(token, hash, id, null, now.AddSeconds(90)), ct);
            if (!claim.Accepted) return claim;
            var download = new DownloadRow { Id = id, Hash = hash, Intent = input.Paused ? DownloadIntent.Paused : DownloadIntent.Run, RootId = null, AddedAt = now, FinishedAt = null, AdmissionToken = token, ResumeArtifact = null, RawIntentId = null, Version = 1 };
            try
            {
                var candidate = MonoTorrentEngine.CandidateFor(hash);
                var find = scope.ServiceProvider.GetRequiredService<TargetStore>();
                var release = candidate.Release with { Name = input.Name, Files = metadata, TotalBytes = metadata.Sum(f => f.Bytes) };
                if (!await find.SaveAsync([new(release, null, null)], [], ct))
                    throw new IOException("The source metadata could not be saved.");
                var fileWrites = await ((ILibraryPlacementProposalRepository)inventory).ProposeExternalPlacementAsync(
                    files, input.ReviewId, input.ReviewItemIds, ct)
                    ?? throw new IOException("The original file bindings are already reserved. Scan again.");
                var replacedIds = replaces.Select(r => r.Id).ToArray();
                var operations = await store.ListAsync<FileOperationRow>(o =>
                    o.MediaFileId != null && replacedIds.Contains(o.MediaFileId), ct);
                if (operations.Any(o => o.State != FileOperationState.Done))
                    throw new IOException("A library file is still being moved. Try again when it finishes.");
                var operationIds = operations.Select(o => o.Id).ToArray();
                var claims = await store.ListAsync<FilePathClaimRow>(c => operationIds.Contains(c.OperationId), ct);
                await CommitAsync(store, [new(download, null, null),
                    .. targets.Select(t => new RowWrite(t, previous[t.Id]?.Version, null)),
                    .. targets.Select(t => new RowWrite(new DownloadTargetRow { Id = $"{id}:{t.Id}", DownloadId = id, TargetId = t.Id, Role = AssociationRole.Current, CreatedAt = now }, null, null)),
                    .. fileWrites], [
                    .. replaces.Select(r => new RowDelete(StoreTable.MediaFile, r.Id, r.Version, null)),
                    .. operations.Select(o => new RowDelete(StoreTable.FileOperation, o.Id, null, o)),
                    .. claims.Select(c => new RowDelete(StoreTable.FilePathClaim, c.Id, null, c))], ct);
                if (input.ReviewId is not null)
                {
                    var reviews = scope.ServiceProvider.GetRequiredService<ImportReviewRepository>();
                    foreach (var reviewItemId in input.ReviewItemIds)
                        await reviews.DecideAsync(input.ReviewId, reviewItemId, "handed-over", ct);
                }
                var result = await external.AdmitExternalAsync(new(download,
                    candidate with { Release = release }, [.. files.Select(f => new FileBinding(f.FileIndex,
                        f.EnginePath!, f.Selected))], token), ct);
                if (!result.Accepted) throw new IOException(result.Failure?.Message);
                return result;
            }
            catch (Exception ex)
            {
                await engine.StopAndReleaseFilesAsync(id, CancellationToken.None);
                var persisted = (await store.ListAsync<DownloadRow>(row => row.Id == id, CancellationToken.None)).SingleOrDefault();
                if (persisted is not null)
                {
                    var failedAt = DateTimeOffset.UtcNow;
                    await CommitAsync(store, [.. targets.Select(t => new RowWrite(t with
                    {
                        State = TargetState.Waiting,
                        // A handed-over transfer owns its library files, so it retries in place instead of searching.
                        ResumeState = input.Paused || !replaces.IsEmpty ? TargetState.Fetching : TargetState.Wanted,
                        ReasonCode = input.Paused ? WaitReason.Paused : WaitReason.FileBusy,
                        ReasonText = "The original files could not be opened. Close the other client; TorrentFlow will try again.",
                        NextTryAt = input.Paused ? null : failedAt.AddMinutes(5),
                        UpdatedAt = failedAt, Version = t.Version + 1,
                    }, t.Version, null))], [], CancellationToken.None);
                    return new(true, null, new("FileBusy",
                        "The transfer was saved and will retry when the original files can be opened.", null, false));
                }
                await engine.DeleteTorrentAsync(id, CancellationToken.None);
                throw new IOException("The transfer could not be reserved. Scan the original client and try again.", ex);
            }
            finally { await engine.ReleaseAdmissionClaimAsync(token, CancellationToken.None); }
        }
        finally { stateGate.Release(); }
    }
}
