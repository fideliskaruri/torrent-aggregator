using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

public sealed record FindAnotherResult(string? TargetId, string? Error)
{
    public static readonly FindAnotherResult Missing = new(null, null);
}

public sealed partial class TargetPipeline
{
    public async Task<FindAnotherResult> FindAnotherForLibraryFileAsync(string mediaFileId, string actor,
        CancellationToken ct)
    {
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var repository = scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
            var file = (await repository.MediaAsync(null, ct)).SingleOrDefault(media =>
                media.Id == mediaFileId);
            if (file is null || file.Role != FileRole.Video || file.Status != FilePresence.Present ||
                file.MissingSince is not null)
                return FindAnotherResult.Missing;

            var work = (await store.ListAsync<WorkRow>(row => row.Id == file.WorkId, ct)).SingleOrDefault();
            if (work is null || work.Kind == WorkKind.Film && file.EpisodeId is not null ||
                work.Kind == WorkKind.Series && file.EpisodeId is null)
                return FindAnotherResult.Missing;

            // The schema allows one target per episode (or per film), so the replacement reuses that row.
            var old = (await store.ListAsync<TargetRow>(target => target.WorkId == file.WorkId &&
                target.EpisodeId == file.EpisodeId, ct)).SingleOrDefault();
            if (old is not null && old.State is not (TargetState.Done or TargetState.Removed))
                return old.Kind == TargetKind.Replace && old.ReplaceMediaFileId == file.Id
                    ? new(old.Id, null)
                    : new(null, "This item already has a download in progress. Wait for it to finish, then try again.");

            var bindings = await repository.BindingsAsync(ct);
            var binding = bindings.FirstOrDefault(row => row.MediaFileId == file.Id &&
                row.Role == FileRole.Video);
            var downloadId = file.DownloadId ?? binding?.DownloadId;
            var download = downloadId is null ? null :
                (await repository.DownloadsAsync(ct)).SingleOrDefault(row => row.Id == downloadId);
            var releaseHash = download?.Hash.ToLowerInvariant();
            var now = DateTimeOffset.UtcNow;
            var preference = (await store.ListAsync<WorkPreferenceRow>(row => row.WorkId == work.Id, ct))
                .SingleOrDefault();
            var floor = preference?.ResolutionFloor;
            var preferred = preference?.PreferredResolution ?? floor ?? 1080;
            var batch = Guid.NewGuid().ToString("N");
            var target = old is not null
                ? old with
                {
                    Kind = TargetKind.Replace, ReplaceMediaFileId = file.Id,
                    ReplacementMode = ReplacementMode.Replace, State = TargetState.Wanted,
                    ResumeState = null, ReasonCode = null, ReasonText = null, NextTryAt = null,
                    ExpectedAt = null, ResolutionFloor = floor ?? old.ResolutionFloor,
                    PreferredResolution = preferred, MaxBytes = preference?.MaxBytesPerItem ?? old.MaxBytes,
                    DownloadNow = false, CreatedBy = actor, Origin = IntentOrigin.Owner, AutoRuleId = null,
                    ChosenReleaseHash = null, PickedReleaseHash = null, BatchId = batch, ClickedAt = now,
                    SubstantiveMisses = 0, HelpNotifiedAt = null, LeaseUntil = null, LeaseToken = null,
                    UpdatedAt = now, Version = old.Version + 1,
                }
                : new TargetRow
                {
                    Id = $"target:{work.Id}:{file.EpisodeId ?? "film"}",
                    WorkId = work.Id,
                    EpisodeId = file.EpisodeId,
                    Kind = TargetKind.Replace,
                    State = TargetState.Wanted,
                    ResumeState = null,
                    ReasonCode = null,
                    ReasonText = null,
                    NextTryAt = null,
                    ExpectedAt = null,
                    ResolutionFloor = floor,
                    PreferredResolution = preferred,
                    MaxBytes = preference?.MaxBytesPerItem,
                    DownloadNow = false,
                    CreatedBy = actor,
                    Origin = IntentOrigin.Owner,
                    AutoRuleId = null,
                    ChosenReleaseHash = null,
                    ReplaceMediaFileId = file.Id,
                    ReplacementMode = ReplacementMode.Replace,
                    BatchId = batch,
                    ClickedAt = now,
                    SubstantiveMisses = 0,
                    HelpNotifiedAt = null,
                    LeaseUntil = null,
                    LeaseToken = null,
                    CreatedAt = now,
                    UpdatedAt = now,
                    Version = 1,
                };
            var writes = ImmutableArray.CreateBuilder<RowWrite>();
            if (releaseHash is not null)
            {
                var existingBlock = (await store.ListAsync<BlockRow>(row =>
                    row.Hash == releaseHash && row.WorkKey == work.WorkKey, ct)).SingleOrDefault();
                writes.Add(new(new BlockRow
                {
                    Id = existingBlock?.Id ?? Guid.NewGuid().ToString("N"),
                    Hash = releaseHash,
                    WorkKey = work.WorkKey,
                    Reason = "Owner chose another source",
                    Origin = BlockOrigin.Owner,
                    ReplacedByHash = null,
                    CreatedAt = existingBlock?.CreatedAt ?? now,
                    Until = null,
                }, null, existingBlock));
            }
            writes.Add(new(target, old?.Version, null));
            try
            {
                await CommitAsync(store, writes, [], ct);
            }
            catch (InvalidOperationException)
            {
                var concurrent = (await store.ListAsync<TargetRow>(row =>
                    row.WorkId == file.WorkId && row.EpisodeId == file.EpisodeId, ct)).SingleOrDefault();
                if (concurrent is { Kind: TargetKind.Replace } && concurrent.ReplaceMediaFileId == file.Id &&
                    concurrent.State is not (TargetState.Done or TargetState.Removed))
                    return new(concurrent.Id, null);
                return new(null, "Something else changed this item at the same time. Try again.");
            }
            return new(target.Id, null);
        }
        finally { stateGate.Release(); }
    }

    public async Task<bool> ClearReplacementsAsync(string mediaFileId, CancellationToken ct)
    {
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var targets = await store.ListAsync<TargetRow>(row =>
                row.Kind == TargetKind.Replace && row.ReplaceMediaFileId == mediaFileId, ct);
            if (targets.Length == 0) return true;
            var now = DateTimeOffset.UtcNow;
            try
            {
                // Back to a plain acquire row, so the planner treats the item as owned again.
                await CommitAsync(store, targets.Select(target => new RowWrite(target with
                {
                    Kind = TargetKind.Acquire,
                    ReplaceMediaFileId = null,
                    ReplacementMode = null,
                    UpdatedAt = now,
                    Version = target.Version + 1,
                }, target.Version, null)), [], ct);
                return true;
            }
            catch (InvalidOperationException) { return false; }
        }
        finally { stateGate.Release(); }
    }

    /// <summary>The newest present video filed by this replacement, never the file it replaces.</summary>
    public static MediaFileRow? ReplacementCopy(TargetRow target, IEnumerable<DownloadFileRow> bindings,
        IEnumerable<MediaFileRow> media)
    {
        if (target.Kind != TargetKind.Replace || target.ReplaceMediaFileId is null || target.State != TargetState.Done)
            return null;
        var since = target.ClickedAt ?? target.CreatedAt;
        var ids = bindings.Where(binding => binding.TargetId == target.Id && binding.Role == FileRole.Video &&
                binding.Filed && binding.MediaFileId is not null && binding.MediaFileId != target.ReplaceMediaFileId)
            .Select(binding => binding.MediaFileId!).ToHashSet(StringComparer.Ordinal);
        return media.Where(file => ids.Contains(file.Id) && file.Role == FileRole.Video &&
                file.Status == FilePresence.Present && file.MissingSince is null && file.AddedAt >= since)
            .OrderByDescending(file => file.AddedAt).FirstOrDefault();
    }
}
