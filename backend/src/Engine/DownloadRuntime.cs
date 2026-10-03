using System.Collections.Immutable;
using System.Diagnostics;
using MonoTorrent.Client;
using TorrentFlow.Domain;

namespace TorrentFlow.Engine;

public sealed partial class MonoTorrentEngine
{
    private readonly Dictionary<string, EngineQueueOrder> queueOrder = [];
    private readonly Queue<EngineEvent> downloadEvents = [];

    public async Task UpdateSettingsAsync(TorrentFlow.Domain.EngineSettings configuration, CancellationToken ct)
    {
        if (configuration.MaxActiveDownloads is < 1 or > 20 ||
            configuration.MetadataStallSeconds < 1 || configuration.ProgressStallSeconds < 1 ||
            configuration.ProgressStallBytes < 1)
            throw new ArgumentOutOfRangeException(nameof(configuration));
        await gate.WaitAsync(ct);
        try
        {
            settings = configuration with { ListenPort = settings.ListenPort };
            await ReconcileQueueAsync();
        }
        finally { gate.Release(); }
    }

    public async Task<ImmutableArray<EngineEvent>> ReadEventsAsync(CancellationToken ct)
    {
        await SnapshotAsync(ct);
        await gate.WaitAsync(ct);
        try
        {
            var result = downloadEvents.ToImmutableArray();
            downloadEvents.Clear();
            return result;
        }
        finally { gate.Release(); }
    }

    private async Task ReconcileQueueAsync()
    {
        var ordered = entries.Values.Where(e => !e.Probe && e.WantsRun && !e.Completed &&
                (e.Bound || !MetadataReady(e.Manager)) &&
                !permits.Values.Any(p => p.DownloadId == e.Id) &&
                (!e.Bound || e.Manager.Files.Any(f => f.Priority != MonoTorrent.Priority.DoNotDownload)) &&
                e.Filed.All(i => e.Manager.Files[i].BitField.AllTrue) &&
                (!e.Bound || !SelectedComplete(e.Manager)) &&
                (!queueOrder.TryGetValue(e.Id, out var q) || q.Eligible))
            .OrderBy(e => queueOrder.GetValueOrDefault(e.Id)?.Priority ?? TargetPriority.BackCatalogue)
            .ThenBy(e => queueOrder.GetValueOrDefault(e.Id)?.Rank ?? 0)
            .ThenBy(e => e.Id, StringComparer.Ordinal).ToArray();
        string Slot(Entry e) => e.SharedSlotDownloadId is { } owner && ordered.Any(o => o.Id == owner)
            ? owner : e.Id;
        var slots = ordered.GroupBy(Slot).Select(g => new
        {
            Entries = g.ToArray(),
            Owner = g.FirstOrDefault(e => e.Id == g.Key) ?? g.First(),
        }).OrderBy(g => queueOrder.GetValueOrDefault(g.Owner.Id)?.Priority ?? TargetPriority.BackCatalogue)
            .ThenBy(g => queueOrder.GetValueOrDefault(g.Owner.Id)?.Rank ?? 0)
            .ThenBy(g => g.Owner.Id, StringComparer.Ordinal).ToArray();
        var winners = slots.Where(g => queueOrder.GetValueOrDefault(g.Owner.Id)?.Now != true)
            .Take(settings.MaxActiveDownloads)
            .Concat(slots.Where(g => queueOrder.GetValueOrDefault(g.Owner.Id)?.Now == true))
            .SelectMany(g => g.Entries)
            .ToHashSet();
        // Drain losers before starting winners: lowering a cap never transiently exceeds it.
        foreach (var entry in entries.Values.Where(e => !e.Probe && e.Run && !winners.Contains(e)))
        {
            log($"Queue stop {entry.Id}: wantsRun={entry.WantsRun}, complete={entry.Completed}, " +
                $"eligible={queueOrder.GetValueOrDefault(entry.Id)?.Eligible}, " +
                $"permit={permits.Values.Any(p => p.DownloadId == entry.Id)}, " +
                $"selected={entry.Manager.Files.Count(f => f.Priority != MonoTorrent.Priority.DoNotDownload)}, cap={settings.MaxActiveDownloads}.");
            await StopDownloadAsync(entry);
        }
        foreach (var entry in ordered.Where(e => winners.Contains(e) && !e.Run))
        {
            entry.ActiveSince = entry.ProgressSince = Stopwatch.GetTimestamp();
            entry.ProgressBaseline = SelectedCompletedBytes(entry.Manager);
            entry.MetadataStalled = entry.ProgressStalled = false;
            if (!entry.Bound)
            {
                if (!entry.Manager.HasMetadata) await StartMetadataAsync(entry.Manager);
            }
            else await entry.Manager.StartAsync();
            entry.Run = true;
            log($"Queue start {entry.Id}: cap={settings.MaxActiveDownloads}.");
        }
    }

    private async Task StopDownloadAsync(Entry entry)
    {
        UpdateReceived(entry);
        UpdateUploaded(entry);
        await entry.Manager.StopAsync(TimeSpan.Zero);
        if (entry.Manager.HasMetadata) await client.DiskManager.FlushAsync(entry.Manager);
        entry.LastReceived = entry.LastUploaded = 0;
        entry.Run = false;
        entry.MetadataStalled = entry.ProgressStalled = false;
    }

    private static async Task HashCheckBindingsAsync(Entry entry)
    {
        // MonoTorrent skips DoNotDownload files during a hash check. Include filed files
        // for this read-only stopped check, then protect them again before payload starts.
        foreach (var index in entry.Filed)
            await entry.Manager.SetFilePriorityAsync(entry.Manager.Files[index], MonoTorrent.Priority.Normal);
        try
        {
            await entry.Manager.SetNeedsHashCheckAsync();
            await entry.Manager.HashCheckAsync(false);
        }
        finally
        {
            foreach (var index in entry.Filed)
                await entry.Manager.SetFilePriorityAsync(entry.Manager.Files[index], MonoTorrent.Priority.DoNotDownload);
        }
    }

    private static void UpdateUploaded(Entry entry)
    {
        var current = entry.Manager.Monitor.DataBytesSent;
        entry.Uploaded += current >= entry.LastUploaded ? current - entry.LastUploaded : current;
        entry.LastUploaded = current;
    }

    private static long SelectedCompletedBytes(TorrentManager manager) => manager.HasMetadata
        ? manager.Files.Where(f => f.Priority != MonoTorrent.Priority.DoNotDownload)
            .Sum(f => CompletedFileBytes(manager, f)) : 0;

    private async Task ObserveDownloadAsync(Entry entry)
    {
        if (entry.Bound && SelectedComplete(entry.Manager))
        {
            await CompleteDownloadAsync(entry);
            return;
        }
        // HasMetadata becomes true before MonoTorrent finishes building its file list.
        // A metadata-only manager must be drained before that list is exposed for binding.
        if (!entry.Bound && MetadataReady(entry.Manager))
        {
            if (entry.Manager.State != TorrentState.Stopped)
                await StopDownloadAsync(entry);
            foreach (var file in entry.Manager.Files)
                await entry.Manager.SetFilePriorityAsync(file, MonoTorrent.Priority.DoNotDownload);
        }
        if (MetadataReady(entry.Manager) && !entry.MetadataReported)
        {
            entry.MetadataReported = true;
            await EmitAsync(entry, "metadata");
        }
        if (!entry.Run) return;
        if (!entry.Manager.HasMetadata)
        {
            if (!entry.MetadataStalled &&
                Stopwatch.GetElapsedTime(entry.ActiveSince).TotalSeconds >= settings.MetadataStallSeconds)
            {
                entry.MetadataStalled = true;
                await EmitAsync(entry, "stalled_metadata");
            }
            return;
        }
        if (!entry.Bound) return;
        var bytes = SelectedCompletedBytes(entry.Manager);
        if (bytes - entry.ProgressBaseline >= settings.ProgressStallBytes)
        {
            entry.ProgressBaseline = bytes;
            entry.ProgressSince = Stopwatch.GetTimestamp();
            entry.ProgressStalled = false;
        }
        else if (!entry.ProgressStalled &&
            Stopwatch.GetElapsedTime(entry.ProgressSince).TotalSeconds >= settings.ProgressStallSeconds)
        {
            entry.ProgressStalled = true;
            await EmitAsync(entry, "stalled_progress");
        }
    }

    private async Task CompleteDownloadAsync(Entry entry)
    {
        if (entry.Completed) return;
        await StopDownloadAsync(entry);
        entry.Completed = true;
        entry.WantsRun = false;
        entry.MetadataStalled = entry.ProgressStalled = false;
        await SaveResumeAsync(entry.Manager);
        await EmitAsync(entry, "completed");
    }

    private async Task EmitAsync(Entry entry, string kind)
    {
        // Snapshots remain authoritative even if a diagnostic consumer falls behind.
        if (downloadEvents.Count == 500) downloadEvents.Dequeue();
        downloadEvents.Enqueue(new(entry.Id, Hash(entry.Manager), kind, await SnapshotAsync(entry)));
    }

    private static void RefusePayloadLinks(string path)
    {
        for (var current = path; current is not null; current = Path.GetDirectoryName(current))
            if ((File.Exists(current) || Directory.Exists(current)) &&
                (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("Download paths cannot traverse links or junctions.");
    }

    public async Task<ImmutableArray<TorrentFlow.Domain.TorrentFile>?> MetadataAsync(string hash, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            if (entries.TryGetValue(hash, out var entry)) return Files(entry.Manager);
            var torrent = await LoadCachedTorrentAsync(hash);
            if (torrent is null) return null;
            return [.. torrent.Files.Select((f, i) =>
                new TorrentFlow.Domain.TorrentFile(i, f.Path, f.Length, f.OffsetInTorrent))];
        }
        finally { gate.Release(); }
    }

    private async Task<MonoTorrent.Torrent?> LoadCachedTorrentAsync(string hash)
    {
        var path = Path.Combine(directory, $"{hash}.torrent");
        if (!File.Exists(path)) path = Path.Combine(directory, "metadata", hash.ToUpperInvariant() + ".torrent");
        if (!File.Exists(path)) return null;
        var torrent = await MonoTorrent.Torrent.LoadAsync(path);
        if (torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant() != hash)
            throw new InvalidDataException("Cached torrent metadata does not match the requested hash.");
        return torrent;
    }

    public async Task LimitDevRateAsync(int bytesPerSecond, CancellationToken ct)
    {
        if (bytesPerSecond < 0) throw new ArgumentOutOfRangeException(nameof(bytesPerSecond));
        await gate.WaitAsync(ct);
        try
        {
            await client.UpdateSettingsAsync(new EngineSettingsBuilder(client.Settings)
                { MaximumDownloadRate = bytesPerSecond }.ToSettings());
        }
        finally { gate.Release(); }
    }

}
