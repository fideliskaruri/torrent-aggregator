using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Library;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

public sealed record ExternalTransferInput(string Hash, string Name, byte[] TorrentBytes,
    ImmutableArray<string> Paths, ImmutableArray<ExternalTransferItem> Items, bool Paused = false,
    string? ReviewId = null, ImmutableArray<string> ReviewItemIds = default);
public sealed record ExternalTransferItem(int FileIndex, string WorkId, string? EpisodeId);

public sealed partial class TargetPipeline
{
    public async Task<EngineResult> AdmitExternalAsync(ExternalTransferInput input, string actor, CancellationToken ct)
    {
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var catalog = new CatalogState(store);
            var hash = MonoTorrentEngine.NormalizeHash(input.Hash);
            var existing = (await catalog.ReadAsync<DownloadRow>(CatalogState.Query(), ct))
                .SingleOrDefault(d => d.Hash == hash);
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
            var owned = await inventory.MediaAsync(null, ct);
            var bindings = await repository.BindingsAsync(ct);
            if (input.Paths.Any(p => owned.Any(m => m.PhysicalKey == LibraryPaths.PhysicalKey(p)) ||
                bindings.Any(b => b.PhysicalKey == LibraryPaths.PhysicalKey(p))))
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
                var prior = (await catalog.ReadAsync<TargetRow>(CatalogState.Query(targetId), ct)).SingleOrDefault();
                if (prior is not null && prior.State != TargetState.Removed)
                    throw new InvalidOperationException("This item already has download intent. Remove it before handing over another transfer.");
                previous[targetId] = prior;
                targets.Add(new(targetId, item.WorkId, item.EpisodeId, TargetKind.Acquire,
                    input.Paused ? TargetState.Paused : TargetState.Fetching,
                    input.Paused ? TargetState.Fetching : null, null, null, null, null,
                    null, null, "any", null, true, 0, null, actor, IntentOrigin.Owner,
                    null, hash, null, null, token, now, 0, null, 0, null,
                    null, prior?.CreatedAt ?? now, now, (prior?.Version ?? 0) + 1));
            }
            var files = metadata.Select(f =>
            {
                var path = Path.GetFullPath(input.Paths[f.Index]);
                LibraryPaths.NoLinks(path);
                var item = input.Items.SingleOrDefault(i => i.FileIndex == f.Index);
                if (item is not null && !MediaImport.IsVideo(path))
                    throw new ArgumentException("Choose a supported video file for each catalog item.");
                return new DownloadFileRow($"{id}:{f.Index}", id, f.Index, item is not null,
                    item is null ? null : targets.Single(t => t.WorkId == item.WorkId && t.EpisodeId == item.EpisodeId).Id,
                    item is null ? null : path, item is null ? null : path, LibraryPaths.PhysicalKey(path),
                    null, item is null ? FileRole.Unwanted : FileRole.Video, f.Bytes, path, false);
            }).ToImmutableArray();
            var claim = await engine.ClaimAdmissionAsync(new(token, hash, id, null, now.AddSeconds(90)), ct);
            if (!claim.Accepted) return claim;
            var download = new DownloadRow(id, hash, input.Paused ? DownloadIntent.Paused : DownloadIntent.Run,
                null, now, null, token, null, null, 1);
            try
            {
                var candidate = MonoTorrentEngine.CandidateFor(hash);
                var find = scope.ServiceProvider.GetRequiredKeyedService<IStore>("find");
                var oldRelease = (await find.ReadAsync<ReleaseRow>(CatalogState.Query(hash), ct)).SingleOrDefault();
                var release = candidate.Release with { Name = input.Name, Files = metadata, TotalBytes = metadata.Sum(f => f.Bytes) };
                var key = Guid.NewGuid().ToString("N");
                var receipt = new AttemptRow("commit:external:" + key, null, null, null, actor,
                    AttemptKind.LegacyEvent, now, now, "applied", null, null, null, null, null, null, null, null);
                var written = await find.CommitAsync(new(key, StoreOwner.Find,
                    [new(release, null, oldRelease), new(receipt, null, null)], []), ct);
                if (!written.Applied) throw new IOException("The release metadata could not be saved.");
                var proposal = await ((ILibraryPlacementProposalRepository)inventory).ProposeExternalPlacementAsync(
                    files, input.ReviewId, input.ReviewItemIds, ct)
                    ?? throw new IOException("The original file bindings are already reserved. Scan again.");
                await CommitAsync(store, [new(download, null, null),
                    .. targets.Select(t => new RowWrite(t, previous[t.Id]?.Version, null)),
                    .. targets.Select(t => new RowWrite(new DownloadTargetRow($"{id}:{t.Id}", id, t.Id,
                        AssociationRole.Current, now), null, null))], [], ct, proposal);
                var result = await external.AdmitExternalAsync(new(download,
                    candidate with { Release = release }, [.. files.Select(f => new FileBinding(f.FileIndex,
                        f.EnginePath!, f.Selected))], token), ct);
                if (!result.Accepted) throw new IOException(result.Failure?.Message);
                return result;
            }
            catch (Exception ex)
            {
                await engine.DetachAsync(id, CancellationToken.None);
                var persisted = (await catalog.ReadAsync<DownloadRow>(CatalogState.Query(id), CancellationToken.None)).SingleOrDefault();
                if (persisted is not null)
                {
                    var failedAt = DateTimeOffset.UtcNow;
                    await CommitAsync(store, [.. targets.Select(t => new RowWrite(t with
                    {
                        State = input.Paused ? TargetState.Paused : TargetState.Waiting,
                        ResumeState = TargetState.Fetching, ReasonCode = WaitReason.FileBusy,
                        ReasonText = "The original files could not be opened. Close the other client; TorrentFlow will try again.",
                        NextTryAt = failedAt.AddMinutes(5), UpdatedAt = failedAt, Version = t.Version + 1,
                    }, t.Version, null))], [], CancellationToken.None);
                    return new(true, null, new("FileBusy",
                        "The transfer was saved and will retry when the original files can be opened.", null, false));
                }
                await ((IEngineRetirement)engine).ForgetAsync(id, CancellationToken.None);
                throw new IOException("The transfer could not be reserved. Scan the original client and try again.", ex);
            }
            finally { await engine.ReleaseAdmissionClaimAsync(token, CancellationToken.None); }
        }
        finally { stateGate.Release(); }
    }
}
