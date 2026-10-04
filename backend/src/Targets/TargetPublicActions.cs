using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

public sealed partial class TargetPipeline
{
    public async Task<TargetActionReply> PickAsync(string targetId, string releaseHash, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(targetId) || string.IsNullOrWhiteSpace(releaseHash))
            throw new ArgumentException("Choose a target and a release from the search results.");
        releaseHash = releaseHash.Trim().ToLowerInvariant();
        if (releaseHash.Length is not (40 or 64) || releaseHash.Any(c => !Uri.IsHexDigit(c)))
            throw new ArgumentException("Choose a release from the search results.");
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var target = (await store.ListAsync<TargetRow>(row => row.Id == targetId, ct)).SingleOrDefault()
                ?? throw new ArgumentException("This target no longer exists.");
            if (target.State is TargetState.Fetching or TargetState.Filing or TargetState.Done or TargetState.Removed ||
                target.ResumeState is TargetState.Fetching or TargetState.Filing)
                throw new ArgumentException("Pick a release for an item still waiting to download.");
            var release = (await store.ListAsync<ReleaseRow>(row => row.Id == releaseHash, ct)).SingleOrDefault()
                ?? throw new ArgumentException("That release is no longer in the search results. Search again.");
            if (release.Parsed.Unsafe || release.Parsed.Cam || release.Parsed.Sample ||
                target.ResolutionFloor is { } floor &&
                    (release.Parsed.Quality.Resolution is not { } resolution || resolution < floor))
                throw new ArgumentException("This release does not meet the title's safety or quality requirements.");
            if (target.PickedReleaseHash == releaseHash && target.State == TargetState.Wanted)
                return new(true, 1, 0, [targetId], "1 queued");
            var now = DateTimeOffset.UtcNow;
            var next = target with { PickedReleaseHash = releaseHash, ChosenReleaseHash = null,
                State = TargetState.Wanted, ResumeState = null, ReasonCode = null, ReasonText = null,
                NextTryAt = null, LeaseToken = null, LeaseUntil = null,
                PolicyRevision = target.PolicyRevision + 1, UpdatedAt = now, Version = target.Version + 1 };
            await CommitAsync(store, [new(next, target.Version, null)], [], ct);
            if (cancellations.TryGetValue(targetId, out var cancellation)) cancellation.Cancel();
            return new(true, 1, 0, [targetId], "1 queued");
        }
        finally { stateGate.Release(); }
    }

    public async Task<TargetActionReply> SetQualityAsync(string workOrTargetId, int? quality, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(workOrTargetId)) throw new ArgumentException("Choose a title or target.");
        if (quality is < 1 or > 4320) throw new ArgumentException("Choose a resolution between 1 and 4320.");
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var all = await store.ListAsync<TargetRow>(null, ct);
            var target = all.FirstOrDefault(t => t.Id == workOrTargetId);
            var works = await store.ListAsync<WorkRow>(null, ct);
            var work = works.FirstOrDefault(w => w.Id == (target?.WorkId ?? workOrTargetId) || w.WorkKey == workOrTargetId);
            if (work is null && target is null)
            {
                var resolved = await scope.ServiceProvider.GetRequiredService<IMetadata>().GetWorkAsync(workOrTargetId, false, ct);
                work = resolved.Work?.Work;
            }
            if (work is null) throw new ArgumentException("Open the title before changing its quality.");
            var preference = (await store.ListAsync<WorkPreferenceRow>(row => row.WorkId == work.Id, ct)).FirstOrDefault();
            var now = DateTimeOffset.UtcNow;
            var nextPreference = preference is null
                ? new WorkPreferenceRow { Id = "preference:" + work.Id, WorkId = work.Id, ResolutionFloor = quality, PreferredResolution = quality, AudioLanguage = null, MaxBytesPerItem = null, StorageRootOverrideId = null, UpdatedAt = now, Version = 1 }
                : preference with { ResolutionFloor = quality, PreferredResolution = quality,
                    UpdatedAt = now, Version = preference.Version + 1 };
            var writes = ImmutableArray.CreateBuilder<RowWrite>();
            if (target is null) writes.Add(new(nextPreference, preference?.Version, null));
            var affected = all.Where(t => t.WorkId == work.Id && (target is null || t.Id == target.Id) &&
                t.State != TargetState.Removed).ToArray();
            foreach (var row in affected)
            {
                var replan = row.State is TargetState.Wanted or TargetState.Waiting or TargetState.Finding or TargetState.Checking or TargetState.Planning;
                var next = row with { ResolutionFloor = quality, PreferredResolution = quality,
                    State = replan ? TargetState.Wanted : row.State,
                    ReasonCode = replan ? null : row.ReasonCode, ReasonText = replan ? null : row.ReasonText,
                    NextTryAt = replan ? null : row.NextTryAt, ResumeState = replan ? null : row.ResumeState,
                    LeaseToken = replan ? null : row.LeaseToken, LeaseUntil = replan ? null : row.LeaseUntil,
                    ChosenReleaseHash = replan ? null : row.ChosenReleaseHash,
                    PolicyRevision = row.PolicyRevision + 1, UpdatedAt = now, Version = row.Version + 1 };
                writes.Add(new(next, row.Version, null));
            }
            if (writes.Count > 0) await CommitAsync(store, writes.ToImmutable(), [], ct);
            foreach (var row in affected.Where(t => t.State is TargetState.Finding or TargetState.Checking or TargetState.Planning))
                if (cancellations.TryGetValue(row.Id, out var cancellation)) cancellation.Cancel();
            return new(true, affected.Length, 0, [.. affected.Select(t => t.Id)], "Quality saved");
        }
        finally { stateGate.Release(); }
    }
}
