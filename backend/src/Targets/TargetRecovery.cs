using System.Collections.Immutable;
using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;
using TorrentFlow.Store;
using TorrentFlow.Library;

namespace TorrentFlow.Targets;

public sealed partial class TargetPipeline
{
    private readonly ConcurrentDictionary<string, byte> swapping = new();
    private static readonly JsonSerializerOptions RecoveryJson = new(JsonSerializerDefaults.Web)
        { Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) } };

    public async Task<RecoverySettings> RecoverySettingsAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
        var row = (await store.ReadAsync<SettingRow>(CatalogState.Query("recovery"), ct)).SingleOrDefault();
        return row is null ? new() : SettingsCatalog.Read<RecoverySettings>(row);
    }

    public async Task<RecoverySettings> UpdateRecoverySettingsAsync(RecoverySettings value, CancellationToken ct)
    {
        if (value.MetadataStallSeconds < 1 || value.ProgressStallSeconds < 1 || value.ProgressStallBytes < 1 ||
            value.MaximumSwaps is < 1 or > 20 || value.BackoffSeconds < 1)
            throw new ArgumentException("Choose positive recovery thresholds and between 1 and 20 swaps.");
        await stateGate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var old = (await store.ReadAsync<SettingRow>(CatalogState.Query("recovery"), ct)).SingleOrDefault();
            var engineRow = (await store.ReadAsync<SettingRow>(CatalogState.Query("engine"), ct)).Single();
            var settings = SettingsCatalog.Read<EngineSettings>(engineRow) with
            {
                MetadataStallSeconds = value.MetadataStallSeconds,
                ProgressStallSeconds = value.ProgressStallSeconds,
                ProgressStallBytes = value.ProgressStallBytes,
            };
            await CommitAsync(store, [new(new SettingRow("recovery", 1,
                JsonSerializer.SerializeToElement(value, RecoveryJson),
                (old?.Revision ?? 0) + 1, DateTimeOffset.UtcNow), old?.Revision, null),
                new(engineRow with { Value = JsonSerializer.SerializeToElement(settings, RecoveryJson),
                    Revision = engineRow.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow },
                    engineRow.Revision, null)], [], ct);
            await engine.UpdateSettingsAsync(settings, ct);
            return value;
        }
        finally { stateGate.Release(); }
    }

    internal static async Task<ImmutableHashSet<string>> ExcludedAsync(IStore store, string workId,
        string? current, CancellationToken ct)
    {
        var blocks = await new CatalogState(store).ReadAsync<BlockRow>(CatalogState.Query(), ct);
        return blocks.Where(b => (b.WorkKey is null || b.WorkKey == workId) &&
            (b.Until is null || b.Until > DateTimeOffset.UtcNow)).Select(b => b.Hash)
            .Concat(current is null ? [] : new[] { current }).ToImmutableHashSet(StringComparer.OrdinalIgnoreCase);
    }

    public Task<TargetActionReply> FindAnotherAsync(string targetId, CancellationToken ct) =>
        SwapAsync(targetId, null, ct);

    public Task<TargetActionReply> ReplaceAsync(string targetId, string? hash, string? source,
        CancellationToken ct) => SwapAsync(targetId, null, ct, hash, source);

    public async Task<DiscoveryResult?> AlternativesAsync(string targetId, string? source, CancellationToken ct)
    {
        var snapshot = await ReadAsync(ct);
        var first = snapshot.Targets.SingleOrDefault(t => t.Id == targetId);
        if (first is null || first.State != TargetState.Fetching || first.ChosenReleaseHash is null)
            return null;
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
        var links = await new CatalogState(store).ReadAsync<DownloadTargetRow>(CatalogState.Query(), ct);
        var old = snapshot.Downloads.Single(d => d.Hash == first.ChosenReleaseHash);
        var rows = snapshot.Targets.Where(t => t.State == TargetState.Fetching &&
            links.Any(l => l.DownloadId == old.Id && l.TargetId == t.Id && l.Role == AssociationRole.Current))
            .ToImmutableArray();
        var work = (await scope.ServiceProvider.GetRequiredService<IMetadata>().GetWorkAsync(first.WorkId, false, ct)).Work;
        if (work is null) return null;
        var result = await ReplacementPlanAsync(store, work, rows, old.Hash, null, source, ct);
        foreach (var evidence in result.Evidence)
            if (evidence.AdmissionHandle is { } handle) await engine.ReleaseProbeAsync(handle, CancellationToken.None);
        return result;
    }

    private async Task<DiscoveryResult> ReplacementPlanAsync(IStore store, WorkSnapshot work,
        ImmutableArray<TargetRow> rows, string current, string? chosen, string? source, CancellationToken ct)
    {
        var first = rows[0];
        return await discovery.RunAsync(work, new(first.WorkId,
            [.. rows.Where(t => t.EpisodeId is not null).Select(t => t.EpisodeId!)], first.EpisodeId is null),
            new(first.ResolutionFloor, first.PreferredResolution, first.AudioLanguage, first.MaxBytes, null,
                first.PolicyRevision), PriorityLane.Owner, false, ct,
            actualTargets: [.. rows.Select(t => t with { PickedReleaseHash = chosen })],
            excludedHashes: await ExcludedAsync(store, first.WorkId, current, ct),
            sourceIds: source is null ? [] : [source]);
    }

    private async Task<TargetActionReply> SwapAsync(string targetId, string? stall, CancellationToken ct,
        string? chosen = null, string? source = null)
    {
        var initial = await ReadAsync(ct);
        var first = initial.Targets.SingleOrDefault(t => t.Id == targetId);
        if (stall is not null && !await CanRunAsync(ct))
            return new(false, 0, 0, [targetId], "Downloads are paused. Finish reviewing the library and enable downloads first.");
        if (first is null || first.State != TargetState.Fetching || first.ChosenReleaseHash is null)
            return new(false, 0, 0, [targetId], "Only an unfinished download can find another release.");
        var old = initial.Downloads.Single(d => d.Hash == first.ChosenReleaseHash);
        if (!swapping.TryAdd(old.Id, 0))
            return new(false, 0, 0, [targetId], "Already looking for another release.");
        DiscoveryResult? planned = null;
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var links = await new CatalogState(store).ReadAsync<DownloadTargetRow>(CatalogState.Query(), ct);
            var rows = initial.Targets.Where(t => t.State == TargetState.Fetching &&
                links.Any(l => l.DownloadId == old.Id && l.TargetId == t.Id && l.Role == AssociationRole.Current))
                .ToImmutableArray();
            var now = DateTimeOffset.UtcNow;
            await CommitAsync(store, [new(new AttemptRow(Guid.NewGuid().ToString("N"), first.Id,
                first.WorkId, old.Hash, first.CreatedBy, AttemptKind.Swap, now, now, "Searching",
                stall, stall is null ? "Looking for another release." : "The release stalled. Looking for another.",
                null, null, first.BatchId, old.Id, null, null), null, null)], [], ct);
            var work = (await scope.ServiceProvider.GetRequiredService<IMetadata>()
                .GetWorkAsync(first.WorkId, false, ct)).Work;
            if (work is null) return new(false, 0, 0, [targetId], "The catalog is unavailable. Kept the current release.");
            var result = await ReplacementPlanAsync(store, work, rows, old.Hash, chosen, source, ct);
            planned = result;
            if (result.Plan.Assignments.IsEmpty || !result.Plan.UncoveredTargetIds.IsEmpty ||
                !rows.Select(t => t.Id).Order().SequenceEqual(
                    result.Plan.Assignments.SelectMany(a => a.TargetIds).Order()) ||
                result.Plan.Assignments.Any(a => result.Evidence.SingleOrDefault(e => e.Hash == a.Hash) is not
                    { Band: HealthBand.Good or HealthBand.Weak, Files: not null }))
                return new(false, 0, 0, [.. rows.Select(t => t.Id)],
                    "No other checked release is available. Kept the current release.");
            var replacements = result.Plan.Assignments.Select(assignment =>
            {
                var evidence = result.Evidence.Single(e => e.Hash == assignment.Hash);
                return new TargetTransfers.Replacement(assignment,
                    result.Find.Candidates.Single(c => c.Release.Id == assignment.Hash),
                    evidence.Files!.Value, evidence.AdmissionHandle);
            }).ToImmutableArray();
            var switched = await transfers.SwapAsync(work, rows, old, replacements, stall, stateGate, ct);
            return new(switched, 0, 0, [.. rows.Select(t => t.Id)], switched
                ? "Started another release." : "The replacement did not start. Kept the current release.");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Release replacement failed for {TargetId}; keeping Current", targetId);
            return new(false, 0, 0, [targetId], "Another release could not start. Kept the current release.");
        }
        finally
        {
            try
            {
                if (planned is not null)
                    foreach (var evidence in planned.Evidence)
                        if (evidence.AdmissionHandle is { } handle)
                            await engine.ReleaseProbeAsync(handle, CancellationToken.None);
            }
            finally { swapping.TryRemove(old.Id, out _); }
        }
    }

    private async Task RecoverStallsAsync(TargetSnapshot snapshot, CancellationToken ct)
    {
        var settings = await RecoverySettingsAsync(ct);
        if (!settings.Enabled) return;
        foreach (var live in snapshot.Live.Where(l => l.Active && !l.Complete &&
            (l.StalledMetadata || l.StalledProgress)))
        {
            var target = snapshot.Targets.FirstOrDefault(t => t.State == TargetState.Fetching &&
                t.ChosenReleaseHash == live.Hash);
            if (target is null || swapping.ContainsKey(live.DownloadId)) continue;
            var attempts = snapshot.History.Where(a => a.WorkId == target.WorkId && a.Kind == AttemptKind.Swap && a.Outcome == "Searching" &&
                a.ReasonCode is not null && a.StartedAt > DateTimeOffset.UtcNow.AddSeconds(-settings.BackoffSeconds))
                .OrderByDescending(a => a.StartedAt).ToArray();
            if (attempts.Length >= settings.MaximumSwaps ||
                attempts.FirstOrDefault()?.StartedAt > DateTimeOffset.UtcNow.AddSeconds(-Math.Min(60, settings.BackoffSeconds)))
                continue;
            flights["swap:" + live.DownloadId] = SwapAsync(target.Id,
                live.StalledMetadata ? "NoMetadata" : "NoProgress", ct);
        }
    }
}
