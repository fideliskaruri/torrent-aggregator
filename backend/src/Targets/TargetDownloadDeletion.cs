using System.Collections.Immutable;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Library.Jellyfin;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

public sealed record DownloadDeletionSelection(DownloadRow Download, ImmutableArray<DownloadFileRow> Bindings,
    ImmutableArray<DownloadTargetRow> Links, ImmutableArray<TargetRow> Targets)
{
    public ImmutableArray<string> SelectedTargets { get; init; } = [];
}

public sealed partial class TargetPipeline
{
    private readonly SemaphoreSlim libraryDeletionGate = new(1, 1);

    public async Task DeleteCapturedFilesAsync(DownloadDeletionSelection selection,
        ImmutableArray<string>? targetIds, CancellationToken ct)
    {
        var kept = selection.Targets.Where(t => t.State == TargetState.Removed).Select(t => t.Id).ToHashSet(StringComparer.Ordinal);
        var files = targetIds is null
            ? selection.Bindings.Where(f => f.TargetId is null || !kept.Contains(f.TargetId)).ToImmutableArray()
            : selection.Bindings.Where(f => f.TargetId is not null && targetIds.Value.Contains(f.TargetId) && f.Role != FileRole.Unwanted).ToImmutableArray();
        selection = selection with { SelectedTargets = targetIds ??
            [.. selection.Targets.Where(t => !kept.Contains(t.Id)).Select(t => t.Id)] };
        await transfers.DeleteFilesAsync(selection.Download.Hash, [.. files.Select(f => f.FileIndex).Distinct()],
            stateGate, ct, files, selection);
    }

    public async Task DeleteDownloadFilesAsync(string hash, CancellationToken ct)
    {
        hash = hash.ToLowerInvariant();
        await using var scope = scopes.CreateAsyncScope();
        var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
        var download = await repository.DownloadAsync(hash, ct);
        if (download is null) return;
        var bindings = (await repository.BindingsAsync(ct)).Where(f => f.DownloadId == download.Id).ToArray();
        var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
        var removed = (await store.ListAsync<TargetRow>(t => t.State == TargetState.Removed, ct))
            .Select(t => t.Id).ToHashSet(StringComparer.Ordinal);
        // Files of episodes removed earlier with "keep files" stay on disk.
        var kept = bindings.Where(f => f.TargetId is not null && removed.Contains(f.TargetId)).ToArray();
        if (kept.Length == 0)
        {
            await transfers.DeleteFilesAsync(hash, null, stateGate, ct, [.. bindings]);
            return;
        }
        var indices = bindings.Except(kept).Select(f => f.FileIndex).Distinct().ToImmutableArray();
        if (!indices.IsEmpty) await transfers.DeleteFilesAsync(hash, indices, stateGate, ct, [.. bindings.Except(kept)]);
    }

    public async Task DeleteTargetFilesAsync(string hash, string targetId, CancellationToken ct)
        => await DeleteTargetsFilesAsync(hash, [targetId], ct);

    public async Task DeleteTargetsFilesAsync(string hash, ImmutableArray<string> targetIds, CancellationToken ct)
    {
        hash = hash.ToLowerInvariant();
        await using var scope = scopes.CreateAsyncScope();
        var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
        var download = await repository.DownloadAsync(hash, ct);
        if (download is null) throw new ArgumentException("This download no longer has an action.");
        var captured = (await repository.BindingsAsync(ct))
            .Where(file => file.DownloadId == download.Id && file.TargetId is not null && targetIds.Contains(file.TargetId) &&
                file.Role != FileRole.Unwanted)
            .ToImmutableArray();
        var indices = captured.Select(file => file.FileIndex).Distinct().ToImmutableArray();
        if (!indices.IsEmpty) await transfers.DeleteFilesAsync(hash, indices, stateGate, ct, captured);
    }

    public async Task<LibraryDeleteResult> DeleteLibraryAsync(LibraryDeletePreview preview, CancellationToken ct,
        bool deleteWithoutPlaybackCheck = false)
    {
        await libraryDeletionGate.WaitAsync(ct);
        try
        {
            var playback = await playbackGuard.ReadAsync(ct);
            if (playback.Status == JellyfinPlaybackReadStatus.Available)
            {
                var deletingPaths = preview.Items.SelectMany(item => item.Paths)
                    .Concat(preview.UnboundMedia.Select(file => file.Path));
                if (deletingPaths.Any(path => playback.PlayingPaths.Any(playing =>
                        JellyfinPathMapper.PathsEqual(path, playing))))
                    throw new JellyfinDeleteRefusedException(
                        "This is playing in Jellyfin right now. Stop it and try again.", "playing");
            }
            else if (playback.Status != JellyfinPlaybackReadStatus.NotConfigured && !deleteWithoutPlaybackCheck)
                throw new JellyfinDeleteRefusedException(playback.Status == JellyfinPlaybackReadStatus.NotAdmin
                    ? "Jellyfin only shows what's playing to an admin, so we can't check. Delete anyway if nobody is watching it."
                    : "Couldn't reach Jellyfin to check nobody is watching this. Delete anyway if nobody is.",
                    "playback-unknown");
            var result = await LibraryRemoval.DeleteAsync(preview,
                (item, token) => transfers.DeleteFilesAsync(item.Download.Hash, item.FileIndices, stateGate, token),
                async (media, token) =>
                {
                    var bound = preview.Items.SelectMany(i => i.TargetIds).ToHashSet();
                    foreach (var id in preview.TargetIds.Where(id => !bound.Contains(id)))
                        await ActionAsync(id, TargetAction.Remove, token);
                    await using var scope = scopes.CreateAsyncScope();
                    await LibraryRemoval.DeleteUnboundAsync(media,
                        (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>(), token);
                }, ct);
            if (result.Ok)
                foreach (var id in preview.TargetIds) await ActionAsync(id, TargetAction.Remove, ct);
            return result;
        }
        finally { libraryDeletionGate.Release(); }
    }
}

internal sealed partial class TargetTransfers
{
    internal async Task DeleteFilesAsync(string hash, ImmutableArray<int>? indices,
        SemaphoreSlim stateGate, CancellationToken ct, ImmutableArray<DownloadFileRow>? captured = null,
        DownloadDeletionSelection? selection = null)
    {
        await gate.WaitAsync(ct);
        try
        {
            // Background filing holds no gate while moving files; let it finish so deletion sees its result.
            await Task.WhenAll(filingTasks.Values);
            await stateGate.WaitAsync(ct);
            try { await DeleteFilesCoreAsync(hash, indices, captured, selection, ct); }
            finally { stateGate.Release(); }
        }
        finally { gate.Release(); }
    }

    private async Task DeleteFilesCoreAsync(string hash, ImmutableArray<int>? indices,
        ImmutableArray<DownloadFileRow>? captured, DownloadDeletionSelection? selection, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
        var normalizedHash = hash.ToLowerInvariant();
        var download = (await store.ListAsync<DownloadRow>(row => row.Hash == normalizedHash, ct)).SingleOrDefault();
        if (download is null) return;
        var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
        var allFiles = (await repository.BindingsAsync(ct)).Where(f => f.DownloadId == download.Id).ToImmutableArray();
        if (indices is not null && indices.Value.Any(i => allFiles.All(f => f.FileIndex != i)))
            throw new IOException("The title files changed. Refresh the deletion preview and try again.");
        var files = indices is null ? allFiles :
            allFiles.Where(f => indices.Value.Contains(f.FileIndex)).ToImmutableArray();
        if (captured is { } expected && (files.Length != expected.Length || files.Any(file => !expected.Contains(file))))
            throw new IOException("The title files changed. Refresh and try again.");
        var library = scope.ServiceProvider.GetRequiredService<ILibraryPlacement>();
        var root = (await library.RootsAsync(ct)).Single(r => r.Id == download.RootId);
        var links = await store.ListAsync<DownloadTargetRow>(link => link.DownloadId == download.Id, ct);
        var members = await store.ListAsync<TargetRow>(target => links.Select(l => l.TargetId).Contains(target.Id), ct);
        if (selection is not null && (download.Version != selection.Download.Version ||
            allFiles.Length != selection.Bindings.Length || allFiles.Any(f => !selection.Bindings.Contains(f)) ||
            links.Length != selection.Links.Length || links.Any(l => !selection.Links.Contains(l)) ||
            members.Length != selection.Targets.Length || members.Any(t => !selection.Targets.Any(s => s.Id == t.Id && s.Version == t.Version))))
            throw new IOException("The download changed. Refresh and try again.");
        var targetIds = files.Select(file => file.TargetId).OfType<string>()
            .Concat(selection?.SelectedTargets ?? []).ToHashSet(StringComparer.Ordinal);
        var shared = allFiles.Any(f => f.Role != FileRole.Unwanted && !files.Contains(f)) ||
            links.Any(l => !targetIds.Contains(l.TargetId));
        var targets = members.Where(t => targetIds.Contains(t.Id)).ToArray();
        var allMedia = await repository.MediaAsync(null, ct);
        var deletedMedia = allMedia.Where(m => m.DownloadId == download.Id && (!shared || files.Any(f =>
            f.MediaFileId == m.Id || f.FileIndex == m.FileIndex))).Select(m => m.Id).ToHashSet(StringComparer.Ordinal);
        // A target that still has another present copy (e.g. the new copy after "Keep new") stays owned.
        bool HasOtherCopy(TargetRow t) => allMedia.Any(m => m.Role == FileRole.Video &&
            m.Status == FilePresence.Present && m.MissingSince == null && !deletedMedia.Contains(m.Id) &&
            m.WorkId == t.WorkId && m.EpisodeId == t.EpisodeId);
        var now = DateTimeOffset.UtcNow;
        var targetWrites = new List<RowWrite>();
        foreach (var t in targets)
        {
            if (HasOtherCopy(t))
            {
                if (t.ReasonCode == WaitReason.RemovalIncomplete ||
                    t.ReplaceMediaFileId is { } replaced && deletedMedia.Contains(replaced))
                    targetWrites.Add(new(t with
                    {
                        Kind = TargetKind.Acquire, ReplacementMode = null, ReplaceMediaFileId = null,
                        State = TargetState.Done, ResumeState = null, NextTryAt = null, ReasonCode = null, ReasonText = null,
                        LeaseToken = null, LeaseUntil = null, UpdatedAt = now, Version = t.Version + 1,
                    }, t.Version, null));
                continue;
            }
            if (t.State == TargetState.Removed && t.Kind == TargetKind.Acquire) continue;
            targetWrites.Add(new(t with
            {
                Kind = TargetKind.Acquire, ReplacementMode = null, ReplaceMediaFileId = null,
                State = TargetState.Removed, ResumeState = null, NextTryAt = null, ReasonCode = null, ReasonText = null,
                LeaseToken = null, LeaseUntil = null, UpdatedAt = now, Version = t.Version + 1,
            }, t.Version, null));
        }
        // Fence retries durably without hiding files before physical work succeeds.
        // Failure/disconnect leaves visible held rows; it never restarts destructive work.
        var held = targets.Where(t => t.State != TargetState.Removed && !HasOtherCopy(t)).ToArray();
        await TargetPipeline.CommitAsync(store,
            [new(download with { Intent = DownloadIntent.Paused,
                Version = download.Version + 1 }, download.Version, null),
             .. held.Select(t => new RowWrite(t with { State = TargetState.Waiting,
                ReasonCode = WaitReason.RemovalIncomplete,
                ReasonText = "Removal did not finish. Delete again to retry.",
                ResumeState = t.ReasonCode == WaitReason.RemovalIncomplete ? t.ResumeState : t.State,
                NextTryAt = null, LeaseToken = null, LeaseUntil = null,
                UpdatedAt = now, Version = t.Version + 1 }, t.Version, null))], [], ct);
        targetWrites = targetWrites.Select(w => w.Row is TargetRow t && held.Any(h => h.Id == t.Id)
            ? new RowWrite(t with { Version = t.Version + 1 }, w.ExpectedVersion + 1, null) : w).ToList();
        targetWrites.AddRange(held.Where(t => targetWrites.All(w => w.Row.Id != t.Id))
            .Select(t => new RowWrite(t with { State = TargetState.Done, ResumeState = null,
                ReasonCode = null, ReasonText = null, Version = t.Version + 2 }, t.Version + 1, null)));
        var drain = await engine.StopAndReleaseFilesAsync(download.Id, ct);
        if (!drain.WritesDrained || drain.Failure is not null)
            throw new IOException(drain.Failure?.Message ?? "The download could not stop writing. Try again.");
        await TorrentFlow.Library.DownloadFiling.DeletePayloadAsync(files, root.Path, hash,
            await repository.MediaAsync(null, ct), ct);
        if (shared)
        {
            var replacements = TorrentFlow.Library.DownloadFiling.RetireBindings(files, allFiles, root.Path, hash);
            var media = (await repository.MediaAsync(null, ct)).Where(m => files.Any(f =>
                f.DownloadId == m.DownloadId && (f.MediaFileId == m.Id || f.FileIndex == m.FileIndex))).ToImmutableArray();
            if (!await repository.RemoveLibraryFilesAsync(files, media, replacements, ct))
                throw new IOException("The pack files changed while removing them. Refresh and try again.");
            var restored = download with { Version = download.Version + 2,
                Intent = members.Where(t => !targetIds.Contains(t.Id)).Any(t => t.State is TargetState.Fetching or TargetState.Filing)
                        ? DownloadIntent.Run : download.Intent };
            await TargetPipeline.CommitAsync(store, [new(restored, download.Version + 1, null), .. targetWrites],
                [.. links.Where(l => targets.Any(t => t.Id == l.TargetId))
                        .Select(l => new RowDelete(StoreTable.DownloadTarget, l.Id, null, l))], ct);
            var remaining = (await repository.BindingsAsync(ct)).Where(f => f.DownloadId == download.Id).ToImmutableArray();
            var survivors = await store.ListAsync<TargetRow>(t => !targetIds.Contains(t.Id) && t.State != TargetState.Removed, ct);
            if (!survivors.Any(t => t.ReasonCode == WaitReason.RemovalIncomplete &&
                    t.ChosenReleaseHash == download.Hash) && restored.FinishedAt is null && remaining.Any(f => f.Selected && !f.Filed &&
                survivors.Any(t => t.Id == f.TargetId)))
            {
                await engine.RecoverAsync([restored], remaining, ct);
                if (!(await engine.SnapshotAsync(ct)).Any(s => s.DownloadId == download.Id && s.Failure is null))
                    throw new IOException("Files were removed, but the remaining episodes could not restart. Resume them from Downloads.");
            }
            if (engine is TorrentFlow.Engine.MonoTorrentEngine concrete) await concrete.SaveDevStateAsync(ct);
        }
        else
        {
            if (!await repository.RemoveDownloadFilesAsync(download.Id, ct))
                throw new IOException("The download files changed while removing them. Try again.");
            await TargetPipeline.CommitAsync(store, targetWrites,
                [.. links.Select(l => new RowDelete(StoreTable.DownloadTarget, l.Id, null, l)),
                     new(StoreTable.Download, download.Id, download.Version + 1, null)], ct);
            await engine.DeleteTorrentAsync(download.Id, ct);
        }

    }
}
