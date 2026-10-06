using System.Collections.Immutable;
using System.Threading.Channels;
using TorrentFlow.Domain;

namespace TorrentFlow.Targets;

public sealed class DiscoveryPlan(IFind find, IPlan planner, IEngine engine)
{
    private const int MetadataBatchSize = 3;
    private const int MetadataCandidateLimit = 6;

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

        if (targets[0].PickedReleaseHash is { } picked)
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
        var pool = found.Candidates.Where(c => excludedHashes?.Contains(c.Release.Id) != true).ToImmutableArray();
        found = found with { Candidates = pool };
        if (pool.IsEmpty)
            return new(found, new([], [], [.. targets.Select(t => t.Id)]), [], false);

        var input = new PlanInput(work, AcquisitionMode.Catalog, [], targets, pool,
            owned.IsDefault ? [] : owned, [], now) { AudioLanguage = policy.AudioLanguage };
        var shortlist = planner.Shortlist(input);
        if (shortlist.Candidates.IsEmpty)
        {
            var onlyUnseeded = !pool.IsEmpty && pool.All(c => c.TrustedSeeders is not > 0) &&
                !shortlist.Rejections.IsEmpty && shortlist.Rejections.All(r => r.Code == "minimum_seeders");
            return new(found, new([], shortlist.Rejections, [.. targets.Select(t => t.Id)]), [], onlyUnseeded);
        }

        var candidateFiles = new Dictionary<string, Candidate>(StringComparer.OrdinalIgnoreCase);
        var attachments = new Dictionary<string, ProbeHandle>(StringComparer.OrdinalIgnoreCase);
        var timedOut = false;
        PlanResult plan = new([], [], [.. targets.Select(t => t.Id)]);
        try
        {
            var eligible = shortlist.Candidates.Where(c => c.TrustedSeeders is > 0)
                .Take(MetadataCandidateLimit).ToArray();
            if (eligible.Length == 0)
                return new(found, plan, [], true);

            for (var start = 0; start < eligible.Length; start += MetadataBatchSize)
            {
                var batch = eligible.Skip(start).Take(MetadataBatchSize).ToArray();
                var results = await Task.WhenAll(batch.Select(FetchMetadata));
                foreach (var result in results)
                {
                    timedOut |= result.TimedOut;
                    if (result.Candidate is { } candidate)
                    {
                        candidateFiles[candidate.Release.Id] = candidate;
                        if (result.Handle is { } handle) attachments[candidate.Release.Id] = handle;
                    }
                }
                var readyPool = pool.Select(c => candidateFiles.GetValueOrDefault(c.Release.Id) ?? c)
                    .Where(c => candidateFiles.ContainsKey(c.Release.Id)).ToImmutableArray();
                if (readyPool.IsEmpty) continue;
                plan = planner.Choose(input with { Pool = readyPool });
                if (targets.All(t => !plan.UncoveredTargetIds.Contains(t.Id))) break;
            }
            var selected = plan.Assignments.Select(a => a.Hash).ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var unused in attachments.Where(p => !selected.Contains(p.Key)).ToArray())
            {
                await engine.ReleaseProbeAsync(unused.Value, CancellationToken.None);
                attachments.Remove(unused.Key);
            }
            var finalCandidates = pool.Select(c => candidateFiles.GetValueOrDefault(c.Release.Id) ?? c)
                .ToImmutableArray();
            found = found with { Candidates = finalCandidates };
            var waitingForSeeders = timedOut && !plan.Rejections.Any(r =>
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
