using System.Collections.Immutable;
using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;

namespace TorrentFlow.Targets;

public sealed record AcquireInput(string WorkKey, int? Season = null, int? Episode = null,
    int? Quality = null, long? Rank = null);
public sealed record TargetActionReply(bool Accepted, int Queued, int Owned,
    ImmutableArray<string> TargetIds, string Message);
public sealed record TargetSnapshot(ImmutableArray<TargetRow> Targets,
    ImmutableArray<DownloadRow> Downloads, ImmutableArray<EngineSnapshot> Live,
    ImmutableArray<AttemptRow> History, ImmutableArray<ScopeIntentRow> Scopes)
{
    public ImmutableArray<EngineQueueOrder> Queue { get; init; } = [];
}

public sealed partial class TargetPipeline(IServiceScopeFactory scopes, DiscoveryPlan discovery,
    IEngine engine, ILogger<TargetPipeline> logger)
{
    private readonly SemaphoreSlim stateGate = new(1, 1);
    private readonly ConcurrentDictionary<string, Task> flights = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> cancellations = new();
    private readonly TargetTransfers transfers = new(scopes, engine);
    private int maximumScopes = 8;
    private bool schedulerDisabled;

    public static IServiceCollection AddTargets(IServiceCollection services, IConfiguration configuration)
    {
        services.AddSingleton<DiscoveryPlan>();
        services.AddSingleton<TargetPipeline>(sp => new(sp.GetRequiredService<IServiceScopeFactory>(),
            sp.GetRequiredService<DiscoveryPlan>(), sp.GetRequiredService<IEngine>(),
            sp.GetRequiredService<ILogger<TargetPipeline>>())
        {
            maximumScopes = Math.Clamp(configuration.GetValue("TorrentFlow:Targets:MaximumScopes", 8), 1, 8),
            schedulerDisabled = configuration.GetValue<bool>("TorrentFlow:Scheduler:Disabled"),
        });
        services.AddHostedService<PipelineWorker>();
        return services;
    }

    public async Task<TargetActionReply> AcquireAsync(AcquireInput input, string actor, CancellationToken ct)
        => await AcceptAsync(input, actor, IntentOrigin.Owner, null, null, null, ct);

    public Task<TargetActionReply> AcceptAutomationAsync(AcquireInput input, IntentOrigin origin,
        string? ruleId, int? minSeeders, long? maxBytes, CancellationToken ct)
    {
        if (origin is not (IntentOrigin.Follow or IntentOrigin.Rule or IntentOrigin.Hunter))
            throw new ArgumentException("Choose a supported automatic origin.");
        return AcceptAsync(input with { Rank = null }, "local", origin, ruleId, minSeeders, maxBytes, ct);
    }

    public Task<TargetActionReply> AcceptRequestAsync(AcquireInput input, string actor, CancellationToken ct) =>
        AcceptAsync(input, actor, IntentOrigin.Request, null, null, null, ct);

    private async Task<TargetActionReply> AcceptAsync(AcquireInput input, string actor, IntentOrigin origin,
        string? ruleId, int? minSeeders, long? maxBytes, CancellationToken ct, bool lockHeld = false,
        MetadataResult? resolved = null, string? savedAudioLanguage = null)
    {
        if (input.Quality is < 1 or > 4320 || minSeeders is < 0 || maxBytes is <= 0)
            throw new ArgumentException("Choose a valid quality, seed count and size.");
        if (!lockHeld) await stateGate.WaitAsync(ct);
        try
        {
            await using var serviceScope = scopes.CreateAsyncScope();
            var store = serviceScope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var catalog = new CatalogState(store);
            var automatic = origin is IntentOrigin.Follow or IntentOrigin.Rule or IntentOrigin.Hunter;
            var refreshScope = !automatic && input.Season is not null && input.Episode is null;
            resolved ??= await serviceScope.ServiceProvider.GetRequiredService<IMetadata>()
                .GetWorkAsync(input.WorkKey, refreshScope, ct);
            var work = resolved.Work?.Work
                ?? throw new ArgumentException("Open the title before downloading it.");
            var preference = (await catalog.ReadAsync<WorkPreferenceRow>(CatalogState.Query(workId: work.Id), ct)).FirstOrDefault();
            var audioLanguage = savedAudioLanguage ??
                await TargetAudioPolicy.ResolveAsync(store, work, preference, ct);
            input = input with { Quality = input.Quality ?? preference?.ResolutionFloor ?? preference?.PreferredResolution };
            if (work.Kind == WorkKind.Series && input.Season is null ||
                work.Kind == WorkKind.Film && (input.Season is not null || input.Episode is not null))
                throw new ArgumentException("Choose a season for a series, or Download for a film.");
            var film = work.Kind == WorkKind.Film || work.Kind == WorkKind.Unknown && input.Season is null;
            var seasons = await catalog.ReadAsync<SeasonRow>(CatalogState.Query(workId: work.Id), ct);
            var season = seasons.FirstOrDefault(s => s.Number == input.Season);
            var episodes = season is null ? [] : await catalog.ReadAsync<EpisodeRow>(
                CatalogState.Query() with { SeasonId = season.Id }, ct);
            var selected = episodes.Where(e => e.SeasonId == season?.Id &&
                (input.Episode is null || e.Number == input.Episode) && e.MappingStatus == MappingStatus.Confirmed).ToArray();
            var now = DateTimeOffset.UtcNow;
            if (!film && (selected.Length == 0 || refreshScope &&
                (resolved.Failure is not null || resolved.Stale || season?.MappingStatus != MappingStatus.Confirmed ||
                    episodes.Any(e => e.MappingStatus != MappingStatus.Confirmed))))
            {
                if (origin is IntentOrigin.Follow or IntentOrigin.Rule or IntentOrigin.Hunter)
                    throw new ArgumentException("Automatic downloads need confirmed episodes. Try again after metadata refresh.");
                var id = $"scope:{work.Id}:{input.Season}:{input.Episode}";
                var prior = (await store.ReadAsync<ScopeIntentRow>(CatalogState.Query(id), ct)).SingleOrDefault();
                if (prior is null || prior.State == ScopeIntentState.Cancelled)
                {
                    var intent = new ScopeIntentRow(id, actor, work.Id, input.Episode is null ? RequestScope.Seasons : RequestScope.Episodes,
                        new([input.Season ?? 1], false), new(input.Quality, input.Quality ?? 1080, audioLanguage, null, null, 0),
                        false, id, ScopeIntentState.Pending, now, prior?.CreatedAt ?? now, now, (prior?.Version ?? 0) + 1);
                    await CommitAsync(store, [new(intent, prior?.Version, null)], [], ct);
                }
                else if (prior.State == ScopeIntentState.Pending && prior.Policy.AudioLanguage != audioLanguage)
                    await CommitAsync(store, [new(prior with
                    {
                        Policy = prior.Policy with { AudioLanguage = audioLanguage, Revision = prior.Policy.Revision + 1 },
                        UpdatedAt = now, Version = prior.Version + 1,
                    }, prior.Version, null)], [], ct);
                var added = prior is null || prior.State == ScopeIntentState.Cancelled;
                return new(true, added ? 1 : 0, 0, [], added ? "Season queued." : "Already queued");
            }
            var scope = new TargetScope(work.Id, [.. selected.Select(e => e.Id)], film);
            var owned = await serviceScope.ServiceProvider.GetRequiredService<ILibraryPlacement>().OwnedAsync(scope, ct);
            var items = film ? new string?[] { null } : selected.Select(e => (string?)e.Id).ToArray();
            var existing = await catalog.ReadAsync<TargetRow>(CatalogState.Query(workId: work.Id), ct);
            var writes = ImmutableArray.CreateBuilder<RowWrite>();
            var ids = ImmutableArray.CreateBuilder<string>();
            var ownedCount = 0;
            var queued = 0;
            var batch = Guid.NewGuid().ToString("N");
            var changedPolicies = new List<string>();
            foreach (var episodeId in items)
            {
                if (owned.Any(o => o.EpisodeId == episodeId)) { ownedCount++; continue; }
                var old = existing.FirstOrDefault(t => t.EpisodeId == episodeId && t.Kind == TargetKind.Acquire);
                if (old is not null && origin is IntentOrigin.Follow or IntentOrigin.Rule or IntentOrigin.Hunter)
                    continue;
                var id = old?.Id ?? $"target:{work.Id}:{episodeId ?? "film"}";
                ids.Add(id);
                if (old is not null && old.State is not (TargetState.Removed or TargetState.Done))
                {
                    if (old.AudioLanguage != audioLanguage)
                    {
                        var replan = old.State is TargetState.Wanted or TargetState.Waiting or TargetState.Finding or
                            TargetState.Checking or TargetState.Planning;
                        writes.Add(new(old with
                        {
                            AudioLanguage = audioLanguage, PolicyRevision = old.PolicyRevision + 1,
                            State = replan ? TargetState.Wanted : old.State,
                            ReasonCode = replan ? null : old.ReasonCode, ReasonText = replan ? null : old.ReasonText,
                            NextTryAt = replan ? null : old.NextTryAt, LeaseToken = replan ? null : old.LeaseToken,
                            LeaseUntil = replan ? null : old.LeaseUntil,
                            ChosenReleaseHash = replan ? null : old.ChosenReleaseHash,
                            UpdatedAt = now, Version = old.Version + 1,
                        }, old.Version, null));
                        if (replan) changedPolicies.Add(old.Id);
                    }
                    continue;
                }
                var row = old is null
                    ? new TargetRow(id, work.Id, episodeId, TargetKind.Acquire, TargetState.Wanted,
                        null, null, null, null, episodeId is null ? work.DigitalAt ?? work.PhysicalAt ?? work.TheatricalAt :
                            selected.FirstOrDefault(e => e.Id == episodeId)?.AirAt,
                        input.Quality, input.Quality ?? 1080, audioLanguage, maxBytes, input.Rank is not null, input.Rank ?? 0,
                        null, actor, origin, ruleId, null, null, null, batch, now, 0, null, 0,
                        null, null, now, now, 1)
                    : old with { State = TargetState.Wanted, ReasonCode = null, ReasonText = null, NextTryAt = null,
                        ChosenReleaseHash = null, ResumeState = null, LeaseToken = null, LeaseUntil = null,
                        AudioLanguage = audioLanguage,
                        PolicyRevision = old.PolicyRevision + 1, UpdatedAt = now, Version = old.Version + 1 };
                row = row with { Priority = TargetScheduling.Priority(row, now),
                    MinListedSeeders = minSeeders ?? row.MinListedSeeders };
                writes.Add(new(row, old?.Version, null));
                queued++;
                writes.Add(new(new AttemptRow(Guid.NewGuid().ToString("N"), id, work.Id, null, actor,
                    AttemptKind.LegacyEvent, now, now, "Wanted", null, null, null, null, batch, null, null, null), null, null));
            }
            if (writes.Count > 0) await CommitAsync(store, writes.ToImmutable(), [], ct);
            foreach (var id in changedPolicies)
                if (cancellations.TryGetValue(id, out var cancellation)) cancellation.Cancel();
            var message = queued == 0 && ownedCount > 0 ? "Already in your library" :
                queued == 0 && ids.Count > 0 ? "Already queued" :
                ownedCount > 0 ? $"{queued} queued, {ownedCount} already in your library" : $"{queued} queued";
            return new(true, queued, ownedCount, ids.ToImmutable(), message);
        }
        finally { if (!lockHeld) stateGate.Release(); }
    }

    public async Task<TargetActionReply> ActionAsync(string id, TargetAction action, CancellationToken ct)
    {
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var old = (await store.ReadAsync<TargetRow>(CatalogState.Query(id), ct)).SingleOrDefault();
            if (old is null || old.State == TargetState.Removed && action == TargetAction.Remove)
                return new(true, 0, 0, [], "Removed");
            var state = action switch
            {
                TargetAction.Remove => TargetState.Removed,
                TargetAction.Pause when old.State != TargetState.Done => TargetState.Paused,
                TargetAction.Resume when old.State == TargetState.Paused =>
                    old.ResumeState is TargetState.Fetching or TargetState.Filing ? old.ResumeState.Value : TargetState.Wanted,
                TargetAction.TryNow when old.State == TargetState.Waiting => TargetState.Wanted,
                TargetAction.DownloadNow when old.State is TargetState.Waiting or TargetState.Paused =>
                    old.ResumeState is TargetState.Fetching or TargetState.Filing ? old.ResumeState.Value : TargetState.Wanted,
                TargetAction.DownloadNow when old.State is TargetState.Wanted or TargetState.Finding or
                    TargetState.Checking or TargetState.Planning => TargetState.Wanted,
                _ => old.State,
            };
            if (old.State == TargetState.Done && action != TargetAction.Remove || old.State == TargetState.Removed ||
                state == old.State && action != TargetAction.DownloadNow &&
                    !(action == TargetAction.TryNow && state == TargetState.Wanted))
                return new(true, 0, 0, [id], state.ToString());
            var next = old with { State = state, ResumeState = state == TargetState.Paused ? old.State : null,
                ReasonCode = null, ReasonText = null, NextTryAt = null, LeaseToken = null, LeaseUntil = null,
                UpdatedAt = DateTimeOffset.UtcNow, Version = old.Version + 1 };
            if (action == TargetAction.Remove)
                next = next with { ReplaceMediaFileId = null, ReplacementMode = null };
            if (action == TargetAction.DownloadNow)
                next = next with { NowAt = DateTimeOffset.UtcNow, Priority = TargetPriority.Now,
                    LeaseToken = state is TargetState.Fetching or TargetState.Filing ? old.LeaseToken : null };
            var links = await new CatalogState(store).ReadAsync<DownloadTargetRow>(
                CatalogState.Query() with { TargetId = id }, ct);
            var approvals = ImmutableArray.CreateBuilder<RowWrite>();
            if (action == TargetAction.DownloadNow)
            {
                var items = await new CatalogState(store).ReadAsync<RequestItemRow>(CatalogState.Query() with { TargetId = id }, ct);
                foreach (var requestId in items.Select(i => i.RequestId).Distinct())
                {
                    var request = (await store.ReadAsync<RequestRow>(CatalogState.Query(requestId), ct)).Single();
                    if (request.Decision == RequestDecision.Pending)
                        approvals.Add(new(request with { Decision = RequestDecision.Approved, DecidedBy = "local",
                            DecidedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
                            Version = request.Version + 1 }, request.Version, null));
                }
            }
            await CommitAsync(store, [new(next, old.Version, null), .. approvals,
                .. links.Where(l => l.Role != (state == TargetState.Fetching ? AssociationRole.Current : AssociationRole.Retired)).Select(l =>
                    new RowWrite(l with { Role = state == TargetState.Fetching ? AssociationRole.Current : AssociationRole.Retired }, null, l))], [], ct);
            if (!(action == TargetAction.DownloadNow && state is TargetState.Fetching or TargetState.Filing) &&
                cancellations.TryGetValue(id, out var cancellation)) cancellation.Cancel();
            if (state == TargetState.Wanted && action is TargetAction.TryNow or TargetAction.DownloadNow)
                flights["owner:" + id] = RunScopeAsync([next], CancellationToken.None, forceOwner: true);
            if (action == TargetAction.DownloadNow && await CanRunAsync(ct))
            {
                var catalog = new CatalogState(store);
                await engine.ApplyQueueAsync(new([])
                {
                    Order = TargetScheduling.Queue(await catalog.ReadAsync<DownloadRow>(CatalogState.Query(), ct),
                        await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query(), ct),
                        await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct), DateTimeOffset.UtcNow),
                }, ct);
            }
            return new(true, 0, 0, [id], state == TargetState.Removed ? "Removed" : state.ToString());
        }

        finally { stateGate.Release(); }
    }

    public async Task RankAsync(ImmutableArray<string> ids, CancellationToken ct)
    {
        if (ids.IsDefaultOrEmpty || ids.Distinct().Count() != ids.Length)
            throw new ArgumentException("Choose distinct targets.");
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var catalog = new CatalogState(store);
            var rows = await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct);
            if (ids.Any(id => rows.All(t => t.Id != id || t.State == TargetState.Removed)))
                throw new ArgumentException("One of the targets no longer exists.");
            var ranked = ids.Select(id => rows.Single(t => t.Id == id))
                .Concat(TargetScheduling.Order(rows.Where(t => t.OwnerRanked && !ids.Contains(t.Id)), DateTimeOffset.UtcNow));
            var writes = ranked.Select((t, i) => new RowWrite(t with { OwnerRanked = true, Rank = i,
                Priority = t.NowAt is null ? TargetPriority.OwnerRank : TargetPriority.Now,
                UpdatedAt = DateTimeOffset.UtcNow, Version = t.Version + 1 }, t.Version, null)).ToImmutableArray();
            await CommitAsync(store, writes, [], ct);
            if (!await CanRunAsync(ct)) return;
            await engine.ApplyQueueAsync(new([])
            {
                Order = TargetScheduling.Queue(await catalog.ReadAsync<DownloadRow>(CatalogState.Query(), ct),
                    await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query(), ct),
                    await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct), DateTimeOffset.UtcNow),
            }, ct);
        }
        finally { stateGate.Release(); }
    }

    public async Task<TargetSnapshot> ReadAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var catalog = new CatalogState(scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets"));
        var result = new TargetSnapshot(await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct),
            await catalog.ReadAsync<DownloadRow>(CatalogState.Query(), ct), await engine.SnapshotAsync(ct),
            [.. (await catalog.ReadAsync<AttemptRow>(CatalogState.Query(), ct)).Where(a => a.TargetId is not null)],
            await catalog.ReadAsync<ScopeIntentRow>(CatalogState.Query(), ct));
        return result with { Queue = [.. TargetScheduling.Queue(result.Downloads,
            await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query(), ct), result.Targets, DateTimeOffset.UtcNow)
            .OrderBy(q => q.Priority).ThenBy(q => q.Rank).ThenBy(q => q.DownloadId, StringComparer.Ordinal)] };
    }

    internal async Task RecoverAsync(CancellationToken ct)
    {
        if (!await CanRunAsync(ct)) return;
        var snapshot = await ReadAsync(ct);
        foreach (var row in snapshot.Targets.Where(t => t.State is TargetState.Finding or TargetState.Checking or TargetState.Planning))
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
        var now = DateTimeOffset.UtcNow;
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
        var catalog = new CatalogState(store);
        await stateGate.WaitAsync(ct);
        try
        {
            var current = await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct);
            var priorityWrites = current.Where(t => t.Priority != TargetScheduling.Priority(t, now))
                .Select(t => new RowWrite(t with { Priority = TargetScheduling.Priority(t, now),
                    UpdatedAt = now, Version = t.Version + 1 }, t.Version, null)).ToImmutableArray();
            if (!priorityWrites.IsEmpty) await CommitAsync(store, priorityWrites, [], ct);
        }
        finally { stateGate.Release(); }
        snapshot = await ReadAsync(ct);
        var episodes = await catalog.ReadAsync<EpisodeRow>(CatalogState.Query(), ct);
        var due = TargetScheduling.Order(snapshot.Targets.Where(t => t.State == TargetState.Wanted ||
            t.State == TargetState.Waiting && t.NextTryAt <= now &&
                t.ResumeState is not (TargetState.Filing or TargetState.Fetching)), now)
            .GroupBy(t => $"{t.WorkId}:{t.ResolutionFloor}:{t.PreferredResolution}:{t.MinListedSeeders}:{t.MaxBytes}:{t.PickedReleaseHash}:{t.Origin}:" +
                (t.EpisodeId is null ? "film" : episodes.FirstOrDefault(e => e.Id == t.EpisodeId)?.SeasonId));
        foreach (var group in due)
        {
            if (flights.Count >= maximumScopes) break;
            if (flights.ContainsKey(group.Key)) continue;
            var rows = group.ToImmutableArray();
            flights[group.Key] = RunScopeAsync(rows, ct);
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
        if (!await CanRunAsync(ct)) return;
        foreach (var intent in pending.Take(1))
        {
            await using var scope = scopes.CreateAsyncScope();
            var result = await scope.ServiceProvider.GetRequiredService<IMetadata>().GetWorkAsync(intent.WorkId, true, ct);
            var work = result.Work;
            var episode = intent.Scope == RequestScope.Episodes && int.TryParse(intent.Id.Split(':')[^1], out var number)
                ? number : (int?)null;
            await stateGate.WaitAsync(ct);
            try
            {
                var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
                var current = (await store.ReadAsync<ScopeIntentRow>(CatalogState.Query(intent.Id), ct)).SingleOrDefault();
                if (current is null || current.State != ScopeIntentState.Pending || current.Version != intent.Version) continue;
                if (work is not null && result.Failure is null && !result.Stale)
                foreach (var season in intent.ScopeData.Seasons)
                {
                    var request = (await store.ReadAsync<RequestRow>(CatalogState.Query(intent.ActorUserId), ct)).SingleOrDefault();
                    await AcceptAsync(new(work.Work.Id, season, episode, intent.Policy.ResolutionFloor),
                        intent.ActorUserId, request is null ? IntentOrigin.Owner : IntentOrigin.Request,
                        null, null, null, ct, lockHeld: true, resolved: result,
                        savedAudioLanguage: intent.Policy.AudioLanguage);
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
                var next = await ChangeAsync(row.Id, row.LeaseToken, TargetState.Finding, lifetime.Token,
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
            foreach (var row in rows.Where(r => owned.Any(o => o.EpisodeId == r.EpisodeId)))
                await ChangeAsync(row.Id, token, TargetState.Done, lifetime.Token);
            rows = [.. rows.Where(r => !owned.Any(o => o.EpisodeId == r.EpisodeId))];
            if (rows.IsEmpty) return;
            var policy = new Policy(rows[0].ResolutionFloor, rows[0].PreferredResolution, rows[0].AudioLanguage,
                rows[0].MaxBytes, null, rows[0].PolicyRevision);
            var lane = !forceOwner && rows.All(r => r.NowAt is null &&
                (r.SubstantiveMisses > 0 || r.Origin is IntentOrigin.Follow or IntentOrigin.Rule or IntentOrigin.Hunter or IntentOrigin.Upgrade))
                ? PriorityLane.Background : PriorityLane.Owner;
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var blocked = await ExcludedAsync(store, work.Work.Id, null, lifetime.Token);
            var result = await discovery.RunAsync(work, targetScope, policy, lane,
                false, lifetime.Token, actualTargets: rows, owned: owned, onStage: async state =>
                {
                    foreach (var row in rows) await ChangeAsync(row.Id, token, state, lifetime.Token);
                }, excludedHashes: blocked);
            var plannedAt = DateTimeOffset.UtcNow;
            await CommitAsync(store, [.. rows.Select(row => new RowWrite(new AttemptRow(
                $"plan:{row.Id}:{Guid.NewGuid():N}", row.Id, row.WorkId, null, row.CreatedBy,
                AttemptKind.Plan, plannedAt, plannedAt, "planned", null, null, null,
                JsonSerializer.SerializeToElement(new { lane, result.Plan.Assignments, result.Plan.Rejections,
                    result.Plan.UncoveredTargetIds }), row.BatchId, null, null, null), null, null))],
                [], lifetime.Token);
            foreach (var assignment in result.Plan.Assignments)
            {
                var assigned = rows.Where(r => assignment.TargetIds.Contains(r.Id)).ToImmutableArray();
                var candidate = result.Find.Candidates.Single(c => c.Release.Id == assignment.Hash);
                var evidence = result.Evidence.SingleOrDefault(e => e.Hash == assignment.Hash);
                var files = evidence?.Files ?? candidate.Release.Files;
                if (files is null || evidence?.Band == HealthBand.Unknown)
                {
                    foreach (var row in assigned) await ChangeAsync(row.Id, token, TargetState.Waiting,
                        lifetime.Token, WaitReason.WaitingForSeeders, assignment.Reason, chosen: assignment.Hash);
                    continue;
                }
                await transfers.AdmitAsync(work, assigned, assignment, candidate, files.Value, evidence?.AdmissionHandle,
                    async (id, state, reason, text) => await ChangeAsync(id, token, state, lifetime.Token,
                        reason, text, chosen: assignment.Hash), stateGate, lifetime.Token);
            }
            foreach (var row in rows.Where(r => result.Plan.UncoveredTargetIds.Contains(r.Id)))
            {
                var reason = result.Plan.Rejections.FirstOrDefault(r => r.TargetId == row.Id);
                await WaitAsync(row, token, result.Find.Candidates.IsEmpty ? WaitReason.NoResults :
                    WaitReason.RejectedCandidates, reason?.Explanation ??
                    "No checked release covers this item. Trying again later.", lifetime.Token);
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
            var current = await new CatalogState(cleanup.ServiceProvider.GetRequiredKeyedService<IStore>("targets"))
                .ReadAsync<TargetRow>(CatalogState.Query(), CancellationToken.None);
            foreach (var row in rows)
            {
                ((ICollection<KeyValuePair<string, CancellationTokenSource>>)cancellations)
                    .Remove(new(row.Id, lifetime));
                if (current.Any(t => t.Id == row.Id && t.LeaseToken == token &&
                    t.State is TargetState.Finding or TargetState.Checking or TargetState.Planning))
                    await ChangeAsync(row.Id, token, TargetState.Wanted, CancellationToken.None);
            }
        }
    }

    private Task<TargetRow?> WaitAsync(TargetRow row, string token, WaitReason reason, string text, CancellationToken ct) =>
        ChangeAsync(row.Id, token, TargetState.Waiting, ct, reason, text);

    private async Task ChangeTransferAsync(string id, TargetState state, WaitReason? reason, string? text, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var row = (await scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets")
            .ReadAsync<TargetRow>(CatalogState.Query(id), ct)).SingleOrDefault();
        if (row is not null) await ChangeAsync(id, row.LeaseToken, state, ct, reason, text);
    }

    private async Task<TargetRow?> ChangeAsync(string id, string? token, TargetState state, CancellationToken ct,
        WaitReason? reason = null, string? text = null, string? chosen = null, string? newLease = null,
        long? expectedVersion = null)
    {
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var old = (await store.ReadAsync<TargetRow>(CatalogState.Query(id), ct)).SingleOrDefault();
            if (old is null || old.State is TargetState.Removed or TargetState.Paused ||
                expectedVersion is not null && old.Version != expectedVersion ||
                old.LeaseToken != token || old.State == TargetState.Done || old.State == state) return null;
            if (!Allowed(old.State, state)) return null;
            var now = DateTimeOffset.UtcNow;
            var next = old with { State = state, ReasonCode = reason, ReasonText = text,
                Priority = TargetScheduling.Priority(old, now),
                ResumeState = state == TargetState.Waiting ? old.State is TargetState.Filing or TargetState.Fetching
                    ? old.State : TargetState.Wanted : null,
                NextTryAt = state == TargetState.Waiting ? NextTry(old, reason, now) : null,
                ChosenReleaseHash = state == TargetState.Wanted ? null : chosen ?? old.ChosenReleaseHash,
                SubstantiveMisses = old.SubstantiveMisses + (state == TargetState.Waiting &&
                    reason is WaitReason.NoResults or WaitReason.RejectedCandidates or WaitReason.NoHealthyRelease ? 1 : 0),
                LeaseToken = state == TargetState.Wanted ? null : newLease ?? token, LeaseUntil = state is TargetState.Finding or TargetState.Checking or TargetState.Planning
                    ? now.AddSeconds(90) : null, UpdatedAt = now, Version = old.Version + 1 };
            var history = new AttemptRow(Guid.NewGuid().ToString("N"), id, null, chosen ?? old.ChosenReleaseHash,
                old.CreatedBy, AttemptKind.LegacyEvent, now, now, state.ToString(), reason?.ToString(), text, null, null, null, null, null, null);
            var links = await new CatalogState(store).ReadAsync<DownloadTargetRow>(
                CatalogState.Query() with { TargetId = id }, ct);
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

    private static bool Allowed(TargetState from, TargetState to) => (from, to) switch
    {
        (TargetState.Wanted, TargetState.Finding or TargetState.Waiting or TargetState.Done) => true,
        (TargetState.Finding, TargetState.Checking or TargetState.Waiting or TargetState.Wanted or TargetState.Done) => true,
        (TargetState.Checking, TargetState.Planning or TargetState.Waiting or TargetState.Wanted or TargetState.Done) => true,
        (TargetState.Planning, TargetState.Fetching or TargetState.Waiting or TargetState.Wanted or TargetState.Done) => true,
        (TargetState.Fetching, TargetState.Filing or TargetState.Waiting or TargetState.Wanted) => true,
        (TargetState.Filing, TargetState.Done or TargetState.Waiting or TargetState.Wanted) => true,
        (TargetState.Waiting, TargetState.Wanted or TargetState.Finding or TargetState.Filing or TargetState.Fetching or TargetState.Done) => true,
        _ => false,
    };

    private static DateTimeOffset NextTry(TargetRow row, WaitReason? reason, DateTimeOffset now)
    {
        if (reason is WaitReason.FileBusy or WaitReason.DownloadCap or WaitReason.NoDriveSpace or WaitReason.DriveOffline)
            return now.AddMinutes(5);
        if (row.ExpectedAt is not { } expected)
            return now.AddMinutes(reason == WaitReason.WaitingForSeeders ? 45 : 60);
        if (expected > now) return expected.AddMinutes(5);
        var age = now - expected;
        return now + (age.TotalHours < 2 ? TimeSpan.FromMinutes(5) : age.TotalHours < 12 ? TimeSpan.FromMinutes(15) :
            age.TotalHours < 48 ? TimeSpan.FromHours(1) : age.TotalDays < 7 ? TimeSpan.FromHours(6) : TimeSpan.FromDays(1));
    }

    internal static async Task CommitAsync(IStore store, ImmutableArray<RowWrite> writes, ImmutableArray<RowDelete> deletes,
        CancellationToken ct, LibraryWriteProposal? proposal = null)
    {
        var key = Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        var receipt = new AttemptRow("commit:targets:" + key, null, null, null, null, AttemptKind.LegacyEvent,
            now, now, "applied", null, null, null, null, null, null, null, null);
        var result = await store.CommitAsync(new(key, StoreOwner.Targets, writes.Add(new(receipt, null, null)), deletes)
            { LibraryProposal = proposal }, ct);
        if (!result.Applied) throw new InvalidOperationException("The target changed concurrently.");
    }

    private async Task<bool> CanRunAsync(CancellationToken ct)
    {
        if (schedulerDisabled) return false;
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
        var row = (await store.ReadAsync<SettingRow>(CatalogState.Query("scheduler"), ct)).SingleOrDefault();
        var settings = row is null ? null : TorrentFlow.Store.SettingsCatalog.Read<SchedulerSettings>(row);
        return settings is { Enabled: true, FirstFullRootScanComplete: true, ImportReviewComplete: true };
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
