using System.Collections.Immutable;
using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

public sealed partial class TargetPipeline
{
    public async Task<TargetActionReply> RetryFilingAsync(string id, CancellationToken ct)
    {
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var old = (await store.ListAsync<TargetRow>(row => row.Id == id, ct)).SingleOrDefault();
            if (old is null || old.State != TargetState.Filing)
                return new(false, 0, 0, [id], "This download is no longer waiting to be filed.");
            var next = old with { ReasonCode = null, ReasonText = null, NextTryAt = null,
                UpdatedAt = DateTimeOffset.UtcNow, Version = old.Version + 1 };
            await CommitAsync(store, [new(next, old.Version, null)], [], ct);
            return new(true, 0, 0, [id], "Filing will be retried.");
        }
        finally { stateGate.Release(); }
    }

    public async Task<TargetActionReply> ActionAsync(string id, TargetAction action, CancellationToken ct)
    {
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var old = (await store.ListAsync<TargetRow>(row => row.Id == id, ct)).SingleOrDefault();
            if (old is null || old.State == TargetState.Removed && action == TargetAction.Remove)
                return new(true, 0, 0, [], "Removed");
            var links = await store.ListAsync<DownloadTargetRow>(row => row.TargetId == id, ct);
            var hasCurrentDownload = links.Any(link => link.Role == AssociationRole.Current);
            var wasPaused = old.IsPaused();
            var state = action switch
            {
                TargetAction.Remove => TargetState.Removed,
                TargetAction.Pause when old.State != TargetState.Done => TargetState.Waiting,
                TargetAction.Resume when wasPaused => hasCurrentDownload ? TargetState.Fetching : TargetState.Wanted,
                TargetAction.TryNow when old.State == TargetState.Waiting && !wasPaused => TargetState.Wanted,
                TargetAction.DownloadNow when old.State == TargetState.Waiting =>
                    hasCurrentDownload ? TargetState.Fetching : TargetState.Wanted,
                TargetAction.DownloadNow when old.State is TargetState.Wanted or TargetState.Searching => TargetState.Wanted,
                _ => old.State,
            };
            if (old.State == TargetState.Done && action != TargetAction.Remove || old.State == TargetState.Removed ||
                state == old.State && action != TargetAction.DownloadNow &&
                    !(action == TargetAction.TryNow && state == TargetState.Wanted))
                return new(true, 0, 0, [id], state.ToString());
            var next = old with { State = state, ResumeState = null,
                ReasonCode = action == TargetAction.Pause ? WaitReason.Paused : null,
                ReasonText = action == TargetAction.Pause ? "Paused by you." : null,
                NextTryAt = null, LeaseToken = null, LeaseUntil = null,
                UpdatedAt = DateTimeOffset.UtcNow, Version = old.Version + 1 };
            if (action == TargetAction.Remove)
                next = next with { ReplaceMediaFileId = null };
            if (action == TargetAction.DownloadNow)
                next = next with { DownloadNow = true,
                    LeaseToken = state is TargetState.Fetching or TargetState.Filing ? old.LeaseToken : null };
            await CommitAsync(store, [new(next, old.Version, null),
                .. (action == TargetAction.Pause ? [] : links.Where(l =>
                    l.Role != (state == TargetState.Fetching ? AssociationRole.Current : AssociationRole.Retired))).Select(l =>
                    new RowWrite(l with { Role = state == TargetState.Fetching ? AssociationRole.Current : AssociationRole.Retired }, null, l))], [], ct);
            if (!(action == TargetAction.DownloadNow && state is TargetState.Fetching or TargetState.Filing) &&
                cancellations.TryGetValue(id, out var cancellation)) cancellation.Cancel();
            if (state == TargetState.Wanted && action is TargetAction.TryNow or TargetAction.DownloadNow)
                flights["owner:" + id] = RunScopeAsync([next], CancellationToken.None,
                    forceOwner: action == TargetAction.DownloadNow || old.Origin == IntentOrigin.Owner);
            if (action == TargetAction.DownloadNow && await CanRunAsync(ct))
                await TargetQueue.ApplyAsync(engine, store, ct);
            return new(true, 0, 0, [id], state == TargetState.Removed ? "Removed" : state.ToString());
        }

        finally { stateGate.Release(); }
    }

    public async Task<TargetActionReply> BulkActionAsync(TargetAction action, CancellationToken ct)
    {
        if (action is not (TargetAction.Pause or TargetAction.Resume))
            throw new ArgumentException("Choose Pause all or Resume all.");
        var snapshot = await ReadAsync(ct);
        var ids = ImmutableArray.CreateBuilder<string>();
        foreach (var target in snapshot.Targets.Where(t => action == TargetAction.Pause
            ? !t.IsPaused() && t.State is not (TargetState.Done or TargetState.Removed)
            : t.IsPaused()))
        {
            if ((await ActionAsync(target.Id, action, ct)).Accepted) ids.Add(target.Id);
        }
        foreach (var raw in snapshot.RawIntents.Where(r => action == TargetAction.Pause
            ? r.State is not (RawDownloadState.Paused or RawDownloadState.Publishing or
                RawDownloadState.Done or RawDownloadState.Removed)
            : r.State == RawDownloadState.Paused))
        {
            if ((await rawDownloads.PauseAsync(raw.Id, action == TargetAction.Pause, ct)).Accepted)
                ids.Add(raw.Id);
        }
        return new(true, 0, 0, ids.ToImmutable(),
            $"{ids.Count} {(action == TargetAction.Pause ? "paused" : "resumed")}");
    }

    private async Task<TargetRow?> ChangeAsync(string id, string? token, TargetState state, CancellationToken ct,
        WaitReason? reason = null, string? text = null, string? chosen = null, string? newLease = null,
        long? expectedVersion = null)
    {
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var old = (await store.ListAsync<TargetRow>(target => target.Id == id, ct)).SingleOrDefault();
            if (old is null || old.State == TargetState.Removed || old.IsPaused() ||
                expectedVersion is not null && old.Version != expectedVersion ||
                old.LeaseToken != token || old.State == TargetState.Done) return null;
            if (old.State == state)
            {
                if (state != TargetState.Waiting || old.ReasonCode != reason) return null;
                var refreshNow = DateTimeOffset.UtcNow;
                var refreshed = old with { ReasonText = text,
                    NextTryAt = reason == WaitReason.PlacementBlocked ? null : NextTry(old, reason, refreshNow),
                    UpdatedAt = refreshNow, Version = old.Version + 1 };
                return await store.SaveAsync([new(refreshed, old.Version, null)], [], ct) ? refreshed : null;
            }
            if (!Allowed(old.State, state)) return null;
            var now = DateTimeOffset.UtcNow;
            var next = old with { State = state, ReasonCode = reason, ReasonText = text,
                ResumeState = state == TargetState.Waiting ? reason == WaitReason.DriveOffline
                    ? TargetState.Fetching : old.State is TargetState.Filing or TargetState.Fetching
                        ? old.State : TargetState.Wanted : null,
                NextTryAt = state == TargetState.Waiting && reason != WaitReason.PlacementBlocked
                    ? NextTry(old, reason, now) : null,
                ChosenReleaseHash = state == TargetState.Wanted ? null : chosen ?? old.ChosenReleaseHash,
                SubstantiveMisses = old.SubstantiveMisses + (state == TargetState.Waiting &&
                    reason is WaitReason.NoResults or WaitReason.RejectedCandidates or WaitReason.NoHealthyRelease ? 1 : 0),
                LeaseToken = state == TargetState.Wanted ? null : newLease ?? token, LeaseUntil = state == TargetState.Searching
                    ? now.AddSeconds(90) : null, UpdatedAt = now, Version = old.Version + 1 };
            var history = new AttemptRow { Id = Guid.NewGuid().ToString("N"), TargetId = id, WorkId = null, ReleaseHash = chosen ?? old.ChosenReleaseHash, ActorUserId = old.CreatedBy, Kind = AttemptKind.LegacyEvent, StartedAt = now, EndedAt = now, Outcome = state.ToString(), ReasonCode = reason?.ToString(), ReasonText = text, Decision = null, LegacyContext = null, BatchId = null, DownloadId = null, DeadlineAt = null, Swap = null };
            var links = await store.ListAsync<DownloadTargetRow>(link => link.TargetId == id, ct);
            var retire = state is TargetState.Filing or TargetState.Done or TargetState.Waiting or TargetState.Wanted;
            await CommitAsync(store, [new(next, old.Version, null), new(history, null, null),
                .. links.Where(l => retire && l.Role != AssociationRole.Retired ||
                    state == TargetState.Fetching && l.Role == AssociationRole.Retired).Select(l =>
                    new RowWrite(l with { Role = state == TargetState.Fetching ? AssociationRole.Current :
                        AssociationRole.Retired }, null, l))], [], ct);
            return next;
        }
        finally { stateGate.Release(); }
    }

    public async Task WakeStorageWaitsAsync(CancellationToken ct)
    {
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var now = DateTimeOffset.UtcNow;
            var writes = (await store.ListAsync<TargetRow>(target => target.State == TargetState.Waiting &&
                    (target.ReasonCode == WaitReason.DriveOffline ||
                     target.ReasonCode == WaitReason.NoDriveSpace ||
                     target.ReasonCode == WaitReason.PlacementBlocked), ct))
                .Select(target => new RowWrite(target with
                {
                    NextTryAt = now,
                    UpdatedAt = now,
                    Version = target.Version + 1,
                }, target.Version, null)).ToArray();
            if (writes.Length > 0 && !await store.SaveAsync(writes, [], ct))
                throw new InvalidOperationException("Storage waits changed before they could be resumed.");
        }
        finally { stateGate.Release(); }
    }

    public async Task StorageRootOfflineAsync(string rootId, string rootLabel, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
        var downloads = await store.ListAsync<DownloadRow>(row => row.RootId == rootId && row.FinishedAt == null, ct);
        var links = await store.ListAsync<DownloadTargetRow>(null, ct);
        var targets = await store.ListAsync<TargetRow>(null, ct);
        foreach (var download in downloads)
        {
            try { await engine.StopAndReleaseFilesAsync(download.Id, ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex) { logger.LogWarning(ex, "Could not flush download {DownloadId} while its drive went offline", download.Id); }
            foreach (var target in targets.Where(t => links.Any(l =>
                         l.DownloadId == download.Id && l.TargetId == t.Id) &&
                     t.State is TargetState.Fetching or TargetState.Filing))
                await ChangeAsync(target.Id, target.LeaseToken, TargetState.Waiting, ct,
                    WaitReason.DriveOffline, $"Waiting for drive {rootLabel}.");
        }
    }

    public async Task StorageRootOnlineAsync(CancellationToken ct)
    {
        await rawDownloads.RecoverAsync(ct);
        await WakeStorageWaitsAsync(ct);
    }

    private static bool Allowed(TargetState from, TargetState to) => (from, to) switch
    {
        (TargetState.Wanted, TargetState.Searching or TargetState.Waiting or TargetState.Done) => true,
        (TargetState.Searching, TargetState.Fetching or TargetState.Waiting or TargetState.Wanted or TargetState.Done) => true,
        (TargetState.Fetching, TargetState.Filing or TargetState.Waiting or TargetState.Wanted) => true,
        (TargetState.Filing, TargetState.Done or TargetState.Waiting or TargetState.Wanted) => true,
        (TargetState.Waiting, TargetState.Wanted or TargetState.Searching or TargetState.Filing or TargetState.Fetching or TargetState.Done) => true,
        _ => false,
    };

    internal static DateTimeOffset NextTry(TargetRow row, WaitReason? reason, DateTimeOffset now)
    {
        if (row.Origin == IntentOrigin.Owner &&
            reason is WaitReason.NoResults or WaitReason.RejectedCandidates)
        {
            var multiplier = 1 << Math.Clamp(row.SubstantiveMisses, 0, 7);
            return now.AddMinutes(Math.Min(24 * 60, 10 * multiplier));
        }
        if (reason is WaitReason.FileBusy or WaitReason.DownloadCap or WaitReason.NoDriveSpace or WaitReason.DriveOffline)
            return now.AddMinutes(5);
        // Metadata timeouts and source errors are about the network right now, not about how old the title is.
        if (reason is WaitReason.WaitingForSeeders or WaitReason.SourceFailure or WaitReason.MetadataUnavailable)
            return now.AddMinutes(row.Origin is IntentOrigin.Owner or IntentOrigin.Request ? 10 : 45);
        if (row.ExpectedAt is not { } expected)
            return now.AddMinutes(reason == WaitReason.WaitingForSeeders ? 45 : 60);
        if (expected > now) return expected.AddMinutes(5);
        var age = now - expected;
        return now + (age.TotalHours < 2 ? TimeSpan.FromMinutes(5) : age.TotalHours < 12 ? TimeSpan.FromMinutes(15) :
            age.TotalHours < 48 ? TimeSpan.FromHours(1) : age.TotalDays < 7 ? TimeSpan.FromHours(6) : TimeSpan.FromDays(1));
    }

    internal static async Task CommitAsync(TargetStore store, IEnumerable<RowWrite> writes, IEnumerable<RowDelete> deletes,
        CancellationToken ct)
    {
        if (!await store.SaveAsync(writes, deletes, ct))
            throw new InvalidOperationException("The target changed concurrently.");
    }

    private static async Task<string> GlobalAudioLanguageAsync(TargetStore store, CancellationToken ct)
    {
        var row = (await store.ListAsync<SettingRow>(setting => setting.Id == "quality", ct)).SingleOrDefault();
        return row is null ? "auto" : SettingsCatalog.Read<QualitySettings>(row).AudioLanguage ?? "auto";
    }

}
