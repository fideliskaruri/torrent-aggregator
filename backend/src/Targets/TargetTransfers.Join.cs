using System.Collections.Immutable;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

internal sealed partial class TargetTransfers
{
    private static IEnumerable<RowWrite> FetchingWrites(IEnumerable<TargetRow> targets, string hash,
        string downloadId, DateTimeOffset now) => targets.SelectMany(t => new RowWrite[]
    {
        new(t with { State = TargetState.Fetching, ChosenReleaseHash = hash, LeaseUntil = null,
            UpdatedAt = now, Version = t.Version + 1 }, t.Version, null),
        new(new AttemptRow { Id = Guid.NewGuid().ToString("N"), TargetId = t.Id, WorkId = t.WorkId,
            ReleaseHash = hash, ActorUserId = t.CreatedBy, Kind = AttemptKind.Fetch, StartedAt = now,
            EndedAt = now, Outcome = "Fetching", ReasonCode = null, ReasonText = null, Decision = null,
            LegacyContext = null, BatchId = t.BatchId, DownloadId = downloadId, DeadlineAt = null,
            Swap = null }, null, null),
    });

    private async Task JoinExistingAsync(TargetStore store, ILibraryPlacement library,
        ILibraryDownloadRepository repository, WorkSnapshot work, ImmutableArray<TargetRow> targets,
        Assignment assignment, ImmutableArray<TorrentFile> metadata, ImmutableArray<OwnedItem> owned,
        DownloadRow download, Func<string, TargetState, WaitReason?, string?, Task> change,
        SemaphoreSlim stateGate, CancellationToken ct)
    {
        var bindings = (await repository.BindingsAsync(ct))
            .Where(file => file.DownloadId == download.Id).ToArray();
        var existing = bindings.ToDictionary(file => file.FileIndex);
        var allTargets = await store.ListAsync<TargetRow>(null, ct);
        var liveTargetIds = allTargets.Where(target =>
            target.State is not (TargetState.Done or TargetState.Removed)).Select(target => target.Id).ToHashSet();
        var joinTargets = ImmutableArray.CreateBuilder<TargetRow>();
        foreach (var target in targets)
        {
            var selections = assignment.Files.Where(file => file.TargetId == target.Id).ToArray();
            var conflicts = selections.Any(selection =>
                !existing.TryGetValue(selection.FileIndex, out var binding) || binding.Filed ||
                binding.TargetId is { } boundTarget && boundTarget != target.Id && liveTargetIds.Contains(boundTarget));
            if (conflicts)
            {
                await change(target.Id, TargetState.Waiting, WaitReason.DownloadCap,
                    "This episode is already being handled by another download. Trying again later.");
                continue;
            }
            joinTargets.Add(target);
        }
        if (joinTargets.Count == 0) return;

        var joined = joinTargets.ToImmutable();
        var joinedAssignment = assignment with
        {
            TargetIds = [.. joined.Select(target => target.Id)],
            Files = [.. assignment.Files.Where(file => joined.Any(target => target.Id == file.TargetId))],
        };
        var placement = await library.PlaceAsync(new(work, joined, joinedAssignment, metadata,
            await library.RootsAsync(ct), owned, download.RootId, null, null), ct);
        if (placement.Failure is { } failure)
        {
            foreach (var target in joined)
                await change(target.Id, TargetState.Waiting, PlacementWaitReason(failure.Code), failure.Message);
            return;
        }

        var updates = placement.Files.Select(file =>
        {
            var before = existing[file.FileIndex];
            var after = before with
            {
                Selected = true,
                TargetId = file.TargetId,
                PartialPath = file.PartialPath,
                FinalPath = file.FinalPath,
                PhysicalKey = file.PhysicalKey,
                MediaFileId = null,
                Role = file.Role,
                ExpectedBytes = file.ExpectedBytes,
                EnginePath = file.EnginePath,
                Filed = false,
            };
            return (Before: before, After: after);
        }).ToImmutableArray();

        var bindingsSaved = false;
        await stateGate.WaitAsync(ct);
        try
        {
            var current = await store.ListAsync<TargetRow>(row => row.WorkId == work.Work.Id, ct);
            var claimed = joined.Select(target => current.SingleOrDefault(candidate =>
                    candidate.Id == target.Id && candidate.State == TargetState.Searching &&
                    candidate.LeaseToken == target.LeaseToken))
                .OfType<TargetRow>().ToArray();
            if (claimed.Length == 0) return;
            var targetIds = claimed.Select(target => target.Id).ToHashSet();
            var claimedUpdates = updates.Where(update => update.After.TargetId is { } id && targetIds.Contains(id))
                .ToImmutableArray();
            if (claimedUpdates.IsEmpty) return;
            var latestDownload = (await store.ListAsync<DownloadRow>(row => row.Id == download.Id, ct)).Single();
            var links = await store.ListAsync<DownloadTargetRow>(row => row.DownloadId == download.Id, ct);
            var now = DateTimeOffset.UtcNow;
            var writes = ImmutableArray.CreateBuilder<RowWrite>();
            writes.AddRange(FetchingWrites(claimed, assignment.Hash, download.Id, now));
            foreach (var target in claimed)
            {
                var link = links.SingleOrDefault(row => row.TargetId == target.Id);
                var currentLink = new DownloadTargetRow
                {
                    Id = $"{download.Id}:{target.Id}",
                    DownloadId = download.Id,
                    TargetId = target.Id,
                    Role = AssociationRole.Current,
                    CreatedAt = now,
                };
                if (link is null) writes.Add(new(currentLink, null, null));
                else if (link.Role != AssociationRole.Current)
                    writes.Add(new(currentLink, null, link));
            }
            if (latestDownload.FinishedAt is not null)
                writes.Add(new(latestDownload with
                {
                    Intent = DownloadIntent.Run,
                    FinishedAt = null,
                    Version = latestDownload.Version + 1,
                }, latestDownload.Version, null));

            bindingsSaved = await repository.UpdateBindingsAsync(claimedUpdates, placement.Folders, ct);
            if (bindingsSaved)
            {
                try
                {
                    await TargetPipeline.CommitAsync(store, writes.ToImmutable(), [], ct);
                }
                catch
                {
                    var rollback = claimedUpdates.Select(update =>
                        (Before: update.After, After: update.Before)).ToImmutableArray();
                    if (!await repository.UpdateBindingsAsync(rollback, [], CancellationToken.None))
                        throw new IOException("The shared source could not restore its previous file bindings.");
                    throw;
                }
            }
        }
        finally { stateGate.Release(); }

        if (!bindingsSaved)
            foreach (var target in joined)
                await change(target.Id, TargetState.Waiting, WaitReason.FileBusy,
                    "The library destination changed before the file could be selected. Trying again later.");
    }
}
