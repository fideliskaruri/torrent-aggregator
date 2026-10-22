using System.Collections.Immutable;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Store;
using TorrentFlow.Library;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using static TorrentFlow.Library.RawDownloadFiles;

namespace TorrentFlow.Targets;

public sealed record RawSendReply(bool Accepted, EngineSnapshot? Snapshot, Failure? Failure,
    bool NeedsTitle, ImmutableArray<ExternalWorkChoice> Choices, string? Identified,
    string? Hash, string? WorkKey);

public sealed partial class RawDownloads(MonoTorrentEngine engine, IServiceScopeFactory scopes,
    ILogger<RawDownloads> logger, ExternalIdentity externalIdentity)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private const string Prefix = "raw:";

    public async Task<RawSendReply> SendAsync(string? magnet, string? torrentUrl, string? name,
        string actor, bool now, CancellationToken ct, string? workKey = null, bool plain = false)
    {
        var hash = string.IsNullOrWhiteSpace(magnet)
            ? await engine.ResolveTorrentSourceAsync(torrentUrl!, ct)
            : MonoTorrentEngine.NormalizeHash(magnet);
        if (!plain)
            return await SendExternalAsync(hash, magnet, torrentUrl, name, workKey, actor, ct);
        await using var scope = scopes.CreateAsyncScope();
        var root = (await scope.ServiceProvider.GetRequiredService<ILibraryPlacement>().RootsAsync(ct))
            .Where(r => r.Enabled && r.Online && !r.ReviewRequired).OrderBy(r => r.Priority).FirstOrDefault()
            ?? throw new InvalidOperationException("Add and confirm a download folder in Settings first.");
        var destination = RawDownloadFiles.Destination(root, hash);
        var result = await AddAsync(destination, magnet ?? hash, torrentUrl, name, actor, now, ct);
        return new(result.Accepted, result.Snapshot, result.Failure, false, [], null, hash, null);
    }

    private async Task<RawSendReply> SendExternalAsync(string hash, string? magnet, string? torrentUrl,
        string? name, string? workKey, string actor, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var existing = (await store.ListAsync<DownloadRow>(row => row.Hash == hash, ct)).SingleOrDefault();
            // A library download of this torrent can still take more episodes; a plain one cannot.
            if (existing is { RawIntentId: not null })
                return new(true, (await engine.SnapshotAsync(ct)).SingleOrDefault(s => s.DownloadId == existing.Id),
                    null, false, [], null, hash, workKey);
        }
        finally { gate.Release(); }

        var candidate = MonoTorrentEngine.CandidateFor(magnet ?? hash, torrentUrl);
        var metadata = await engine.MetadataAsync(hash, ct);
        ProbeHandle? handle = null;
        if (metadata is null)
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(30));
            try
            {
                var attachment = await engine.AttachProbeAsync(candidate, deadline.Token);
                handle = attachment.Handle;
                metadata = attachment.Files;
                if (metadata is null && handle is not null)
                    metadata = await engine.WaitMetadataAsync(handle, deadline.Token);
            }
            catch (OperationCanceledException) when (deadline.IsCancellationRequested && !ct.IsCancellationRequested)
            {
                metadata = null;
            }
            finally
            {
                if (handle is not null) await engine.ReleaseProbeAsync(handle, CancellationToken.None);
            }
        }

        var displayName = !string.IsNullOrWhiteSpace(name) ? name : MagnetName(magnet);
        var identified = await externalIdentity.IdentifyAsync(hash, displayName, metadata, workKey, ct);
        var originalName = !string.IsNullOrWhiteSpace(name) ? name : displayName;
        var savedName = !string.IsNullOrWhiteSpace(originalName) &&
            identified.Parsed.RawName.Equals(originalName, StringComparison.Ordinal)
                ? originalName : !string.IsNullOrWhiteSpace(identified.Parsed.RawName)
                    ? identified.Parsed.RawName : hash;
        var release = candidate.Release with
        {
            Name = savedName,
            Parsed = identified.Parsed,
            Magnet = magnet,
            TorrentUri = torrentUrl ?? candidate.Release.TorrentUri,
            Files = metadata,
            TotalBytes = metadata?.Sum(f => f.Bytes),
        };
        await using (var scope = scopes.CreateAsyncScope())
        {
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var old = (await store.ListAsync<ReleaseRow>(row => row.Id == hash, ct)).SingleOrDefault();
            var now = DateTimeOffset.UtcNow;
            release = release with
            {
                FirstSeenAt = old?.FirstSeenAt ?? now,
                LastSeenAt = now,
                Magnet = release.Magnet ?? old?.Magnet,
                TorrentUri = release.TorrentUri ?? old?.TorrentUri,
                Files = release.Files ?? old?.Files,
                TotalBytes = release.TotalBytes ?? old?.TotalBytes,
            };
            // Release rows have no version; record equality on their arrays never matches, so upsert.
            await CommitAsync(store, [new(release, null, null)], [], ct);
        }

        var hasSelectedWork = identified.Work is not null &&
            (!identified.EpisodeIds.IsEmpty || identified.Film);
        if (!string.IsNullOrWhiteSpace(workKey) && !hasSelectedWork)
        {
            // The owner already picked a title; asking again would loop. Say why it can't be filed.
            var failure = identified.Work is { } picked
                ? new Failure("episodes_unmatched",
                    $"The files in this torrent don't match any known episode of {TitleName(picked)}. " +
                    "Pick another title or keep it as a plain download.", null, true)
                : new Failure("title_unavailable",
                    "Couldn't load that title right now. Try again in a moment.", null, false);
            return new(false, null, failure, false, [], null, hash, workKey);
        }
        if (!identified.Confident && string.IsNullOrWhiteSpace(workKey) || !hasSelectedWork)
            return new(false, null, null, true, identified.Choices, identified.Summary, hash, workKey);

        await using (var scope = scopes.CreateAsyncScope())
        {
            var targets = scope.ServiceProvider.GetRequiredService<TargetPipeline>();
            var reply = await targets.AcceptPickedAsync(identified.Work!.Work.WorkKey,
                identified.EpisodeIds, identified.Film, hash, actor, ct);
            return new(reply.Accepted, null, null, false, [], identified.Summary, hash,
                identified.Work.Work.WorkKey);
        }
    }

    private static string TitleName(WorkSnapshot work) =>
        (work.Names.OrderBy(n => n.Ordinal).FirstOrDefault(n => n.Label == NameLabel.English)
            ?? work.Names.OrderBy(n => n.Ordinal).FirstOrDefault())?.Value ?? "this title";

    private static string? MagnetName(string? magnet)
    {
        if (string.IsNullOrWhiteSpace(magnet)) return null;
        foreach (var part in magnet.Split('&').Skip(1))
            if (part.StartsWith("dn=", StringComparison.OrdinalIgnoreCase))
                return Uri.UnescapeDataString(part[3..].Replace('+', ' '));
        return null;
    }

    private async Task<EngineResult> AddAsync(string savePath, string magnet, string? torrentUrl,
        string? name, string actor, bool downloadNow, CancellationToken ct)
    {
        var hash = MonoTorrentEngine.NormalizeHash(magnet);
        SafePath(savePath);
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var existing = (await store.ListAsync<DownloadRow>(row => row.Hash == hash, ct)).SingleOrDefault();
            if (existing is not null)
                return new(true, (await engine.SnapshotAsync(ct)).SingleOrDefault(s => s.DownloadId == existing.Id), null);
            var xs = magnet.Split('&').FirstOrDefault(p => p.StartsWith("xs=", StringComparison.Ordinal));
            var candidate = MonoTorrentEngine.CandidateFor(magnet,
                torrentUrl ?? (xs is null ? null : Uri.UnescapeDataString(xs[3..])));
            var metadata = await engine.MetadataAsync(hash, ct);
            if (metadata is null && Directory.Exists(savePath) &&
                Directory.EnumerateFileSystemEntries(savePath).Any())
                throw new ArgumentException("Choose an empty folder for this torrent.");
            var token = Guid.NewGuid().ToString("N");
            var id = Prefix + hash;
            ProbeHandle? handle = null;
            try
            {
                if (metadata is null)
                {
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    deadline.CancelAfter(TimeSpan.FromSeconds(30));
                    if (handle is null)
                    {
                        var attachment = await engine.AttachProbeAsync(candidate, deadline.Token);
                        handle = attachment.Handle ?? throw new InvalidOperationException(attachment.Failure?.Message);
                    }
                    metadata = await engine.WaitMetadataAsync(handle, deadline.Token);
                }
                var bindings = metadata is { } files ? Bindings(hash, savePath, files, []) : [];
                var claim = await engine.ClaimAdmissionAsync(new(token, hash, id, handle, DateTimeOffset.UtcNow.AddSeconds(90)), ct);
                if (!claim.Accepted) return claim;
                var now = DateTimeOffset.UtcNow;
                var release = candidate.Release with { Name = name ?? candidate.Release.Name,
                    Files = metadata, TotalBytes = metadata?.Sum(f => f.Bytes) };
                var findStore = scope.ServiceProvider.GetRequiredService<TargetStore>();
                await CommitAsync(findStore, [new(release, null, null)], [], ct);
                var raw = new RawIntentRow { Id = id, ActorUserId = actor, ReleaseHash = hash,
                    DownloadId = null, SelectedFiles = [], ExplicitDirectory = Path.GetFullPath(savePath),
                    State = RawDownloadState.Fetching, NowAt = downloadNow ? now : null,
                    CreatedAt = now, UpdatedAt = now, Version = 1 };
                await CommitAsync(store, [new(raw, null, null)], [], ct);
                var download = new DownloadRow { Id = id, Hash = hash, Intent = DownloadIntent.Run,
                    RootId = null, AddedAt = now, FinishedAt = null, AdmissionToken = token,
                    ResumeArtifact = null, RawIntentId = id, Version = 1 };
                await CommitAsync(store, [new(download, null, null)], [], ct);
                await CommitAsync(store, [new(raw with { DownloadId = id, Version = 2 }, 1, null)], [], ct);
                await TargetQueue.ApplyAsync(engine, store, ct);
                var admission = new EngineAdmission(download, candidate, bindings, token);
                var result = handle is null ? await engine.StartAsync(admission, ct)
                    : await engine.AdmitFromProbeAsync(handle, admission, ct);
                if (!result.Accepted) throw new InvalidOperationException(result.Failure?.Message);
                await engine.SaveDevStateAsync(ct);
                return result;
            }
            catch
            {
                await engine.StopAndReleaseFilesAsync(id, CancellationToken.None);
                var persisted = (await store.ListAsync<RawIntentRow>(row => row.Id == id, CancellationToken.None)).SingleOrDefault();
                if (persisted is not null)
                {
                    if (persisted.DownloadId is not null)
                    {
                        await CommitAsync(store, [new(persisted with
                            { DownloadId = null, Version = persisted.Version + 1 }, persisted.Version, null)], [], CancellationToken.None);
                        var download = (await store.ListAsync<DownloadRow>(row => row.Id == id, CancellationToken.None)).SingleOrDefault();
                        if (download is not null)
                            await CommitAsync(store, [], [new(StoreTable.Download,
                                id, download.Version, null)], CancellationToken.None);
                        persisted = persisted with { Version = persisted.Version + 1 };
                    }
                    await CommitAsync(store, [], [new(StoreTable.RawIntent,
                        id, persisted.Version, null)], CancellationToken.None);
                }
                await engine.DeleteTorrentAsync(id, CancellationToken.None);
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

    public async Task RecoverAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var raws = (await store.ListAsync<RawIntentRow>(null, ct)).Where(r => r.Id.StartsWith(Prefix)).ToArray();
            var rows = (await store.ListAsync<DownloadRow>(null, ct)).Where(r => r.Id.StartsWith(Prefix)).ToArray();
            var live = await engine.SnapshotAsync(ct);
            foreach (var row in rows.Where(r => r.FinishedAt is null && live.All(s => s.Hash != r.Hash) &&
                raws.Single(raw => raw.Id == r.RawIntentId).State != RawDownloadState.Publishing))
            {
                var raw = raws.Single(r => r.Id == row.RawIntentId);
                var release = (await store.ListAsync<ReleaseRow>(r => r.Id == row.Hash, ct)).Single();
                var bindings = await engine.MetadataAsync(row.Hash, ct) is { } files ? Bindings(row.Hash, raw.ExplicitDirectory!, files,
                    raw.SelectedFiles.ToArray(), recovery: true) : [];
                await engine.ClaimAdmissionAsync(new(row.AdmissionToken, row.Hash, row.Id, null,
                    DateTimeOffset.UtcNow.AddSeconds(90)), ct);
                await engine.StartAsync(new(row with { Intent = DownloadIntent.Paused },
                    MonoTorrentEngine.CandidateFor(release.Magnet ?? row.Hash, release.TorrentUri), bindings, row.AdmissionToken), ct);
            }
            await TargetQueue.ApplyAsync(engine, store, ct);
            foreach (var raw in raws.Where(r => r.DownloadId is not null && r.State != RawDownloadState.Done))
                await engine.SetIntentAsync(raw.DownloadId!, raw.State is not
                    (RawDownloadState.Paused or RawDownloadState.Publishing), ct);
        }
        finally { gate.Release(); }
    }

    public async Task TickAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var rawRows = (await store.ListAsync<RawIntentRow>(null, ct)).Where(r => r.Id.StartsWith(Prefix)).ToArray();
            if (rawRows.Length == 0) return;
            var snapshots = await engine.SnapshotAsync(ct);
            foreach (var snapshot in snapshots)
            {
                try
                {
                    var raw = rawRows.SingleOrDefault(r => r.Id == snapshot.DownloadId);
                    if (raw is null) continue;
                    var row = (await store.ListAsync<DownloadRow>(d => d.Id == snapshot.DownloadId, ct)).Single();
                    if (snapshot.MetadataAvailable && snapshot.Files.All(f => !f.Selected) && row.FinishedAt is null &&
                        await engine.MetadataAsync(snapshot.Hash, ct) is { } metadata)
                    {
                        await engine.SelectAsync(snapshot.DownloadId, Bindings(snapshot.Hash, raw.ExplicitDirectory!,
                            metadata, raw.SelectedFiles.ToArray(), recovery: true), ct);
                        var findStore = scope.ServiceProvider.GetRequiredService<TargetStore>();
                        var oldRelease = (await findStore.ListAsync<ReleaseRow>(r => r.Id == snapshot.Hash, ct)).Single();
                        await CommitAsync(findStore, [new(oldRelease with
                        {
                            Files = metadata, TotalBytes = metadata.Sum(f => f.Bytes),
                        }, null, oldRelease)], [], ct);
                    }
                    if (snapshot.Complete && raw.State != RawDownloadState.Done)
                    {
                        if (raw.State != RawDownloadState.Publishing)
                        {
                            var publishing = raw with { State = RawDownloadState.Publishing,
                                UpdatedAt = DateTimeOffset.UtcNow, Version = raw.Version + 1 };
                            await CommitAsync(store, [new(publishing, raw.Version, null)], [], ct);
                            raw = publishing;
                        }
                        await PublishAsync(snapshot, raw.ExplicitDirectory!, ct);
                        var done = raw with { State = RawDownloadState.Done,
                            UpdatedAt = DateTimeOffset.UtcNow, Version = raw.Version + 1 };
                        await CommitAsync(store, [new(done, raw.Version, null)], [], ct);
                        raw = done;
                    }
                    var nextIntent = snapshot.Complete ? DownloadIntent.Stopped :
                        raw.State == RawDownloadState.Paused ? DownloadIntent.Paused :
                        snapshot.Active ? DownloadIntent.Run : DownloadIntent.Queued;
                    if (row.Intent != nextIntent || snapshot.Complete && row.FinishedAt is null)
                    {
                        var next = row with { Intent = nextIntent,
                            FinishedAt = snapshot.Complete ? DateTimeOffset.UtcNow : null,
                            Version = row.Version + 1 };
                        await CommitAsync(store, [new(next, row.Version, null)], [], ct);
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Raw download tick failed for {DownloadId}", snapshot.DownloadId);
                }
            }
            var completedSnapshots = snapshots.Select(snapshot => snapshot.DownloadId).ToHashSet(StringComparer.Ordinal);
            var publishingRows = (await store.ListAsync<RawIntentRow>(null, ct))
                .Where(raw => raw.Id.StartsWith(Prefix) && raw.State == RawDownloadState.Publishing &&
                    raw.DownloadId is not null && !completedSnapshots.Contains(raw.DownloadId)).ToArray();
            foreach (var raw in publishingRows)
            {
                try
                {
                    var download = (await store.ListAsync<DownloadRow>(row => row.Id == raw.DownloadId, ct)).Single();
                    var release = (await store.ListAsync<ReleaseRow>(row => row.Id == raw.ReleaseHash, ct)).Single();
                    var metadata = release.Files ?? throw new IOException("The completed torrent file list is missing.");
                    var bindings = Bindings(raw.ReleaseHash, raw.ExplicitDirectory!, metadata,
                        raw.SelectedFiles.ToArray(), recovery: true);
                    CompletePublication(bindings, raw.ExplicitDirectory!, raw.ReleaseHash);
                    var now = DateTimeOffset.UtcNow;
                    await CommitAsync(store, [
                        new(raw with { State = RawDownloadState.Done, UpdatedAt = now,
                            Version = raw.Version + 1 }, raw.Version, null),
                        new(download with { Intent = DownloadIntent.Stopped, FinishedAt = now,
                            Version = download.Version + 1 }, download.Version, null),
                    ], [], ct);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Raw download publication retry failed for {DownloadId}", raw.DownloadId);
                }
            }
        }
        finally { gate.Release(); }
    }

    private async Task PublishAsync(EngineSnapshot snapshot, string root, CancellationToken ct)
    {
        var stopped = await engine.StopAndReleaseFilesAsync(snapshot.DownloadId, ct);
        if (!stopped.WritesDrained || stopped.Failure is not null)
            throw new IOException(stopped.Failure?.Message ?? "The download could not stop writing.");
        RawDownloadFiles.CompletePublication(
            [.. snapshot.Files.Select(file => new FileBinding(file.Index, file.PhysicalPath!, file.Selected))],
            root, snapshot.Hash);
        await engine.SaveDevStateAsync(ct);
    }

    public async Task<object> RemoveAsync(string hash, bool data, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var raw = (await store.ListAsync<RawIntentRow>(row => row.Id == Prefix + hash, ct)).SingleOrDefault();
            if (raw is null) return new { removed = true, files = 0 };
            var paths = await engine.RemoveDevAsync(hash, ct);
            if (data)
            {
                var release = (await store.ListAsync<ReleaseRow>(row => row.Id == hash, ct)).Single();
                if (release.Files is { } metadata)
                    paths = Bindings(hash, raw.ExplicitDirectory!, metadata, raw.SelectedFiles.ToArray(), true)
                        .SelectMany(b => b.Selected ? new[] { b.AbsolutePath, b.AbsolutePath[..^".partial".Length] }
                            : [b.AbsolutePath]).ToImmutableArray();
                RawDownloadFiles.DeletePayload(raw.ExplicitDirectory!, hash, paths);
            }
            var row = (await store.ListAsync<DownloadRow>(download => download.Id == raw.DownloadId, ct)).Single();
            await CommitAsync(store,
                [new(raw with { DownloadId = null, Version = raw.Version + 1 }, raw.Version, null)], [], ct);
            await CommitAsync(store, [], [new(StoreTable.Download, row.Id, row.Version, null)], ct);
            await CommitAsync(store, [], [new(StoreTable.RawIntent, raw.Id, raw.Version + 1, null)], ct);
            await engine.DeleteTorrentAsync(row.Id, ct);
            await engine.SaveDevStateAsync(ct);
            return new { removed = true, files = paths.Length };
        }
        finally { gate.Release(); }
    }

    private static async Task CommitAsync(TargetStore store, IEnumerable<RowWrite> writes,
        IEnumerable<RowDelete> deletes, CancellationToken ct)
    {
        if (!await store.SaveAsync(writes, deletes, ct))
            throw new InvalidOperationException("The download changed during this operation. Retry the action.");
    }

}
