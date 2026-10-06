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
        var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
        var row = (await store.ListAsync<SettingRow>(setting => setting.Id == "recovery", ct)).SingleOrDefault();
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
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var old = (await store.ListAsync<SettingRow>(setting => setting.Id == "recovery", ct)).SingleOrDefault();
            var engineRow = (await store.ListAsync<SettingRow>(setting => setting.Id == "engine", ct)).Single();
            var settings = SettingsCatalog.Read<EngineSettings>(engineRow) with
            {
                MetadataStallSeconds = value.MetadataStallSeconds,
                ProgressStallSeconds = value.ProgressStallSeconds,
                ProgressStallBytes = value.ProgressStallBytes,
            };
            await CommitAsync(store, [new(new SettingRow { Id = "recovery", SchemaVersion = 1, Value = JsonSerializer.SerializeToElement(value, RecoveryJson), Revision = (old?.Revision ?? 0) + 1, UpdatedAt = DateTimeOffset.UtcNow }, old?.Revision, null),
                new(engineRow with { Value = JsonSerializer.SerializeToElement(settings, RecoveryJson),
                    Revision = engineRow.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow },
                    engineRow.Revision, null)], [], ct);
            await engine.UpdateSettingsAsync(settings, ct);
            return value;
        }
        finally { stateGate.Release(); }
    }

    public Task<TargetActionReply> FindAnotherAsync(string targetId, CancellationToken ct) =>
        FindAnotherCoreAsync(targetId, null, null, ct);

    public Task<TargetActionReply> FindAnotherAsync(string targetId, string? pickedReleaseHash,
        CancellationToken ct) =>
        FindAnotherCoreAsync(targetId, null, pickedReleaseHash, ct);

    internal static async Task<ImmutableHashSet<string>> ExcludedAsync(TargetStore store, string workKey,
        string? current, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var blocks = await store.ListAsync<BlockRow>(b => (b.WorkKey == null || b.WorkKey == workKey) &&
            (b.Until == null || b.Until > now), ct);
        return blocks.Select(b => b.Hash)
            .Concat(current is null ? [] : new[] { current }).ToImmutableHashSet(StringComparer.OrdinalIgnoreCase);
    }

    private async Task<TargetActionReply> FindAnotherCoreAsync(string targetId, string? stall,
        string? pickedReleaseHash, CancellationToken ct)
    {
        var snapshot = await ReadAsync(ct);
        var target = snapshot.Targets.SingleOrDefault(t => t.Id == targetId);
        if (target is null || target.State != TargetState.Fetching || target.ChosenReleaseHash is null)
            return new(false, 0, 0, [targetId], "Only an unfinished download can find another source.");
        var download = snapshot.Downloads.SingleOrDefault(d => d.Hash == target.ChosenReleaseHash);
        if (download is null) return new(false, 0, 0, [targetId], "Download not found.");
        if (pickedReleaseHash?.Equals(download.Hash, StringComparison.OrdinalIgnoreCase) == true)
            return new(false, 0, 0, [targetId], "That source is already downloading.");
        if (!swapping.TryAdd(download.Id, 0))
            return new(false, 0, 0, [targetId], "Already looking for another source.");

        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
            var links = await store.ListAsync<DownloadTargetRow>(null, ct);
            var targetIds = links.Where(l => l.DownloadId == download.Id && l.Role == AssociationRole.Current)
                .Select(l => l.TargetId).ToHashSet(StringComparer.Ordinal);
            var targets = snapshot.Targets.Where(t => targetIds.Contains(t.Id) && t.WorkId == target.WorkId &&
                t.State != TargetState.Removed).ToArray();
            targetIds.IntersectWith(targets.Select(t => t.Id));

            var work = (await store.ListAsync<WorkRow>(row => row.Id == target.WorkId, ct)).SingleOrDefault();
            if (work is null) return new(false, 0, 0, [targetId], "The title is no longer available.");
            var now = DateTimeOffset.UtcNow;
            // A source picked back by hand still has its old block; refresh it instead of adding a second one.
            var oldBlock = (await store.ListAsync<BlockRow>(b => b.Hash == download.Hash && b.WorkKey == work.WorkKey, ct))
                .SingleOrDefault();
            await CommitAsync(store, [
                new(new AttemptRow { Id = Guid.NewGuid().ToString("N"), TargetId = target.Id, WorkId = target.WorkId, ReleaseHash = download.Hash, ActorUserId = target.CreatedBy, Kind = AttemptKind.Swap, StartedAt = now, EndedAt = now, Outcome = "Searching", ReasonCode = stall, ReasonText = stall is null ? "Looking for another source." : "The source stalled. Looking for another.", Decision = null, LegacyContext = null, BatchId = target.BatchId, DownloadId = download.Id, DeadlineAt = null, Swap = null }, null, null),
                new(new BlockRow { Id = oldBlock?.Id ?? Guid.NewGuid().ToString("N"), Hash = download.Hash, WorkKey = work.WorkKey, Reason = "Owner chose another source", Origin = BlockOrigin.Owner, ReplacedByHash = null, CreatedAt = now, Until = null }, null, oldBlock),
            ], [], ct);

            await DeleteDownloadFilesAsync(download.Hash, ct);
            var current = await store.ListAsync<TargetRow>(row => row.WorkId == target.WorkId, ct);
            var reset = current.Where(t => targetIds.Contains(t.Id) && t.State == TargetState.Removed)
                .Select(t => new RowWrite(t with
                {
                    Kind = TargetKind.Acquire,
                    State = TargetState.Wanted,
                    ResumeState = null,
                    ReasonCode = null,
                    ReasonText = null,
                    NextTryAt = null,
                    ChosenReleaseHash = null,
                    ReplaceMediaFileId = null,
                    ReplacementMode = null,
                    PickedReleaseHash = pickedReleaseHash,
                    LeaseToken = null,
                    LeaseUntil = null,
                    UpdatedAt = now,
                    Version = t.Version + 1,
                }, t.Version, null)).ToImmutableArray();
            if (!reset.IsEmpty) await CommitAsync(store, reset, [], ct);
            return new(true, reset.Length, 0, [.. targetIds], "Looking for another source.");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Find another failed for {TargetId}", targetId);
            return new(false, 0, 0, [targetId], "The download could not be removed. Try again.");
        }
        finally { swapping.TryRemove(download.Id, out _); }
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
            flights["find-another:" + live.DownloadId] = FindAnotherCoreAsync(target.Id,
                live.StalledMetadata ? "NoMetadata" : "NoProgress", null, ct);
        }
    }
}
