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
    public async Task<TargetSnapshot> ReadAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
        var result = new TargetSnapshot([.. await store.ListAsync<TargetRow>(null, ct)],
            [.. await store.ListAsync<DownloadRow>(null, ct)], await engine.SnapshotAsync(ct),
            [.. (await store.ListAsync<AttemptRow>(null, ct)).Where(a => a.TargetId is not null)],
            [.. await store.ListAsync<ScopeIntentRow>(null, ct)]);
        var raws = await store.ListAsync<RawIntentRow>(null, ct);
        return result with { RawIntents = [.. raws],
            Queue = [.. TargetQueue.Build(result.Downloads,
            [.. await store.ListAsync<DownloadTargetRow>(null, ct)], result.Targets, [.. raws])
            .OrderBy(q => q.Priority).ThenBy(q => q.Rank).ThenBy(q => q.DownloadId, StringComparer.Ordinal)] };
    }

    internal async Task RecoverAsync(CancellationToken ct)
    {
        if (!await CanRunAsync(ct)) return;
        var snapshot = await ReadAsync(ct);
        foreach (var row in snapshot.Targets.Where(t => t.State == TargetState.Searching))
            await ChangeAsync(row.Id, row.LeaseToken, TargetState.Wanted, ct);
        await transfers.RecoverAsync(ChangeTransferAsync, ct);
    }

    internal async Task TickAsync(CancellationToken ct)
    {
        if (!await CanRunAsync(ct)) return;
        foreach (var flight in flights.Where(f => f.Value.IsCompleted)) flights.TryRemove(flight.Key, out _);
        await transfers.TickAsync(ChangeTransferAsync, stateGate, ct);
        var snapshot = await ReadAsync(ct);
        await RecoverStallsAsync(snapshot, ct);
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
        var now = DateTimeOffset.UtcNow;
        snapshot = await ReadAsync(ct);
        var episodes = await store.ListAsync<EpisodeRow>(null, ct);
        var due = TargetQueue.Order(snapshot.Targets.Where(t => t.State == TargetState.Wanted ||
            t.State == TargetState.Waiting && t.NextTryAt <= now &&
                t.ReasonCode != WaitReason.Paused &&
                t.ResumeState is not (TargetState.Filing or TargetState.Fetching)))
            .GroupBy(t => (t.WorkId, SeasonId: t.EpisodeId is null ? null :
                episodes.FirstOrDefault(e => e.Id == t.EpisodeId)?.SeasonId));
        foreach (var group in due)
        {
            if (flights.Count >= maximumScopes) break;
            var groupKey = $"{group.Key.WorkId}:{group.Key.SeasonId ?? "film"}";
            if (flights.ContainsKey(groupKey)) continue;
            var rows = group.ToImmutableArray();
            flights[groupKey] = RunScopeAsync(rows, ct);
        }
        foreach (var intent in snapshot.Scopes.Where(s => s.State == ScopeIntentState.Pending && s.NextTryAt <= now))
        {
            if (flights.Count >= maximumScopes) break;
            var key = "scope:" + intent.Id;
            if (!flights.ContainsKey(key)) flights[key] = MaterializeAsync([intent], ct);
        }
    }

    private async Task MaterializeAsync(IEnumerable<ScopeIntentRow> pending, CancellationToken ct)
    {
        foreach (var intent in pending.Take(1))
        {
            if (!await CanRunAsync(ct)) continue;
            await using var scope = scopes.CreateAsyncScope();
            var result = await scope.ServiceProvider.GetRequiredService<IMetadata>().GetWorkAsync(intent.WorkId, true, ct);
            var work = result.Work;
            var episode = intent.Scope == RequestScope.Episodes ? intent.Episode : null;
            await stateGate.WaitAsync(ct);
            try
            {
                var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
                var current = (await store.ListAsync<ScopeIntentRow>(row => row.Id == intent.Id, ct)).SingleOrDefault();
                if (current is null || current.State != ScopeIntentState.Pending || current.Version != intent.Version) continue;
                if (work is not null && result.Failure is null && !result.Stale)
                foreach (var season in intent.ScopeData.Seasons)
                {
                    var request = (await store.ListAsync<RequestRow>(row => row.Id == intent.ActorUserId, ct)).SingleOrDefault();
                    await AcceptAsync(new(work.Work.Id, season, episode, intent.Policy.ResolutionFloor),
                        intent.ActorUserId, request is null ? IntentOrigin.Owner : IntentOrigin.Request,
                        null, null, null, ct, lockHeld: true, resolved: result);
                }
                var ready = work is not null && result.Failure is null && !result.Stale &&
                    intent.ScopeData.Seasons.All(n => work.Seasons.Any(s => s.Number == n &&
                    s.MappingStatus == MappingStatus.Confirmed && work.Episodes.Any(e => e.SeasonId == s.Id &&
                        (episode is null || e.Number == episode) && e.MappingStatus == MappingStatus.Confirmed) &&
                    work.Episodes.Where(e => e.SeasonId == s.Id && (episode is null || e.Number == episode))
                        .All(e => e.MappingStatus == MappingStatus.Confirmed)));
                await CommitAsync(store, [new(intent with
                {
                    State = ready ? ScopeIntentState.Materialized : ScopeIntentState.Pending,
                    NextTryAt = DateTimeOffset.UtcNow.AddHours(1), UpdatedAt = DateTimeOffset.UtcNow,
                    Version = intent.Version + 1,
                }, intent.Version, null)], [], ct);
            }
            finally { stateGate.Release(); }
        }
    }

    private async Task RunScopeAsync(ImmutableArray<TargetRow> rows, CancellationToken shutdown, bool forceOwner = false)
    {
        if (!await CanRunAsync(shutdown)) return;
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(shutdown);
        var token = Guid.NewGuid().ToString("N");
        try
        {
            var claimed = ImmutableArray.CreateBuilder<TargetRow>();
            foreach (var row in rows)
            {
                var next = await ChangeAsync(row.Id, row.LeaseToken, TargetState.Searching, lifetime.Token,
                    newLease: token, expectedVersion: row.Version);
                if (next is not null)
                {
                    claimed.Add(next);
                    cancellations[row.Id] = lifetime;
                }
            }
            if (claimed.Count == 0) return;
            rows = claimed.ToImmutable();
            await using var scope = scopes.CreateAsyncScope();
            var workResult = await scope.ServiceProvider.GetRequiredService<IMetadata>()
                .GetWorkAsync(rows[0].WorkId, false, lifetime.Token);
            if (workResult.Work is not { } work)
            {
                foreach (var row in rows) await WaitAsync(row, token, WaitReason.MetadataUnavailable,
                    workResult.Failure?.Message ?? "The catalog is unavailable. Trying again later.", lifetime.Token);
                return;
            }
            var targetScope = new TargetScope(work.Work.Id, [.. rows.Where(r => r.EpisodeId is not null).Select(r => r.EpisodeId!)],
                rows[0].EpisodeId is null);
            var library = scope.ServiceProvider.GetRequiredService<ILibraryPlacement>();
            var owned = await library.OwnedAsync(targetScope, lifetime.Token);
            foreach (var row in rows.Where(r => r.Kind == TargetKind.Acquire && owned.Any(o => o.EpisodeId == r.EpisodeId)))
                await ChangeAsync(row.Id, token, TargetState.Done, lifetime.Token);
            rows = [.. rows.Where(r => !owned.Any(o => o.EpisodeId == r.EpisodeId))];
            if (rows.IsEmpty) return;
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var audioLanguage = await GlobalAudioLanguageAsync(store, lifetime.Token);
            var policy = new Policy(rows[0].ResolutionFloor, rows[0].PreferredResolution, audioLanguage,
                rows[0].MaxBytes, null);
            var lane = !forceOwner && rows.All(r => !r.DownloadNow &&
                (r.SubstantiveMisses > 0 || r.Origin is IntentOrigin.Follow or IntentOrigin.Rule or IntentOrigin.Hunter or IntentOrigin.Upgrade))
                ? PriorityLane.Background : PriorityLane.Owner;
            var blocked = await ExcludedAsync(store, work.Work.WorkKey, null, lifetime.Token);
            var result = await discovery.RunAsync(work, targetScope, policy, lane,
                false, lifetime.Token, actualTargets: rows, owned: owned, excludedHashes: blocked);
            var plannedAt = DateTimeOffset.UtcNow;
            await CommitAsync(store, [.. rows.Select(row => new RowWrite(new AttemptRow { Id = $"plan:{row.Id}:{Guid.NewGuid():N}", TargetId = row.Id, WorkId = row.WorkId, ReleaseHash = null, ActorUserId = row.CreatedBy, Kind = AttemptKind.Plan, StartedAt = plannedAt, EndedAt = plannedAt, Outcome = "planned", ReasonCode = null, ReasonText = null, Decision = null, LegacyContext = JsonSerializer.SerializeToElement(new { lane, result.Plan.Assignments, result.Plan.Rejections,
                    result.Plan.UncoveredTargetIds }), BatchId = row.BatchId, DownloadId = null, DeadlineAt = null, Swap = null }, null, null))],
                [], lifetime.Token);
            try
            {
                foreach (var assignment in result.Plan.Assignments)
                {
                    var assigned = rows.Where(r => assignment.TargetIds.Contains(r.Id)).ToImmutableArray();
                    var candidate = result.Find.Candidates.Single(c => c.Release.Id == assignment.Hash);
                    if (candidate.Release.Files is not { } files)
                    {
                        foreach (var row in assigned) await ChangeAsync(row.Id, token, TargetState.Waiting,
                            lifetime.Token, WaitReason.WaitingForSeeders, assignment.Reason, chosen: assignment.Hash);
                        continue;
                    }
                    if (!await CanRunAsync(lifetime.Token)) continue;
                    await transfers.AdmitAsync(work, assigned, assignment, candidate, files,
                        result.Attachments.GetValueOrDefault(assignment.Hash),
                        async (id, state, reason, text) => await ChangeAsync(id, token, state, lifetime.Token,
                            reason, text, chosen: assignment.Hash), stateGate, lifetime.Token);
                }
                foreach (var row in rows.Where(r => result.Plan.UncoveredTargetIds.Contains(r.Id)))
                {
                    var rejection = result.Plan.Rejections.FirstOrDefault(r => r.TargetId == row.Id &&
                        r.Code != "uncovered_item");
                    var waitReason = result.Find.Candidates.IsEmpty ? WaitReason.NoResults :
                        result.WaitingForSeeders ? WaitReason.WaitingForSeeders : WaitReason.RejectedCandidates;
                    await WaitAsync(row, token, waitReason, rejection?.Explanation ??
                        (waitReason == WaitReason.WaitingForSeeders
                            ? "Waiting for a seed or for torrent metadata to become available."
                            : "No eligible release covers this item. Trying again later."), lifetime.Token);
                }
            }
            finally
            {
                foreach (var handle in result.Attachments.Values)
                    await engine.ReleaseProbeAsync(handle, CancellationToken.None);
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Target scope failed");
            foreach (var row in rows)
                await WaitAsync(row, token, WaitReason.SourceFailure,
                    "The download could not start. Trying again later.", CancellationToken.None);
        }
        finally
        {
            await using var cleanup = scopes.CreateAsyncScope();
            var current = await cleanup.ServiceProvider.GetRequiredService<TargetStore>()
                .ListAsync<TargetRow>(null, CancellationToken.None);
            foreach (var row in rows)
            {
                ((ICollection<KeyValuePair<string, CancellationTokenSource>>)cancellations)
                    .Remove(new(row.Id, lifetime));
                if (current.Any(t => t.Id == row.Id && t.LeaseToken == token &&
                    t.State == TargetState.Searching))
                    await ChangeAsync(row.Id, token, TargetState.Wanted, CancellationToken.None);
            }
        }
    }

    private Task<TargetRow?> WaitAsync(TargetRow row, string token, WaitReason reason, string text, CancellationToken ct) =>
        ChangeAsync(row.Id, token, TargetState.Waiting, ct, reason, text);

    private async Task ChangeTransferAsync(string id, TargetState state, WaitReason? reason, string? text, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var row = (await scope.ServiceProvider.GetRequiredService<TargetStore>()
            .ListAsync<TargetRow>(target => target.Id == id, ct)).SingleOrDefault();
        if (row is not null) await ChangeAsync(id, row.LeaseToken, state, ct, reason, text);
    }

    private async Task<bool> CanRunAsync(CancellationToken ct)
    {
        if (schedulerDisabled) return false;
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
        var row = (await store.ListAsync<SettingRow>(setting => setting.Id == "scheduler", ct)).SingleOrDefault();
        var settings = row is null ? null : TorrentFlow.Store.SettingsCatalog.Read<SchedulerSettings>(row);
        return settings is { Enabled: true };
    }

    private sealed class PipelineWorker(TargetPipeline pipeline, ILogger<PipelineWorker> logger) : BackgroundService
    {
        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            await pipeline.RecoverAsync(stoppingToken);
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(500));
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try { await pipeline.TickAsync(stoppingToken); }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
                catch (Exception ex) { logger.LogWarning(ex, "Targets worker tick failed"); }
            }
            await Task.WhenAll(pipeline.flights.Values);
        }
    }
}
