using System.Collections.Immutable;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Library.Jellyfin;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

public sealed partial class TargetPipeline
{
    private readonly SemaphoreSlim libraryDeletionGate = new(1, 1);

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
            await transfers.DeleteFilesAsync(hash, null, stateGate, ct);
            return;
        }
        var indices = bindings.Except(kept).Select(f => f.FileIndex).Distinct().ToImmutableArray();
        if (!indices.IsEmpty) await transfers.DeleteFilesAsync(hash, indices, stateGate, ct);
    }

    public async Task DeleteTargetFilesAsync(string hash, string targetId, CancellationToken ct)
    {
        hash = hash.ToLowerInvariant();
        await using var scope = scopes.CreateAsyncScope();
        var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
        var download = await repository.DownloadAsync(hash, ct);
        if (download is null) throw new ArgumentException("This download no longer has an action.");
        var indices = (await repository.BindingsAsync(ct))
            .Where(file => file.DownloadId == download.Id && file.TargetId == targetId &&
                file.Role != FileRole.Unwanted)
            .Select(file => file.FileIndex)
            .Distinct()
            .ToImmutableArray();
        if (!indices.IsEmpty) await transfers.DeleteFilesAsync(hash, indices, stateGate, ct);
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
        SemaphoreSlim stateGate, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            // Background filing holds no gate while moving files; let it finish so deletion sees its result.
            await Task.WhenAll(filingTasks.Values);
            await stateGate.WaitAsync(ct);
            try { await DeleteFilesCoreAsync(hash, indices, ct); }
            finally { stateGate.Release(); }
        }
        finally { gate.Release(); }
    }

    private async Task DeleteFilesCoreAsync(string hash, ImmutableArray<int>? indices, CancellationToken ct)
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
        var shared = allFiles.Any(f => f.Role != FileRole.Unwanted && !files.Contains(f));
        var library = scope.ServiceProvider.GetRequiredService<ILibraryPlacement>();
        var root = (await library.RootsAsync(ct)).Single(r => r.Id == download.RootId);
        var links = await store.ListAsync<DownloadTargetRow>(link => link.DownloadId == download.Id, ct);
        var targetIds = files.Select(file => file.TargetId).OfType<string>()
            .Concat(shared ? [] : links.Select(link => link.TargetId)).ToHashSet(StringComparer.Ordinal);
        var targets = await store.ListAsync<TargetRow>(target => targetIds.Contains(target.Id), ct);
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
                if (t.ReplaceMediaFileId is { } replaced && deletedMedia.Contains(replaced))
                    targetWrites.Add(new(t with
                    {
                        Kind = TargetKind.Acquire, ReplacementMode = null, ReplaceMediaFileId = null,
                        State = TargetState.Done, ResumeState = null, NextTryAt = null,
                        LeaseToken = null, LeaseUntil = null, UpdatedAt = now, Version = t.Version + 1,
                    }, t.Version, null));
                continue;
            }
            if (t.State == TargetState.Removed && t.Kind == TargetKind.Acquire) continue;
            targetWrites.Add(new(t with
            {
                Kind = TargetKind.Acquire, ReplacementMode = null, ReplaceMediaFileId = null,
                State = TargetState.Removed, ResumeState = null, NextTryAt = null,
                LeaseToken = null, LeaseUntil = null, UpdatedAt = now, Version = t.Version + 1,
            }, t.Version, null));
        }
        await TargetPipeline.CommitAsync(store,
            [new(download with { Intent = shared ? download.Intent : DownloadIntent.Stopped,
                Version = download.Version + 1 }, download.Version, null), .. targetWrites], [], ct);
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
            var restored = download with { Version = download.Version + 2 };
            await TargetPipeline.CommitAsync(store, [new(restored, download.Version + 1, null)],
                [.. links.Where(l => targets.Any(t => t.Id == l.TargetId))
                        .Select(l => new RowDelete(StoreTable.DownloadTarget, l.Id, null, l))], ct);
            var remaining = (await repository.BindingsAsync(ct)).Where(f => f.DownloadId == download.Id).ToImmutableArray();
            if (restored.FinishedAt is null && remaining.Any(f => f.Selected && !f.Filed))
                await engine.RecoverAsync([restored], remaining, ct);
        }
        else
        {
            if (!await repository.RemoveDownloadFilesAsync(download.Id, ct))
                throw new IOException("The download files changed while removing them. Try again.");
            await TargetPipeline.CommitAsync(store, [],
                [.. links.Select(l => new RowDelete(StoreTable.DownloadTarget, l.Id, null, l)),
                     new(StoreTable.Download, download.Id, download.Version + 1, null)], ct);
            await engine.DeleteTorrentAsync(download.Id, ct);
        }
        if (engine is TorrentFlow.Engine.MonoTorrentEngine concrete) await concrete.SaveDevStateAsync(ct);
    }
}
