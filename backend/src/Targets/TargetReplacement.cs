using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

public sealed partial class TargetPipeline
{
    public async Task<string?> FindAnotherForLibraryFileAsync(string mediaFileId, string actor,
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
                return null;

            var targets = await store.ListAsync<TargetRow>(target => target.WorkId == file.WorkId, ct);
            var active = targets.Where(target => target.Kind == TargetKind.Replace &&
                    target.ReplaceMediaFileId == file.Id &&
                    target.State is not (TargetState.Done or TargetState.Removed))
                .OrderByDescending(target => target.UpdatedAt).FirstOrDefault();
            if (active is not null) return active.Id;

            var work = (await store.ListAsync<WorkRow>(row => row.Id == file.WorkId, ct)).SingleOrDefault();
            if (work is null || work.Kind == WorkKind.Film && file.EpisodeId is not null ||
                work.Kind == WorkKind.Series && file.EpisodeId is null)
                return null;

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
            var replacementId = targets.Any(target => target.Id == $"replace:{file.Id}")
                ? $"replace:{file.Id}:{Guid.NewGuid():N}" : $"replace:{file.Id}";
            var target = new TargetRow
            {
                Id = replacementId,
                WorkId = work.Id,
                EpisodeId = file.EpisodeId,
                Kind = TargetKind.Replace,
                State = TargetState.Wanted,
                ResumeState = null,
                ReasonCode = null,
                ReasonText = null,
                NextTryAt = null,
                ExpectedAt = null,
                ResolutionFloor = preference?.ResolutionFloor,
                PreferredResolution = preference?.PreferredResolution ??
                    preference?.ResolutionFloor ?? 1080,
                MaxBytes = preference?.MaxBytesPerItem,
                DownloadNow = false,
                CreatedBy = actor,
                Origin = IntentOrigin.Owner,
                AutoRuleId = null,
                ChosenReleaseHash = null,
                ReplaceMediaFileId = file.Id,
                ReplacementMode = ReplacementMode.Replace,
                BatchId = Guid.NewGuid().ToString("N"),
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
            writes.Add(new(target, null, null));
            try
            {
                await CommitAsync(store, writes, [], ct);
            }
            catch (InvalidOperationException)
            {
                var concurrent = (await store.ListAsync<TargetRow>(row =>
                    row.WorkId == file.WorkId && row.Kind == TargetKind.Replace &&
                    row.ReplaceMediaFileId == file.Id &&
                    row.State != TargetState.Done && row.State != TargetState.Removed, ct))
                    .OrderByDescending(row => row.UpdatedAt).FirstOrDefault();
                if (concurrent is not null) return concurrent.Id;
                throw;
            }
            return target.Id;
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
                await CommitAsync(store, targets.Select(target => new RowWrite(target with
                {
                    ReplaceMediaFileId = null,
                    UpdatedAt = now,
                    Version = target.Version + 1,
                }, target.Version, null)), [], ct);
                return true;
            }
            catch (InvalidOperationException) { return false; }
        }
        finally { stateGate.Release(); }
    }
}
