using System.Collections.Immutable;
using System.Threading.Channels;
using TorrentFlow.Domain;

namespace TorrentFlow.Targets;

public sealed class DiscoveryPlan(IFind find, IPlan planner, IEngine engine, ProbeRegistry probes)
{
    private const int MetadataBatchSize = 3;

    public async Task<DiscoveryResult> RunAsync(WorkSnapshot work, TargetScope scope, Policy policy,
        PriorityLane lane, bool exhaust, CancellationToken cancellationToken,
        Func<CandidateBatch, Task>? onBatch = null,
        ImmutableArray<TargetRow>? actualTargets = null, ImmutableArray<OwnedItem> owned = default,
        ImmutableHashSet<string>? excludedHashes = null,
        ImmutableArray<string> sourceIds = default)
    {
        var now = DateTimeOffset.UtcNow;
        var targets = actualTargets ?? (scope.Film ? new string?[] { null } : scope.EpisodeIds.Cast<string?>())
            .Select(id => new TargetRow
            {
                Id = "dry:" + (id ?? work.Work.Id), WorkId = work.Work.Id, EpisodeId = id,
                Kind = TargetKind.Acquire, State = TargetState.Searching, ResolutionFloor = policy.ResolutionFloor,
                PreferredResolution = policy.PreferredResolution,
                MaxBytes = policy.MaxBytes, CreatedBy = "dev", Origin = IntentOrigin.Owner, ClickedAt = now,
                CreatedAt = now, UpdatedAt = now, Version = 0, SubstantiveMisses = 0, DownloadNow = false,
            }).ToImmutableArray();
        var request = new SearchRequest(Guid.NewGuid().ToString("N"), work, scope, policy, lane,
            SearchNamePhase.English, sourceIds.IsDefault ? [] : sourceIds, 0, 0) { Exhaust = exhaust };
        var batches = Channel.CreateUnbounded<SearchFeedback>();
        batches.Writer.TryComplete();
        CandidateBatch? found = null;

        if (targets.Length > 0 && targets[0].PickedReleaseHash is { } picked)
        {
            // An explicit owner pick overrides an earlier find-another block on the same release.
            excludedHashes = excludedHashes?.Remove(picked);
            found = await find.SelectAsync(request, picked, cancellationToken, ownerPick: true);
            if (onBatch is not null) await onBatch(found);
        }
        else
        {
            await foreach (var batch in find.SearchAsync(request, batches.Reader.ReadAllAsync(cancellationToken),
                               cancellationToken))
            {
                found = batch;
                if (onBatch is not null) await onBatch(batch);
            }
        }
        found ??= new(request.SessionId, 0, [], [], true, request.NamePhase, SourceTier.Core);
        var pool = found.Candidates.Where(c => excludedHashes?.Contains(c.Release.Id) != true)
            .DistinctBy(c => c.Release.Id, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(c => c.Release.Id, StringComparer.OrdinalIgnoreCase);
        var input = new PlanInput(work, AcquisitionMode.Catalog, [], targets, [.. pool.Values],
            owned.IsDefault ? [] : owned, [], now) { AudioLanguage = policy.AudioLanguage };
        var candidateFiles = new Dictionary<string, Candidate>(StringComparer.OrdinalIgnoreCase);
        var attachments = new Dictionary<string, ProbeHandle>(StringComparer.OrdinalIgnoreCase);
        var attemptedMetadata = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var timedOut = false;
        var metadataDeadline = (DateTimeOffset?)null;
        var metadataWait = targets.Any(t => t.Origin is IntentOrigin.Owner or IntentOrigin.Request)
            ? TimeSpan.FromSeconds(12) : TimeSpan.FromSeconds(60);
        var pendingProbes = new Dictionary<ProbeTicket, Candidate>();
        PlanResult plan = new([], [], [.. targets.Select(t => t.Id)]);
        var shortlist = planner.Shortlist(input);
        var remainingProbeBudget = Math.Clamp(3 * Math.Max(targets.Length, 1), 6, 24);
        try
        {
            plan = shortlist.Candidates.IsEmpty
                ? new([], shortlist.Rejections, [.. targets.Select(t => t.Id)])
                : await ProbeCandidates(shortlist.Candidates);
            if (!scope.Film && targets.All(t => t.PickedReleaseHash is null) &&
                plan.UncoveredTargetIds.Length is > 0 and <= 6)
            {
                var uncovered = plan.UncoveredTargetIds.ToHashSet(StringComparer.Ordinal);
                var episodeIds = targets.Where(t => uncovered.Contains(t.Id) && t.EpisodeId is not null)
                    .Select(t => t.EpisodeId!).Distinct(StringComparer.Ordinal).ToImmutableArray();
                if (!episodeIds.IsEmpty)
                {
                    var secondRequest = request with
                    {
                        SessionId = Guid.NewGuid().ToString("N"),
                        Scope = scope with { EpisodeIds = episodeIds, Film = false },
                    };
                    var secondBatches = new List<CandidateBatch>();
                    await foreach (var batch in find.SearchAsync(secondRequest,
                                       batches.Reader.ReadAllAsync(cancellationToken), cancellationToken))
                    {
                        secondBatches.Add(batch);
                        if (onBatch is not null) await onBatch(batch);
                    }
                    if (secondBatches.Count > 0)
                    {
                        var last = secondBatches[^1];
                        foreach (var candidate in last.Candidates
                                     .Where(c => excludedHashes?.Contains(c.Release.Id) != true))
                        {
                            if (pool.TryGetValue(candidate.Release.Id, out var prior))
                                pool[candidate.Release.Id] = Merge(prior, candidate);
                            else pool[candidate.Release.Id] = candidate;
                        }
                        found = found with
                        {
                            PoolRevision = Math.Max(found.PoolRevision, last.PoolRevision),
                            Candidates = [.. pool.Values],
                            Sources = [.. found.Sources.Concat(last.Sources)],
                            Rejections = [.. found.Rejections.Concat(last.Rejections)
                                .DistinctBy(r => $"{r.Hash}:{r.Name}:{r.SourceId}:{r.Query}:{r.Code}")],
                            Queries = [.. found.Queries.Concat(last.Queries)
                                .DistinctBy(q => $"{q.Query}:{q.SourceId}:{q.NamePhase}:{q.Tier}")],
                            Complete = last.Complete,
                            Tier = last.Tier,
                            TierComplete = last.TierComplete,
                            FirstCandidateAt = found.FirstCandidateAt ?? last.FirstCandidateAt,
                            Elapsed = found.Elapsed + last.Elapsed,
                            SourceRequests = found.SourceRequests + last.SourceRequests,
                            WindowSourceRequests = found.WindowSourceRequests + last.WindowSourceRequests,
                            RequestBudgetExhausted = found.RequestBudgetExhausted || last.RequestBudgetExhausted,
                        };
                        remainingProbeBudget += 6;
                        shortlist = planner.Shortlist(input with { Pool = [.. pool.Values] });
                        plan = shortlist.Candidates.IsEmpty
                            ? new([], shortlist.Rejections, [.. targets.Select(t => t.Id)])
                            : await ProbeCandidates(shortlist.Candidates);
                    }
                }
            }
            var selected = plan.Assignments.Select(a => a.Hash).ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var unused in attachments.Where(p => !selected.Contains(p.Key)).ToArray())
            {
                await engine.ReleaseProbeAsync(unused.Value, CancellationToken.None);
                attachments.Remove(unused.Key);
            }
            var finalCandidates = pool.Values.Select(c => candidateFiles.GetValueOrDefault(c.Release.Id) ?? c)
                .ToImmutableArray();
            found = found with { Candidates = finalCandidates };
            // Eligible copies exist but none has a seed: that is a wait for seeders, not "nothing fits".
            var eligibleUnseeded = plan.Assignments.IsEmpty && !shortlist.Candidates.IsEmpty &&
                shortlist.Candidates.All(c => c.TrustedSeeders is not > 0);
            var onlyUnseeded = eligibleUnseeded || pool.Count > 0 && pool.Values.All(c => c.TrustedSeeders is not > 0) &&
                !shortlist.Rejections.IsEmpty && shortlist.Rejections.All(r => r.Code == "minimum_seeders");
            var waitingForSeeders = onlyUnseeded || timedOut && !plan.Rejections.Any(r =>
                r.TargetId is not null && r.Code != "uncovered_item");
            // Nothing was probed and nobody is waiting: surface why the shortlist refused the rest.
            if (!waitingForSeeders && plan.Assignments.IsEmpty && plan.Rejections.IsEmpty && !shortlist.Rejections.IsEmpty)
                plan = plan with { Rejections = shortlist.Rejections };
            return new(found, plan, attachments.ToImmutableDictionary(StringComparer.OrdinalIgnoreCase),
                waitingForSeeders, timedOut);
        }
        catch
        {
            foreach (var handle in attachments.Values)
                await engine.ReleaseProbeAsync(handle, CancellationToken.None);
            throw;
        }

        async Task<PlanResult> ProbeCandidates(ImmutableArray<Candidate> ranked)
        {
            foreach (var candidate in ranked.Where(c => (c.TrustedSeeders is > 0 ||
                         targets.All(t => t.PickedReleaseHash == c.Release.Id)) &&
                         c.Release.Files is { } files && !files.IsDefaultOrEmpty))
                candidateFiles[candidate.Release.Id] = candidate;

            var remaining = ranked.Where(NeedsMetadata).ToList();
            var currentPlan = PlanReady(ranked);
            try
            {
                while (true)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (!currentPlan.Assignments.IsEmpty && currentPlan.UncoveredTargetIds.IsEmpty &&
                        !HasHigherPendingCandidate(ranked, currentPlan))
                        break;

                    LaunchProbes(remaining, ranked, currentPlan);
                    if (pendingProbes.Count == 0) break;

                    var wait = metadataDeadline!.Value - DateTimeOffset.UtcNow;
                    if (wait <= TimeSpan.Zero)
                    {
                        timedOut = true;
                        break;
                    }

                    var timer = Task.Delay(wait, cancellationToken);
                    var completed = await Task.WhenAny(pendingProbes.Keys.Select(ticket => (Task)ticket.Completion)
                        .Append(timer));
                    cancellationToken.ThrowIfCancellationRequested();
                    if (completed == timer)
                    {
                        timedOut = pendingProbes.Count > 0;
                        break;
                    }

                    var ticket = pendingProbes.Keys.First(key => ReferenceEquals(key.Completion, completed));
                    var candidate = pendingProbes[ticket];
                    pendingProbes.Remove(ticket);
                    var attachment = await probes.TakeAsync(ticket);
                    timedOut |= attachment.Failure?.Code.Contains("timeout", StringComparison.OrdinalIgnoreCase) == true;
                    if (attachment.Files is { } files && !files.IsDefaultOrEmpty)
                    {
                        var updated = candidate with
                        {
                            Release = candidate.Release with
                            {
                                Files = files,
                                TotalBytes = files.Sum(file => file.Bytes),
                            }
                        };
                        candidateFiles[updated.Release.Id] = updated;
                        pool[updated.Release.Id] = pool.TryGetValue(updated.Release.Id, out var prior)
                            ? Merge(prior, updated) : updated;
                        if (attachment.Handle is { } handle) attachments[updated.Release.Id] = handle;
                    }
                    else if (attachment.Handle is { } unused)
                        await engine.ReleaseProbeAsync(unused, CancellationToken.None);
                    currentPlan = PlanReady(ranked);
                }
            }
            finally
            {
                foreach (var ticket in pendingProbes.Keys)
                    await probes.AbandonAsync(ticket);
                pendingProbes.Clear();
            }
            return currentPlan;
        }

        void LaunchProbes(List<Candidate> remaining, ImmutableArray<Candidate> ranked, PlanResult currentPlan)
        {
            var uncovered = currentPlan.UncoveredTargetIds.ToHashSet(StringComparer.Ordinal);
            var blockers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (uncovered.Count == 0)
            {
                foreach (var assignment in currentPlan.Assignments)
                {
                    var selectedIndex = IndexOf(ranked, assignment.Hash);
                    if (selectedIndex <= 0) continue;
                    var assignedTargets = assignment.TargetIds.ToHashSet(StringComparer.Ordinal);
                    foreach (var candidate in ranked.Take(selectedIndex).Where(NeedsMetadata))
                    {
                        if (CoverageCount(candidate, assignedTargets) == 0) continue;
                        blockers.Add(candidate.Release.Id);
                        uncovered.UnionWith(assignment.TargetIds);
                    }
                }
            }
            if (uncovered.Count == 0) return;
            if (metadataDeadline is null)
                metadataDeadline = DateTimeOffset.UtcNow.Add(metadataWait);
            while (pendingProbes.Count < MetadataBatchSize && remainingProbeBudget > 0)
            {
                var next = remaining.Select((candidate, index) =>
                        (Candidate: candidate, Index: index, Coverage: CoverageCount(candidate, uncovered)))
                    .Where(item => item.Coverage > 0 &&
                        (blockers.Count == 0 || blockers.Contains(item.Candidate.Release.Id)))
                    .OrderByDescending(item => item.Coverage).ThenBy(item => item.Index)
                    .FirstOrDefault();
                if (next.Candidate is null) break;
                remaining.Remove(next.Candidate);
                attemptedMetadata.Add(next.Candidate.Release.Id);
                remainingProbeBudget--;
                pendingProbes.Add(probes.Start(next.Candidate), next.Candidate);
            }
        }

        static int IndexOf(ImmutableArray<Candidate> ranked, string hash)
        {
            for (var index = 0; index < ranked.Length; index++)
                if (string.Equals(ranked[index].Release.Id, hash, StringComparison.OrdinalIgnoreCase))
                    return index;
            return -1;
        }

        PlanResult PlanReady(ImmutableArray<Candidate> ranked)
        {
            var ready = ranked.Where(c => candidateFiles.ContainsKey(c.Release.Id))
                .Select(c => candidateFiles[c.Release.Id]).ToImmutableArray();
            return ready.IsEmpty
                ? new([], [], [.. targets.Select(t => t.Id)])
                : planner.Choose(input with { Pool = ready });
        }

        bool NeedsMetadata(Candidate candidate) => (candidate.TrustedSeeders is > 0 ||
                targets.All(t => t.PickedReleaseHash == candidate.Release.Id)) &&
            !candidateFiles.ContainsKey(candidate.Release.Id) &&
            !attemptedMetadata.Contains(candidate.Release.Id);

        bool HasHigherPendingCandidate(ImmutableArray<Candidate> ranked, PlanResult currentPlan)
        {
            if (remainingProbeBudget <= 0) return false;
            foreach (var assignment in currentPlan.Assignments)
            {
                var selectedIndex = IndexOf(ranked, assignment.Hash);
                if (selectedIndex <= 0) continue;
                var assignedTargets = assignment.TargetIds.ToHashSet(StringComparer.Ordinal);
                if (ranked.Take(selectedIndex).Any(candidate => NeedsMetadata(candidate) &&
                        CoverageCount(candidate, assignedTargets) > 0))
                    return true;
            }
            return false;
        }

        int CoverageCount(Candidate candidate, HashSet<string> uncovered)
        {
            return targets.Where(t => uncovered.Contains(t.Id) &&
                    (candidate.CoveredEpisodeIds.Contains(t.Id, StringComparer.Ordinal) ||
                     Covers(candidate.Release.Parsed, t)))
                .Select(t => t.Id).Distinct(StringComparer.Ordinal).Count();
        }

        bool Covers(ParsedRelease parsed, TargetRow target)
        {
            if (target.EpisodeId is null || parsed.ThreeDigitSceneEpisode) return false;
            var episode = work.Episodes.FirstOrDefault(e => e.Id == target.EpisodeId);
            if (episode is null) return false;
            var season = work.Seasons.FirstOrDefault(s => s.Id == episode.SeasonId);
            if (season is null) return false;
            if (parsed.Seasons.Contains(season.Number))
                return parsed.Pack || parsed.Episodes.Contains(episode.Number) ||
                    parsed.EpisodeRanges.Any(r => episode.Number >= r.First && episode.Number <= r.Last);
            if (!parsed.Seasons.IsEmpty) return false;
            if (parsed.Kind == ReleaseKind.CompleteSeries) return true;
            return work.Work.Anime == true && episode.AbsoluteNumber is { } absolute &&
                (parsed.AbsoluteNumbers.Contains(absolute) ||
                 parsed.AbsoluteRanges.Any(r => absolute >= r.First && absolute <= r.Last));
        }

        static Candidate Merge(Candidate prior, Candidate incoming)
        {
            var files = prior.Release.Files is { } priorFiles && !priorFiles.IsDefaultOrEmpty
                ? prior.Release.Files : incoming.Release.Files;
            return prior with
            {
                Release = prior.Release with
                {
                    Files = files,
                    TotalBytes = prior.Release.TotalBytes > 0 ? prior.Release.TotalBytes : incoming.Release.TotalBytes,
                },
                Observations = [.. prior.Observations.Concat(incoming.Observations).DistinctBy(o => o.Id)],
                CoveredEpisodeIds = [.. prior.CoveredEpisodeIds.Union(incoming.CoveredEpisodeIds)],
                CoversFilm = prior.CoversFilm || incoming.CoversFilm,
                ConservativeListedSeeders = prior.ConservativeListedSeeders ?? incoming.ConservativeListedSeeders,
                ScrapedSeeders = prior.ScrapedSeeders ?? incoming.ScrapedSeeders,
            };
        }

    }
}

public sealed record DiscoveryResult(CandidateBatch Find, PlanResult Plan,
    ImmutableDictionary<string, ProbeHandle> Attachments, bool WaitingForSeeders, bool MetadataTimedOut);
