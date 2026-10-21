using System.Collections.Immutable;
using System.Threading.Channels;
using TorrentFlow.Domain;

namespace TorrentFlow.Targets;

public sealed class DiscoveryPlan(IFind find, IPlan planner, IEngine engine)
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
            found = await find.SelectAsync(request, picked, cancellationToken);
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
            var onlyUnseeded = pool.Count > 0 && pool.Values.All(c => c.TrustedSeeders is not > 0) &&
                !shortlist.Rejections.IsEmpty && shortlist.Rejections.All(r => r.Code == "minimum_seeders");
            var waitingForSeeders = onlyUnseeded || timedOut && !plan.Rejections.Any(r =>
                r.TargetId is not null && r.Code != "uncovered_item");
            return new(found, plan, attachments.ToImmutableDictionary(StringComparer.OrdinalIgnoreCase),
                waitingForSeeders);
        }
        catch
        {
            foreach (var handle in attachments.Values)
                await engine.ReleaseProbeAsync(handle, CancellationToken.None);
            throw;
        }

        async Task<PlanResult> ProbeCandidates(ImmutableArray<Candidate> ranked)
        {
            foreach (var candidate in ranked.Where(c => c.TrustedSeeders is > 0 &&
                         c.Release.Files is { } files && !files.IsDefaultOrEmpty))
                candidateFiles[candidate.Release.Id] = candidate;

            var ready = ranked.Where(c => candidateFiles.ContainsKey(c.Release.Id))
                .Select(c => candidateFiles[c.Release.Id]).ToImmutableArray();
            var currentPlan = ready.IsEmpty
                ? new PlanResult([], [], [.. targets.Select(t => t.Id)])
                : planner.Choose(input with { Pool = ready });
            var remaining = ranked.Where(c => c.TrustedSeeders is > 0 &&
                !candidateFiles.ContainsKey(c.Release.Id) &&
                !attemptedMetadata.Contains(c.Release.Id)).ToList();
            while (remaining.Count > 0 && remainingProbeBudget > 0 && currentPlan.UncoveredTargetIds.Length > 0)
            {
                var uncovered = currentPlan.UncoveredTargetIds.ToHashSet(StringComparer.Ordinal);
                var batch = remaining.Select((candidate, index) =>
                        (Candidate: candidate, Index: index, Coverage: CoverageCount(candidate, uncovered)))
                    .OrderByDescending(item => item.Coverage).ThenBy(item => item.Index)
                    .Take(Math.Min(MetadataBatchSize, remainingProbeBudget)).Select(item => item.Candidate).ToArray();
                var batchIds = batch.Select(candidate => candidate.Release.Id)
                    .ToHashSet(StringComparer.OrdinalIgnoreCase);
                remaining.RemoveAll(candidate => batchIds.Contains(candidate.Release.Id));
                attemptedMetadata.UnionWith(batchIds);
                remainingProbeBudget -= batch.Length;
                var results = await Task.WhenAll(batch.Select(FetchMetadata));
                foreach (var result in results)
                {
                    timedOut |= result.TimedOut;
                    if (result.Candidate is { } candidate)
                    {
                        candidateFiles[candidate.Release.Id] = candidate;
                        pool[candidate.Release.Id] = pool.TryGetValue(candidate.Release.Id, out var prior)
                            ? Merge(prior, candidate) : candidate;
                        if (result.Handle is { } handle) attachments[candidate.Release.Id] = handle;
                    }
                }
                ready = ranked.Where(c => candidateFiles.ContainsKey(c.Release.Id))
                    .Select(c => candidateFiles[c.Release.Id]).ToImmutableArray();
                if (!ready.IsEmpty) currentPlan = planner.Choose(input with { Pool = ready });
            }
            return currentPlan;
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

        async Task<(Candidate? Candidate, ProbeHandle? Handle, bool TimedOut)> FetchMetadata(Candidate candidate)
        {
            if (candidate.Release.Files is { } existing && !existing.IsDefaultOrEmpty)
                return (candidate, null, false);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(TimeSpan.FromSeconds(60));
            try
            {
                var attachment = await engine.AttachProbeAsync(candidate, deadline.Token);
                if (attachment.Handle is null || attachment.Files is null)
                {
                    if (attachment.Handle is { } unattached)
                        await engine.ReleaseProbeAsync(unattached, CancellationToken.None);
                    return (null, null, attachment.Failure?.Code.Contains("timeout", StringComparison.OrdinalIgnoreCase) == true);
                }
                var updated = candidate with
                {
                    Release = candidate.Release with
                    {
                        Files = attachment.Files,
                        TotalBytes = attachment.Files.Value.Sum(f => f.Bytes),
                    }
                };
                return (updated, attachment.Handle, false);
            }
            catch (OperationCanceledException) when (deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
            {
                return (null, null, true);
            }
        }
    }
}

public sealed record DiscoveryResult(CandidateBatch Find, PlanResult Plan,
    ImmutableDictionary<string, ProbeHandle> Attachments, bool WaitingForSeeders);
