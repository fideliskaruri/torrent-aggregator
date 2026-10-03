using System.Collections.Immutable;
using System.Diagnostics;
using System.Threading.Channels;
using TorrentFlow.Domain;

namespace TorrentFlow.Targets;

public sealed class DiscoveryPlan(IFind find, ICheck check, IPlan planner, IParser parser, CheckOptions options)
{
    public const int ProbeBudget = 24;
    public async Task<DiscoveryResult> RunAsync(WorkSnapshot work, TargetScope scope, Policy policy,
        PriorityLane lane, bool exhaust, CancellationToken cancellationToken,
        Func<CandidateBatch, Task>? onBatch = null,
        ImmutableArray<TargetRow>? actualTargets = null, ImmutableArray<OwnedItem> owned = default,
        Func<TargetState, Task>? onStage = null, ImmutableHashSet<string>? excludedHashes = null)
    {
        var clock = Stopwatch.StartNew();
        var planSeconds = scope.Film ? 28 : scope.EpisodeIds.Length == 1 ? 26 : 54;
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var ct = lifetime.Token;
        using var checkLifetime = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var now = DateTimeOffset.UtcNow;
        var targets = actualTargets ?? (scope.Film ? new string?[] { null } : scope.EpisodeIds.Cast<string?>())
            .Select(id => new TargetRow("dry:" + (id ?? work.Work.Id), work.Work.Id, id,
                TargetKind.Acquire, TargetState.Planning, null, null, null, null, null,
                policy.ResolutionFloor, policy.PreferredResolution, policy.AudioLanguage, policy.MaxBytes,
                false, 0, null, "dev", IntentOrigin.Owner, null, null, null, null, null, now,
                0, null, 0, null, null, now, now, 0)).ToImmutableArray();
        var request = new SearchRequest(Guid.NewGuid().ToString("N"), work, scope, policy, lane,
            SearchNamePhase.English, [], 0, 0) { Exhaust = exhaust };
        var feedback = Channel.CreateBounded<SearchFeedback>(new BoundedChannelOptions(1)
            { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true, SingleWriter = true });
        var probes = Channel.CreateBounded<ProbeRequest>(10);
        var events = Channel.CreateBounded<object>(64);
        var evidence = new Dictionary<string, SwarmEvidence>(StringComparer.OrdinalIgnoreCase);
        var submitted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var pending = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        CandidateBatch? last = null;
        double? firstCandidate = null, firstVerdict = null, ready = null;
        var findEnded = false;
        var probeEnded = false;
        var inputEnded = false;
        var submissions = 0;
        var deadlineReached = false;
        var poolReady = false;
        var sourceSweepReady = false;
        string? stopReason = null;
        var plan = new PlanResult([], [], [.. targets.Select(t => t.Id)]);
        var findTask = PumpFind();
        var checkTask = PumpCheck();
        var deadlineTask = Deadline();
        try
        {
            while (!findEnded || !probeEnded)
            {
                var item = await events.Reader.ReadAsync(ct);
                switch (item)
                {
                    case CandidateBatch batch:
                        batch = batch with { Candidates = [.. batch.Candidates.Where(c =>
                            excludedHashes?.Contains(c.Release.Id) != true &&
                            targets.All(t => (t.MinListedSeeders is null || c.TrustedSeeders >= t.MinListedSeeders) &&
                                (t.PickedReleaseHash is null || c.Release.Id == t.PickedReleaseHash)))] };
                        if (!batch.Candidates.IsEmpty && firstCandidate is null && onStage is not null)
                            await onStage(TargetState.Checking);
                        last = batch;
                        poolReady |= batch.TierComplete || batch.Complete;
                        sourceSweepReady |= batch.Complete || batch.TierComplete && batch.Tier == SourceTier.Fallback;
                        if (!batch.Candidates.IsEmpty) firstCandidate ??= clock.Elapsed.TotalMilliseconds;
                        findEnded = batch.Complete;
                        var hashes = batch.Candidates.Where(c => !submitted.Contains(c.Release.Id))
                            .Select(c => c.Release.Id).ToImmutableArray();
                        foreach (var chunk in hashes.Chunk(500))
                        foreach (var cached in await check.LoadAsync([.. chunk], ct))
                        {
                            if (cached.ExpiresAt <= DateTimeOffset.UtcNow || cached.Band == HealthBand.Unknown &&
                                cached.CheckedAt.AddMinutes(options.UnknownMinutes) <= DateTimeOffset.UtcNow) continue;
                            evidence[cached.Hash] = cached with { FromCache = true };
                            submitted.Add(cached.Hash);
                            firstVerdict ??= clock.Elapsed.TotalMilliseconds;
                        }
                        break;
                    case SwarmEvidence measurement:
                        evidence[measurement.Hash] = measurement;
                        pending.Remove(measurement.Hash);
                        firstVerdict ??= clock.Elapsed.TotalMilliseconds;
                        break;
                    case Exception failure:
                        throw new InvalidOperationException("Discovery or swarm checking failed.", failure);
                    case string:
                        probeEnded = true;
                        break;
                    case bool:
                        deadlineReached = true;
                        stopReason = $"The {planSeconds}-second planning window ended.";
                        inputEnded = true;
                        probes.Writer.TryComplete();
                        await checkLifetime.CancelAsync();
                        pending.Clear();
                        break;
                }
                if (last is null) continue;
                if (onStage is not null) await onStage(TargetState.Planning);
                plan = Choose();
                var goodTargets = GoodTargets();
                var allGood = targets.All(t => goodTargets.Contains(t.Id));
                if (allGood && !exhaust)
                {
                    ready ??= clock.Elapsed.TotalMilliseconds;
                    stopReason = "Every missing item has a gated Good release at the preferred or best available quality.";
                    inputEnded = true;
                    probes.Writer.TryComplete();
                    await checkLifetime.CancelAsync();
                    pending.Clear();
                }
                // Three hashes per uncovered target, shared across pack coverage. Check owns lane admission.
                // Refill only as measurements finish, so large season pools cannot expire in Check's queue.
                if (!inputEnded)
                {
                    foreach (var candidate in last.Candidates
                                 .OrderBy(c => QualityOrder(c))
                                 .ThenBy(CoverageOrder)
                                 .ThenByDescending(c => c.TrustedSeeders ?? -1)
                                 .ThenByDescending(c => c.CoveredEpisodeIds.Length)
                                 .ThenBy(c => c.Release.Id, StringComparer.Ordinal))
                    {
                        if (submissions >= ProbeBudget || !poolReady) break;
                        if (pending.Count >= (lane == PriorityLane.Background ?
                            Math.Clamp(options.BackgroundSlots, 1, 2) : Math.Clamp(options.Slots, 1, 10))) break;
                        if (submitted.Contains(candidate.Release.Id)) continue;
                        if (!sourceSweepReady && candidate.TrustedSeeders is null or <= 0) continue;
                        if (policy.ResolutionFloor is { } floor &&
                            candidate.Release.Parsed.Quality.Resolution is { } resolution && resolution < floor) continue;
                        if (candidate.Release.Parsed is { Unsafe: true } or { Cam: true } or { Sample: true }) continue;
                        var coverage = targets.Where(t => !goodTargets.Contains(t.Id) &&
                            (scope.Film || candidate.CoveredEpisodeIds.Contains(t.EpisodeId!))).ToArray();
                        if (!exhaust && coverage.Length == 0) continue;
                        // Do not spend the singleton budget on items whose preferred pack is still being checked.
                        if (!scope.Film && candidate.CoveredEpisodeIds.Length == 1 && coverage.All(t =>
                            pending.Any(hash => last.Candidates.First(c => c.Release.Id == hash) is { } active &&
                                active.CoveredEpisodeIds.Length > 1 && QualityOrder(active) == 0 &&
                                active.CoveredEpisodeIds.Contains(t.EpisodeId!)))) continue;
                        if (coverage.Length > 0 && coverage.All(t => pending.Count(hash =>
                                last.Candidates.First(c => c.Release.Id == hash) is { } active &&
                                QualityOrder(active) <= QualityOrder(candidate) &&
                                CoverageOrder(active) <= CoverageOrder(candidate) &&
                                (scope.Film || active.CoveredEpisodeIds.Contains(t.EpisodeId!))) >= 3)) continue;
                        submitted.Add(candidate.Release.Id);
                        pending.Add(candidate.Release.Id);
                        submissions++;
                        await probes.Writer.WriteAsync(new(candidate, lane, false, true), ct);
                    }
                    if (findEnded && pending.Count == 0 &&
                        (submissions >= ProbeBudget || !last.Candidates.Any(c => !submitted.Contains(c.Release.Id) &&
                            QualityOrder(c) != int.MaxValue && (exhaust || targets.Any(t =>
                                !goodTargets.Contains(t.Id) && (scope.Film || c.CoveredEpisodeIds.Contains(t.EpisodeId!)))))))
                    {
                        inputEnded = true;
                        stopReason = submissions >= ProbeBudget ? "The 24-probe planning budget was used." :
                            "The source sweep and relevant candidate checks completed.";
                        probes.Writer.TryComplete();
                    }
                }
                if (!findEnded)
                    feedback.Writer.TryWrite(new(last.PoolRevision,
                        allGood && !exhaust ? [.. targets.Where(t => t.EpisodeId is not null).Select(t => t.EpisodeId!)] : [],
                        scope.Film && allGood && !exhaust, !exhaust && allGood,
                        deadlineReached || submissions >= ProbeBudget || pending.Count == 0 && !allGood)
                    {
                        HasHealthyRelease = plan.Assignments.Any(a => evidence.TryGetValue(a.Hash, out var e) &&
                            e.Band is HealthBand.Good or HealthBand.Weak),
                        ScrapedSeeders = evidence.Values.Where(e => e.ScrapedSeeders is not null)
                            .ToImmutableDictionary(e => e.Hash, e => e.ScrapedSeeders!.Value)
                    });
                if (item is CandidateBatch update && onBatch is not null) await onBatch(update);
                if (findEnded && inputEnded && plan.UncoveredTargetIds.IsEmpty)
                    ready ??= clock.Elapsed.TotalMilliseconds;
            }
            plan = Choose();
            return new(last!, [.. evidence.Values], plan,
                new(firstCandidate, firstVerdict, ready, clock.Elapsed.TotalMilliseconds),
                submissions, evidence.Values.Count(e => !e.FromCache && !e.FromLiveTransfer && e.Window > TimeSpan.Zero),
                targets, evidence.Values.Count(e => e.FromCache), stopReason);
        }
        finally
        {
            probes.Writer.TryComplete();
            feedback.Writer.TryComplete();
            await lifetime.CancelAsync();
            await Task.WhenAll(findTask, checkTask, deadlineTask);
        }

        PlanResult Choose(ImmutableArray<Candidate>? pool = null) => planner.Choose(new(work, AcquisitionMode.Catalog, [], targets,
            pool ?? last?.Candidates ?? [], [.. evidence.Values], owned.IsDefault ? [] : owned, [], DateTimeOffset.UtcNow)
        {
            QueriesExhausted = findEnded && (inputEnded || pending.Count == 0),
            UnknownFallbackReason = "Safe files; no checked Good or Weak alternative covers these items. " +
                (deadlineReached ? $"The {planSeconds}-second planning window ended; unchecked alternatives remain. " :
                    submissions >= ProbeBudget ? "The 24-probe budget was used; unchecked alternatives may remain. " :
                    "The source sweep and relevant candidate checks completed. ") + "Waiting for seeders.",
            FileMetadata = [.. evidence.Values.Select(e => new PlanFileMetadata(e.Hash, e.PieceLength,
                ImmutableDictionary<int, ParsedRelease>.Empty))]
        });

        int QualityOrder(Candidate candidate)
        {
            var resolution = candidate.Release.Parsed.Quality.Resolution;
            if (policy.ResolutionFloor is { } floor && resolution is { } known && known < floor ||
                candidate.Release.Parsed is { Unsafe: true } or { Cam: true } or { Sample: true }) return int.MaxValue;
            var preferred = policy.PreferredResolution ?? 1080;
            return resolution == preferred ? 0 : resolution > preferred ? 1 : resolution is not null ? 2 : 3;
        }

        int CoverageOrder(Candidate candidate) =>
            scope.Film || candidate.Release.Parsed.Kind == ReleaseKind.SeasonPack ? 0 :
                candidate.CoveredEpisodeIds.Length > 1 ? 1 : 2;

        HashSet<string> GoodTargets()
        {
            var covered = new HashSet<string>(StringComparer.Ordinal);
            foreach (var candidate in last!.Candidates.Where(c => evidence.TryGetValue(c.Release.Id, out var e) &&
                         e.Band == HealthBand.Good))
            foreach (var assignment in Choose([candidate]).Assignments)
            {
                if (!evidence.TryGetValue(assignment.Hash, out var measured) || measured.Band != HealthBand.Good) continue;
                foreach (var id in assignment.TargetIds)
                {
                    var target = targets.First(t => t.Id == id);
                    var files = measured.Files ?? candidate.Release.Files;
                    var selected = assignment.Files.Where(f => f.TargetId == id && f.Role == FileRole.Video)
                        .Select(f => files?.FirstOrDefault(file => file.Index == f.FileIndex))
                        .Where(f => f is not null).Select(f => parser.Parse(f!.RelativePath).Quality.Resolution).ToArray();
                    var resolution = candidate.Release.Parsed.Quality.Resolution ??
                        (selected.Length > 0 && selected.All(r => r is not null) ? selected.Min() : null);
                    var preferred = target.PreferredResolution ?? 1080;
                    var available = last.Candidates.Where(c => QualityOrder(c) != int.MaxValue &&
                        (scope.Film || c.CoveredEpisodeIds.Contains(target.EpisodeId!)))
                        .Select(c => c.Release.Parsed.Quality.Resolution).OfType<int>().Distinct().ToArray();
                    var best = available.Contains(preferred) ? preferred : available.Where(r => r > preferred)
                        .Order().Cast<int?>().FirstOrDefault() ?? available.Where(r => r < preferred)
                        .OrderDescending().Cast<int?>().FirstOrDefault();
                    if (resolution == preferred || findEnded && resolution is not null && resolution == best)
                        covered.Add(id);
                }
            }
            return covered;
        }

        async Task PumpFind()
        {
            try
            {
                if (targets[0].PickedReleaseHash is { } selectedHash)
                {
                    await events.Writer.WriteAsync(await find.SelectAsync(request, selectedHash, ct), ct);
                    return;
                }
                await foreach (var batch in find.SearchAsync(request, feedback.Reader.ReadAllAsync(ct), ct))
                    await events.Writer.WriteAsync(batch, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
            catch (Exception ex) { events.Writer.TryWrite(ex); }
        }
        async Task PumpCheck()
        {
            try
            {
                await foreach (var measured in check.ProbeStreamAsync(probes.Reader.ReadAllAsync(checkLifetime.Token), checkLifetime.Token))
                    await events.Writer.WriteAsync(measured, ct);
            }
            catch (OperationCanceledException) when (checkLifetime.IsCancellationRequested) { }
            catch (Exception ex) { events.Writer.TryWrite(ex); }
            finally { events.Writer.TryWrite("check-complete"); }
        }
        async Task Deadline()
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(planSeconds), ct);
                await events.Writer.WriteAsync(true, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        }
    }
}

public sealed record DiscoveryTimeline(double? FirstCandidateMs, double? FirstVerdictMs,
    double? PlanReadyMs, double CompleteMs);
public sealed record DiscoveryResult(CandidateBatch Find, ImmutableArray<SwarmEvidence> Evidence,
    PlanResult Plan, DiscoveryTimeline Timeline, int Submissions, int Probes,
    ImmutableArray<TargetRow> Targets, int VerdictCacheHits, string? StopReason);
