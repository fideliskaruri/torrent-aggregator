using System.Collections.Immutable;
using System.Diagnostics;
using System.Threading.Channels;
using TorrentFlow.Domain;

namespace TorrentFlow.Api;

// Phase 4 moves this composition to Targets; module policy remains in Find, Check and Plan.
internal sealed class DiscoveryPlan(IFind find, ICheck check, IPlan planner, IParser parser, CheckOptions options)
{
    internal async Task<DiscoveryResult> RunAsync(WorkSnapshot work, TargetScope scope, Policy policy,
        PriorityLane lane, bool exhaust, CancellationToken cancellationToken,
        Func<CandidateBatch, Task>? onBatch = null)
    {
        var clock = Stopwatch.StartNew();
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var ct = lifetime.Token;
        var now = DateTimeOffset.UtcNow;
        var targets = (scope.Film ? new string?[] { null } : scope.EpisodeIds.Cast<string?>())
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
        var plan = new PlanResult([], [], [.. targets.Select(t => t.Id)]);
        var findTask = PumpFind();
        var checkTask = PumpCheck();
        try
        {
            while (!findEnded || !probeEnded)
            {
                var item = await events.Reader.ReadAsync(ct);
                switch (item)
                {
                    case CandidateBatch batch:
                        last = batch;
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
                }
                if (last is null) continue;
                plan = Choose();
                var goodTargets = PreferredGoodTargets(plan);
                var allGood = targets.All(t => goodTargets.Contains(t.Id));
                if (allGood)
                    ready ??= clock.Elapsed.TotalMilliseconds;
                // Three hashes per uncovered target, shared across pack coverage. Check owns lane admission.
                // Refill only as measurements finish, so large season pools cannot expire in Check's queue.
                if (!inputEnded)
                {
                    foreach (var candidate in last.Candidates.OrderByDescending(c => c.TrustedSeeders ?? -1)
                                 .ThenBy(c => c.Release.Id, StringComparer.Ordinal))
                    {
                        if (pending.Count >= (lane == PriorityLane.Background ?
                            Math.Clamp(options.BackgroundSlots, 1, 2) : Math.Clamp(options.Slots, 1, 10))) break;
                        if (submitted.Contains(candidate.Release.Id)) continue;
                        var coverage = targets.Where(t => !goodTargets.Contains(t.Id) &&
                            (scope.Film || candidate.CoveredEpisodeIds.Contains(t.EpisodeId!))).ToArray();
                        if (!exhaust && coverage.Length == 0) continue;
                        if (coverage.Length > 0 && coverage.All(t => pending.Count(hash =>
                                scope.Film || last.Candidates.First(c => c.Release.Id == hash)
                                    .CoveredEpisodeIds.Contains(t.EpisodeId!)) >= 3)) continue;
                        submitted.Add(candidate.Release.Id);
                        pending.Add(candidate.Release.Id);
                        submissions++;
                        await probes.Writer.WriteAsync(new(candidate, lane, false, true), ct);
                    }
                    if (!findEnded)
                        feedback.Writer.TryWrite(new(last.PoolRevision,
                            allGood && !exhaust ? [.. targets.Where(t => t.EpisodeId is not null).Select(t => t.EpisodeId!)] : [],
                            scope.Film && allGood && !exhaust, !exhaust && allGood, pending.Count == 0 && !allGood)
                        {
                            ScrapedSeeders = evidence.Values.Where(e => e.ScrapedSeeders is not null)
                                .ToImmutableDictionary(e => e.Hash, e => e.ScrapedSeeders!.Value)
                        });
                    if (item is CandidateBatch update && onBatch is not null) await onBatch(update);
                    if (findEnded && pending.Count == 0)
                    {
                        inputEnded = true;
                        probes.Writer.TryComplete();
                        if (plan.UncoveredTargetIds.IsEmpty) ready ??= clock.Elapsed.TotalMilliseconds;
                    }
                }
            }
            plan = Choose();
            return new(last!, [.. evidence.Values], plan,
                new(firstCandidate, firstVerdict, ready, clock.Elapsed.TotalMilliseconds),
                submissions, evidence.Values.Count(e => !e.FromCache && !e.FromLiveTransfer && e.Window > TimeSpan.Zero),
                targets, evidence.Values.Count(e => e.FromCache));
        }
        finally
        {
            probes.Writer.TryComplete();
            feedback.Writer.TryComplete();
            await lifetime.CancelAsync();
            await Task.WhenAll(findTask, checkTask);
        }

        PlanResult Choose() => planner.Choose(new(work, AcquisitionMode.Catalog, [], targets,
            last?.Candidates ?? [], [.. evidence.Values], [], [], DateTimeOffset.UtcNow)
        {
            QueriesExhausted = findEnded,
            FileMetadata = [.. evidence.Values.Select(e => new PlanFileMetadata(e.Hash, e.PieceLength,
                ImmutableDictionary<int, ParsedRelease>.Empty))]
        });

        HashSet<string> PreferredGoodTargets(PlanResult result)
        {
            var covered = new HashSet<string>(StringComparer.Ordinal);
            foreach (var assignment in result.Assignments)
            {
                if (!evidence.TryGetValue(assignment.Hash, out var measured) || measured.Band != HealthBand.Good) continue;
                var candidate = last!.Candidates.First(c => c.Release.Id == assignment.Hash);
                foreach (var id in assignment.TargetIds)
                {
                    var target = targets.First(t => t.Id == id);
                    var files = measured.Files ?? candidate.Release.Files;
                    var selected = assignment.Files.Where(f => f.TargetId == id && f.Role == FileRole.Video)
                        .Select(f => files?.FirstOrDefault(file => file.Index == f.FileIndex))
                        .Where(f => f is not null).Select(f => parser.Parse(f!.RelativePath).Quality.Resolution).ToArray();
                    var resolution = candidate.Release.Parsed.Quality.Resolution ??
                        (selected.Length > 0 && selected.All(r => r is not null) ? selected.Min() : null);
                    if (resolution == (target.PreferredResolution ?? 1080) ||
                        target.ResolutionFloor is { } floor && resolution >= floor)
                        covered.Add(id);
                }
            }
            return covered;
        }

        async Task PumpFind()
        {
            try
            {
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
                await foreach (var measured in check.ProbeStreamAsync(probes.Reader.ReadAllAsync(ct), ct))
                    await events.Writer.WriteAsync(measured, ct);
                await events.Writer.WriteAsync("check-complete", ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
            catch (Exception ex) { events.Writer.TryWrite(ex); }
        }
    }
}

internal sealed record DiscoveryTimeline(double? FirstCandidateMs, double? FirstVerdictMs,
    double? PlanReadyMs, double CompleteMs);
internal sealed record DiscoveryResult(CandidateBatch Find, ImmutableArray<SwarmEvidence> Evidence,
    PlanResult Plan, DiscoveryTimeline Timeline, int Submissions, int Probes,
    ImmutableArray<TargetRow> Targets, int VerdictCacheHits);
