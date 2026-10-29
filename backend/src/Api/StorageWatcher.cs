using System.Collections.Concurrent;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal sealed class StorageWatcher(IServiceScopeFactory scopes, IStorageStatus status,
    TargetPipeline targets, ILogger<StorageWatcher> logger) : BackgroundService
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan ProbeDeadline = TimeSpan.FromSeconds(3);
    private readonly ConcurrentDictionary<string, PendingProbe> pending = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> failures = new(StringComparer.Ordinal);
    private readonly HashSet<string> startupChecked = new(StringComparer.Ordinal);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await PollAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogError(ex, "Storage watch pass failed"); }
            try { await Task.Delay(PollInterval, stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
        }
    }

    private async Task PollAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var repository = scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
        var placement = scope.ServiceProvider.GetRequiredService<ILibraryPlacement>();
        var roots = await repository.RootsAsync(ct);
        foreach (var root in roots)
        {
            if (!root.Enabled)
            {
                status.Update(root.Path, false, null);
                continue;
            }
            var initializing = status.Status(root.Path).CheckedAt == DateTimeOffset.MinValue;
            if (initializing)
                status.Update(root.Path, root.Online && !root.ReviewRequired, null);
            if (!pending.TryGetValue(root.Id, out var item))
            {
                StartProbe(root);
                continue;
            }
            if (!item.Task.IsCompleted)
                continue;
            pending.TryRemove(root.Id, out _);
            if (DateTimeOffset.UtcNow - item.StartedAt > ProbeDeadline)
            {
                StartProbe(root);
                continue;
            }
            if (item.Root.Version != root.Version || item.Root.Path != root.Path)
            {
                StartProbe(root);
                continue;
            }
            StartProbe(root);
            ProbeResult probe;
            try { probe = await item.Task; }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Storage probe failed for {RootId}", root.Id);
                await ProbeFailedAsync(root, ct);
                continue;
            }
            if (!probe.Exists)
            {
                await ProbeFailedAsync(root, ct);
                continue;
            }

            failures.Remove(root.Id);
            var legacy = root.VolumeSerial.Length == 0 && !probe.MarkerExists &&
                startupChecked.Add(root.Id);
            if (legacy)
            {
                var check = await placement.CheckRootAsync(root.Id, ct);
                if (check.Root is { } initialized && initialized.Online && !initialized.ReviewRequired)
                {
                    status.Update(root.Path, true, probe.FreeBytes);
                    if (!root.Online) await targets.StorageRootOnlineAsync(ct);
                    else if (initializing) await targets.WakeStorageWaitsAsync(ct);
                }
                else status.Update(root.Path, false, null);
                continue;
            }

            var identityMatches = probe.MarkerMatches && probe.VolumeSerial == root.VolumeSerial;
            if (!identityMatches)
            {
                status.Update(root.Path, false, null);
                if (!root.ReviewRequired)
                {
                    var review = root with { Online = false, ReviewRequired = true,
                        LastError = "Check needed. Confirm that this is the correct storage location.",
                        LastCheckedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
                        Version = root.Version + 1 };
                    if (await repository.SaveRootAsync(review, root.Version, ct) && root.Online)
                        await targets.StorageRootOfflineAsync(root.Id, status.Label(root.Path), ct);
                }
                continue;
            }
            if (root.ReviewRequired)
            {
                status.Update(root.Path, false, null);
                continue;
            }

            if (!root.Online)
            {
                var check = await placement.CheckRootAsync(root.Id, ct);
                if (check.Root is { Online: true, ReviewRequired: false } recovered)
                {
                    status.Update(recovered.Path, true, probe.FreeBytes);
                    await targets.StorageRootOnlineAsync(ct);
                }
                else status.Update(root.Path, false, null);
                continue;
            }

            var prior = status.Status(root.Path);
            status.Update(root.Path, true, probe.FreeBytes);
            if (initializing)
                await targets.WakeStorageWaitsAsync(ct);
            else if (prior.FreeBytes is { } before && probe.FreeBytes - before >= 1_000_000_000L)
                await targets.WakeStorageWaitsAsync(ct);
        }
    }

    private async Task ProbeFailedAsync(StorageRootRow root, CancellationToken ct)
    {
        var count = failures.GetValueOrDefault(root.Id) + 1;
        failures[root.Id] = count;
        if (count < 2)
            return;

        status.Update(root.Path, false, null);
        if (!root.Online) return;
        var offline = root with { Online = false, LastError = "This location is offline. Reconnect it to continue downloads.",
            LastCheckedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow, Version = root.Version + 1 };
        if (await SaveRootAsync(offline, root.Version, ct))
            await targets.StorageRootOfflineAsync(root.Id, status.Label(root.Path), ct);
    }

    private async Task<bool> SaveRootAsync(StorageRootRow root, long version, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ILibraryRepository>()
            .SaveRootAsync(root, version, ct);
    }

    private static ProbeResult Probe(StorageRootRow root)
    {
        if (!Directory.Exists(root.Path)) return new(false, false, false, "", null);
        LibraryPaths.NoLinks(root.Path);
        var volumeSerial = LibraryPaths.Volume(root.Path);
        var markerExists = File.Exists(StorageIdentity.MarkerPath(root.Path));
        var markerMatches = StorageIdentity.MarkerMatches(root.Path, root.Id, volumeSerial);
        var freeBytes = LibraryPaths.FreeBytes(root.Path);
        return new(true, markerExists, markerMatches, volumeSerial, freeBytes);
    }

    private void StartProbe(StorageRootRow root) =>
        pending[root.Id] = new(DateTimeOffset.UtcNow, root, Task.Run(() => Probe(root), CancellationToken.None));

    private sealed record PendingProbe(DateTimeOffset StartedAt, StorageRootRow Root, Task<ProbeResult> Task);
    private sealed record ProbeResult(bool Exists, bool MarkerExists, bool MarkerMatches,
        string VolumeSerial, long? FreeBytes);
}
