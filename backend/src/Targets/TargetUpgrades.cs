using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

public sealed record UpgradeOffer(int Resolution, int Seeders);
public sealed record BestAvailable(int? Resolution, DateTimeOffset CheckedAt);
public sealed record ItemUpgrade(string? EpisodeId, UpgradeOffer? Upgrade, BestAvailable? BestAvailable);

public sealed partial class TargetPipeline
{
    private readonly SemaphoreSlim qualityGate = new(1, 1);

    private static bool BelowPreferred(OwnedItem item, Policy policy) =>
        item.Videos.Max(v => v.Resolution) is { } resolution && resolution > 0 &&
        resolution < policy.PreferredResolution;

    private static async Task<DateTimeOffset> QualityChangedAtAsync(IStore store, string workId, CancellationToken ct)
    {
        var preference = (await store.ReadAsync<WorkPreferenceRow>(CatalogState.Query(workId: workId), ct)).FirstOrDefault();
        var setting = (await store.ReadAsync<SettingRow>(CatalogState.Query("quality"), ct)).Single();
        return preference?.UpdatedAt > setting.UpdatedAt ? preference.UpdatedAt : setting.UpdatedAt;
    }

    private static bool FreshQuality(UpgradeEvidenceRow row, OwnedItem item, DateTimeOffset changedAt) =>
        row.ExpiresAt > DateTimeOffset.UtcNow && row.CheckedAt >= changedAt &&
        (row.CandidateHash is not null || row.Resolution == item.Videos.Max(v => v.Resolution));

    private static void ValidateQualityScope(WorkSnapshot work, AcquireInput input)
    {
        if (input.Season is < 0 or > 999 || input.Episode is < 1 or > 99999 ||
            input.Episode is not null && input.Season is null ||
            work.Work.Kind == WorkKind.Film && (input.Season is not null || input.Episode is not null))
            throw new ArgumentException("Choose a title, or a valid season and episode for a series.");
        if (input.Season is { } number && !work.Seasons.Any(s => s.Number == number))
            throw new ArgumentException("That season is not in this title's catalog. Refresh the title and try again.");
    }

    private static async Task<Policy> UpgradePolicyAsync(IStore store, WorkRow work, CancellationToken ct)
    {
        var preference = (await store.ReadAsync<WorkPreferenceRow>(CatalogState.Query(workId: work.Id), ct)).FirstOrDefault();
        var setting = (await store.ReadAsync<SettingRow>(CatalogState.Query("quality"), ct)).Single();
        var quality = SettingsCatalog.Read<QualitySettings>(setting);
        return new(preference?.ResolutionFloor, preference?.PreferredResolution ?? quality.PreferredResolution ?? 1080,
            await TargetAudioPolicy.ResolveAsync(store, work, preference, ct), preference?.MaxBytesPerItem ?? quality.MaxBytesPerItem,
            preference?.StorageRootOverrideId, preference?.Version ?? setting.Revision);
    }

    private static TargetRow UpgradeTarget(WorkRow work, OwnedItem item, Policy policy, string actor)
    {
        var now = DateTimeOffset.UtcNow;
        var video = item.Videos.OrderByDescending(v => v.Resolution).ThenBy(v => v.Id).First();
        return new($"upgrade:{work.Id}:{item.EpisodeId ?? "film"}", work.Id, item.EpisodeId,
            TargetKind.Replace, TargetState.Wanted, null, null, null, null, null,
            policy.ResolutionFloor, policy.PreferredResolution, policy.AudioLanguage, policy.MaxBytes,
            false, 0, null, actor, IntentOrigin.Upgrade, null, null, video.Id, ReplacementMode.Upgrade,
            null, now, 0, null, policy.Revision, null, null, now, now, 1)
            { Priority = TargetPriority.UpgradeWatch };
    }

    public async Task<ImmutableArray<ItemUpgrade>> ReadUpgradesAsync(WorkSnapshot work, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
        var catalog = new CatalogState(store);
        var policy = await UpgradePolicyAsync(store, work.Work, ct);
        var changedAt = await QualityChangedAtAsync(store, work.Work.Id, ct);
        var owned = await scope.ServiceProvider.GetRequiredService<ILibraryPlacement>()
            .OwnedAsync(new(work.Work.Id, [], false), ct);
        var evidence = await catalog.ReadAsync<UpgradeEvidenceRow>(CatalogState.Query(workId: work.Work.Id), ct);
        var blocked = await ExcludedAsync(store, work.Work.Id, null, ct);
        var result = ImmutableArray.CreateBuilder<ItemUpgrade>();
        foreach (var item in owned.Where(i => BelowPreferred(i, policy)))
        {
            var row = evidence.FirstOrDefault(e => e.EpisodeId == item.EpisodeId && FreshQuality(e, item, changedAt));
            if (row is null) continue;
            UpgradeOffer? offer = null;
            if (row.CandidateHash is { } hash && !blocked.Contains(hash))
            {
                var target = UpgradeTarget(work.Work, item, policy, "local") with { PickedReleaseHash = hash };
                var find = scope.ServiceProvider.GetRequiredService<IFind>();
                var pool = await find.SelectAsync(new("upgrade-read", work,
                    new(work.Work.Id, item.EpisodeId is null ? [] : [item.EpisodeId], item.EpisodeId is null),
                    policy, PriorityLane.Owner, SearchNamePhase.English, [], 0, 0), hash, ct);
                var check = scope.ServiceProvider.GetRequiredService<ICheck>();
                var verdicts = await check.LoadAsync([hash], ct);
                var healthy = verdicts.FirstOrDefault(v => v.Band == HealthBand.Good && v.ExpiresAt > DateTimeOffset.UtcNow);
                if (healthy is not null)
                {
                    var plan = scope.ServiceProvider.GetRequiredService<IPlan>().Choose(new(work,
                        AcquisitionMode.Catalog, [], [target], pool.Candidates, verdicts, owned, [], DateTimeOffset.UtcNow));
                    if (plan.Assignments.Any(a => a.Hash == hash))
                        offer = new(row.Resolution!.Value, healthy.ScrapedSeeders ??
                            pool.Candidates.First(c => c.Release.Id == hash).TrustedSeeders ?? healthy.ConnectedSeeders);
                }
            }
            result.Add(new(item.EpisodeId, offer, row.CandidateHash is null
                ? new(item.Videos.Max(v => v.Resolution), row.CheckedAt) : null));
        }
        return result.ToImmutable();
    }

    public Task<ImmutableArray<ItemUpgrade>> CheckQualityAsync(AcquireInput input, CancellationToken ct) =>
        SweepQualityAsync(input, PriorityLane.Owner, ct);

    private async Task<ImmutableArray<ItemUpgrade>> SweepQualityAsync(AcquireInput input, PriorityLane lane, CancellationToken ct)
    {
        await qualityGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var work = (await scope.ServiceProvider.GetRequiredService<IMetadata>().GetWorkAsync(input.WorkKey, false, ct)).Work
                ?? throw new ArgumentException("Open the title before checking its quality.");
            ValidateQualityScope(work, input);
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var catalog = new CatalogState(store);
            var policy = await UpgradePolicyAsync(store, work.Work, ct);
            var changedAt = await QualityChangedAtAsync(store, work.Work.Id, ct);
            var episodeIds = work.Episodes.Where(e => (input.Season is null ||
                work.Seasons.FirstOrDefault(s => s.Id == e.SeasonId)?.Number == input.Season) &&
                (input.Episode is null || e.Number == input.Episode)).Select(e => e.Id).ToImmutableArray();
            if (input.Episode is not null && (input.Season is null || episodeIds.IsEmpty))
                throw new ArgumentException("Choose a confirmed season and episode.");
            var owned = await scope.ServiceProvider.GetRequiredService<ILibraryPlacement>()
                .OwnedAsync(new(work.Work.Id, episodeIds, work.Work.Kind == WorkKind.Film), ct);
            if (input.Season is not null)
                owned = [.. owned.Where(i => i.EpisodeId is not null && episodeIds.Contains(i.EpisodeId))];
            var blocked = await ExcludedAsync(store, work.Work.Id, null, ct);
            var priorEvidence = await catalog.ReadAsync<UpgradeEvidenceRow>(CatalogState.Query(workId: work.Work.Id), ct);
            var due = owned.Where(i => BelowPreferred(i, policy) &&
                (lane == PriorityLane.Owner || !priorEvidence.Any(e => e.EpisodeId == i.EpisodeId &&
                    FreshQuality(e, i, changedAt))));
            foreach (var group in due.GroupBy(i => i.EpisodeId is null ? null :
                work.Episodes.FirstOrDefault(e => e.Id == i.EpisodeId)?.SeasonId))
            {
                var items = group.ToArray();
                var targets = items.Select(i => UpgradeTarget(work.Work, i, policy, "local")).ToImmutableArray();
                var found = await discovery.RunAsync(work, new(work.Work.Id,
                    [.. items.Select(i => i.EpisodeId).OfType<string>()], items[0].EpisodeId is null),
                    policy, lane, false, ct, actualTargets: targets, owned: owned, excludedHashes: blocked);
                try
                {
                    foreach (var item in items)
                    {
                        var target = targets.Single(t => t.EpisodeId == item.EpisodeId);
                        var assignment = found.Plan.Assignments.FirstOrDefault(a => a.TargetIds.Contains(target.Id) &&
                            found.Evidence.Any(v => v.Hash == a.Hash && v.Band == HealthBand.Good && v.ExpiresAt > DateTimeOffset.UtcNow));
                        // A failed provider is not evidence that the current file is the best available.
                        if (assignment is null && (!found.Find.Complete || !found.Find.Sources.Any(s =>
                            s.Outcome == SourceOutcome.Success))) continue;
                        var now = DateTimeOffset.UtcNow;
                        var resolution = assignment is null ? item.Videos.Max(v => v.Resolution) :
                            found.Find.Candidates.First(c => c.Release.Id == assignment.Hash).Release.Parsed.Quality.Resolution;
                        if (assignment is not null && resolution is null)
                        {
                            var files = found.Evidence.First(v => v.Hash == assignment.Hash).Files ?? [];
                            var parser = scope.ServiceProvider.GetRequiredService<IParser>();
                            var selected = assignment.Files.Where(f => f.TargetId == target.Id && f.Role == FileRole.Video)
                                .Select(f => parser.Parse(files.Single(file => file.Index == f.FileIndex).RelativePath).Quality.Resolution).ToArray();
                            resolution = selected.Length > 0 && selected.All(r => r is not null) ? selected.Min() : null;
                            if (resolution is null) continue;
                        }
                        var expires = assignment is null ? now.AddMinutes(30) :
                            found.Evidence.First(v => v.Hash == assignment.Hash).ExpiresAt;
                        await stateGate.WaitAsync(ct);
                        try
                        {
                            var old = (await catalog.ReadAsync<UpgradeEvidenceRow>(CatalogState.Query(workId: work.Work.Id), ct))
                                .FirstOrDefault(e => e.EpisodeId == item.EpisodeId);
                            var row = new UpgradeEvidenceRow(old?.Id ?? $"quality:{work.Work.Id}:{item.EpisodeId ?? "film"}",
                                work.Work.Id, item.EpisodeId, assignment?.Hash, resolution, now, expires);
                            await CommitAsync(store, [new(row, null, old)], [], ct);
                        }
                        finally { stateGate.Release(); }
                    }
                }
                finally
                {
                    foreach (var handle in found.Evidence.Select(e => e.AdmissionHandle).OfType<ProbeHandle>())
                        await engine.ReleaseProbeAsync(handle, CancellationToken.None);
                }
                if (lane == PriorityLane.Background) break;
            }
            return await ReadUpgradesAsync(work, ct);
        }
        finally { qualityGate.Release(); }
    }

    public async Task<TargetActionReply> UpgradeAsync(AcquireInput input, string actor, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var work = (await scope.ServiceProvider.GetRequiredService<IMetadata>().GetWorkAsync(input.WorkKey, false, ct)).Work
            ?? throw new ArgumentException("Open the title before upgrading it.");
        ValidateQualityScope(work, input);
        var episodes = work.Episodes.Where(e => (input.Season is null ||
            work.Seasons.FirstOrDefault(s => s.Id == e.SeasonId)?.Number == input.Season) &&
            (input.Episode is null || e.Number == input.Episode)).Select(e => e.Id).ToHashSet();
        if (input.Episode is not null && (input.Season is null || episodes.Count == 0))
            throw new ArgumentException("Choose a confirmed season and episode.");
        await stateGate.WaitAsync(ct);
        try
        {
            var offers = await ReadUpgradesAsync(work, ct);
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var catalog = new CatalogState(store);
            var policy = await UpgradePolicyAsync(store, work.Work, ct);
            var owned = await scope.ServiceProvider.GetRequiredService<ILibraryPlacement>()
                .OwnedAsync(new(work.Work.Id, [], false), ct);
            var evidence = await catalog.ReadAsync<UpgradeEvidenceRow>(CatalogState.Query(workId: work.Work.Id), ct);
            var current = await catalog.ReadAsync<TargetRow>(CatalogState.Query(workId: work.Work.Id), ct);
            var ids = ImmutableArray.CreateBuilder<string>();
            foreach (var offer in offers.Where(o => o.Upgrade is not null &&
                (o.EpisodeId is null || episodes.Contains(o.EpisodeId))))
            {
                var item = owned.FirstOrDefault(i => i.EpisodeId == offer.EpisodeId);
                var proof = evidence.FirstOrDefault(e => e.EpisodeId == offer.EpisodeId && e.ExpiresAt > DateTimeOffset.UtcNow);
                if (item is null || proof?.CandidateHash is null) continue;
                var row = UpgradeTarget(work.Work, item, policy, actor);
                var prior = current.FirstOrDefault(t => t.EpisodeId == item.EpisodeId);
                if (prior is not null && prior.Kind == TargetKind.Replace &&
                    prior.State is not (TargetState.Done or TargetState.Removed))
                {
                    ids.Add(prior.Id);
                    continue;
                }
                if (prior?.State is TargetState.Fetching or TargetState.Filing ||
                    prior?.ResumeState is TargetState.Fetching or TargetState.Filing) continue;
                row = row with { Id = prior?.Id ?? row.Id, PickedReleaseHash = proof.CandidateHash, NowAt = DateTimeOffset.UtcNow,
                    Version = (prior?.Version ?? 0) + 1, CreatedAt = prior?.CreatedAt ?? row.CreatedAt };
                var associations = await catalog.ReadAsync<DownloadTargetRow>(CatalogState.Query() with { TargetId = row.Id }, ct);
                await CommitAsync(store, [new(row, prior?.Version, null),
                    .. associations.Where(a => a.Role != AssociationRole.Retired)
                        .Select(a => new RowWrite(a with { Role = AssociationRole.Retired }, null, a))], [], ct);
                ids.Add(row.Id);
            }
            var queued = ids.Count(id => current.All(t => t.Id != id || t.Kind != TargetKind.Replace ||
                t.State is TargetState.Done or TargetState.Removed));
            return new(ids.Count > 0, queued, owned.Length, ids.ToImmutable(),
                queued > 0 ? $"{queued} upgrades queued" : ids.Count > 0 ? "Already queued" :
                    "No healthy upgrade is available. Check again.");
        }
        finally { stateGate.Release(); }
    }

    private async Task ScheduleQualityAsync(CatalogState catalog, CancellationToken ct)
    {
        if (qualityGate.CurrentCount == 0 || flights.Count >= maximumScopes) return;
        var media = await catalog.ReadAsync<MediaFileRow>(CatalogState.Query(), ct);
        var evidence = await catalog.ReadAsync<UpgradeEvidenceRow>(CatalogState.Query(), ct);
        var works = await catalog.ReadAsync<WorkRow>(CatalogState.Query(), ct);
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
        foreach (var work in works.Where(w => media.Any(m => m.WorkId == w.Id && m.Role == FileRole.Video)))
        {
            var policy = await UpgradePolicyAsync(store, work, ct);
            var changedAt = await QualityChangedAtAsync(store, work.Id, ct);
            if (!media.Where(m => m.WorkId == work.Id && m.Role == FileRole.Video &&
                    m.Status is FilePresence.Present or FilePresence.Offline).GroupBy(m => m.EpisodeId)
                .Any(g => BelowPreferred(new(work.Id, g.Key, [.. g]), policy) &&
                    !evidence.Any(e => e.WorkId == work.Id && e.EpisodeId == g.Key &&
                        FreshQuality(e, new(work.Id, g.Key, [.. g]), changedAt))))
                continue;
            var key = "quality:" + work.Id;
            if (!flights.ContainsKey(key)) flights[key] = BackgroundQualityAsync(work.Id, ct);
            break;
        }
    }

    private async Task BackgroundQualityAsync(string workId, CancellationToken ct)
    {
        try { await SweepQualityAsync(new(workId), PriorityLane.Background, ct); }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception ex) { logger.LogWarning(ex, "Quality sweep failed for {WorkId}", workId); }
    }

    private async Task RetireUpgradeFilesAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
        var catalog = new CatalogState(store);
        foreach (var target in (await catalog.ReadAsync<TargetRow>(CatalogState.Query(), ct))
            .Where(t => t.Kind == TargetKind.Replace && t.State == TargetState.Done && t.ReplaceMediaFileId is not null))
        {
            try { await RetireUpgradeFileAsync(scope.ServiceProvider, store, catalog, target, ct); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                logger.LogWarning(ex, "The old file for upgrade {TargetId} is retained; cleanup will retry", target.Id);
            }
        }
    }

    private async Task RetireUpgradeFileAsync(IServiceProvider services, IStore store, CatalogState catalog,
        TargetRow target, CancellationToken ct)
    {
            var repository = (ILibraryDownloadRepository)services.GetRequiredService<ILibraryRepository>();
            var media = await repository.MediaAsync(target.WorkId, ct);
            var old = media.FirstOrDefault(m => m.Id == target.ReplaceMediaFileId);
            if (old is not null)
            {
                if (old.Status == FilePresence.Offline || old.RootId is { } rootId &&
                    !(await repository.RootsAsync(ct)).Any(r => r.Id == rootId && r.Online)) return;
                var bindings = await repository.BindingsAsync(ct);
                if (!media.Any(m => m.EpisodeId == target.EpisodeId && m.Role == FileRole.Video &&
                    m.Id != old.Id && (target.ReplacementMode == ReplacementMode.Upgrade
                        ? m.Resolution > old.Resolution : m.Resolution >= old.Resolution) &&
                    bindings.Any(b => b.TargetId == target.Id && b.Filed && b.MediaFileId == m.Id))) return;
                var siblings = media.Where(m => m.Id == old.Id || m.ParentMediaFileId == old.Id).ToImmutableArray();
                var bound = bindings.Where(b => siblings.Any(m => m.DownloadId == b.DownloadId && m.FileIndex == b.FileIndex)).ToArray();
                if (bound.Length > 0)
                {
                    var download = (await catalog.ReadAsync<DownloadRow>(CatalogState.Query(old.DownloadId), ct)).Single();
                    await transfers.DeleteFilesAsync(download.Hash, [.. bound.Select(b => b.FileIndex)], stateGate, ct, target);
                }
                else
                {
                    await stateGate.WaitAsync(ct);
                    try
                    {
                        var current = (await store.ReadAsync<TargetRow>(CatalogState.Query(target.Id), ct)).Single();
                        if (current.State != TargetState.Done || current.ReplaceMediaFileId != old.Id) return;
                        var proposal = await repository.ProposeRemovalAsync([], siblings, [], ct)
                            ?? throw new IOException("The old file changed. It was retained for review.");
                        await LibraryRemoval.DeleteUnboundAsync(siblings, repository, ct, async token =>
                        {
                            await CommitAsync(store, [new(current with { ReplaceMediaFileId = null,
                                Version = current.Version + 1, UpdatedAt = DateTimeOffset.UtcNow }, current.Version, null)],
                                [], token, proposal);
                            return true;
                        });
                    }
                    finally { stateGate.Release(); }
                }
            }
            await stateGate.WaitAsync(ct);
            try
            {
                var current = (await store.ReadAsync<TargetRow>(CatalogState.Query(target.Id), ct)).Single();
                if (current.State == TargetState.Done && current.ReplaceMediaFileId == target.ReplaceMediaFileId)
                    await CommitAsync(store, [new(current with { ReplaceMediaFileId = null,
                        Version = current.Version + 1, UpdatedAt = DateTimeOffset.UtcNow }, current.Version, null)], [], ct);
            }
            finally { stateGate.Release(); }
    }
}
