using System.Collections.Immutable;
using System.Diagnostics;
using System.Text.RegularExpressions;
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
                (!e.Bound || SelectedFiles(e).Length > 0) &&
                FiledIntact(e) &&
                (!e.Bound || !SelectedComplete(e)) &&
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
        var winners = new HashSet<Entry>();
        var releases = new Dictionary<Entry, HashSet<int>>();
        var budget = settings.MaxActiveDownloads;
        foreach (var slot in slots)
        {
            var now = queueOrder.GetValueOrDefault(slot.Owner.Id)?.Now == true;
            if (!now && budget <= 0) continue;
            foreach (var entry in slot.Entries) winners.Add(entry);

            var groups = slot.Entries.Where(e => e.Bound && MetadataReady(e.Manager))
                .ToDictionary(e => e, PendingGroups);
            HashSet<int> ReleaseSet(Entry entry)
            {
                if (!releases.TryGetValue(entry, out var set)) releases[entry] = set = [];
                return set;
            }

            if (now)
            {
                foreach (var entry in slot.Entries.Where(e => groups.ContainsKey(e)))
                    foreach (var file in groups[entry].SelectMany(g => g.Indices))
                        ReleaseSet(entry).Add(file);
                continue;
            }

            foreach (var entry in groups.Keys)
                foreach (var free in groups[entry].Where(group => group.Free))
                    foreach (var file in free.Indices) ReleaseSet(entry).Add(file);

            var paidGroups = groups.ToDictionary(pair => pair.Key,
                pair => pair.Value.Where(group => !group.Free).ToArray());
            foreach (var entry in slot.Entries)
            {
                if (!groups.ContainsKey(entry))
                {
                    budget--;
                    continue;
                }
                if (paidGroups[entry].FirstOrDefault() is not { } first) continue;
                foreach (var file in first.Indices) ReleaseSet(entry).Add(file);
                budget--;
            }

            foreach (var entry in slot.Entries.Where(groups.ContainsKey))
            {
                foreach (var group in paidGroups[entry])
                {
                    if (group.Indices.All(ReleaseSet(entry).Contains)) continue;
                    if (budget <= 0) break;
                    foreach (var file in group.Indices) ReleaseSet(entry).Add(file);
                    budget--;
                }
            }
        }
        // Drain losers before starting winners: lowering a cap never transiently exceeds it.
        foreach (var entry in entries.Values.Where(e => !e.Probe && e.Run && !winners.Contains(e)))
        {
            log($"Queue stop {entry.Id}: wantsRun={entry.WantsRun}, complete={entry.Completed}, " +
                $"eligible={queueOrder.GetValueOrDefault(entry.Id)?.Eligible}, " +
                $"selected={SelectedFiles(entry).Length}, cap={settings.MaxActiveDownloads}.");
            await StopDownloadAsync(entry);
        }
        foreach (var entry in ordered.Where(winners.Contains))
        {
            if (entry.Bound && MetadataReady(entry.Manager))
            {
                try { await ApplyHoldsAsync(entry, releases.GetValueOrDefault(entry) ?? []); }
                catch (Exception ex)
                {
                    log($"Applying download-slot holds failed for {entry.Id}: {ex.Message}");
                    try { await ClearHoldsAsync(entry); }
                    catch (Exception restore) { log($"Clearing download-slot holds failed for {entry.Id}: {restore.Message}"); }
                }
            }
            if (entry.Run) continue;
            entry.ActiveSince = entry.ProgressSince = Stopwatch.GetTimestamp();
            entry.ProgressBaseline = SelectedCompletedBytes(entry);
            entry.MetadataStalled = entry.ProgressStalled = false;
            if (!entry.Bound)
            {
                if (!entry.Manager.HasMetadata) continue;
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

    // A boundary piece shared with a file that is not filed yet cannot verify until that
    // neighbour downloads. Only pieces owned by filed files alone must still verify, and a
    // file excused that way must still be on disk at full size.
    private static bool FiledIntact(Entry entry)
    {
        var files = entry.Manager.Files;
        foreach (var index in entry.Filed)
        {
            var file = files[index];
            if (file.Length == 0) continue;
            var excused = false;
            for (var piece = file.StartPieceIndex; piece <= file.EndPieceIndex; piece++)
            {
                if (entry.Manager.Bitfield[piece]) continue;
                var shared = false;
                for (var other = 0; other < files.Count && !shared; other++)
                    shared = other != index && files[other].Length > 0 && !entry.Filed.Contains(other) &&
                        files[other].StartPieceIndex <= piece && files[other].EndPieceIndex >= piece;
                if (!shared) return false;
                excused = true;
            }
            if (excused)
            {
                var info = new FileInfo(file.FullPath);
                if (!info.Exists || info.Length != file.Length) return false;
            }
        }
        return true;
    }

    private static async Task HashCheckBindingsAsync(Entry entry)
    {
        // MonoTorrent skips DoNotDownload files during a hash check. Include filed and
        // held files for this read-only check, then protect them again before payload starts.
        foreach (var index in entry.Filed.Concat(entry.Held).Distinct())
            await entry.Manager.SetFilePriorityAsync(entry.Manager.Files[index], MonoTorrent.Priority.Normal);
        try
        {
            await entry.Manager.SetNeedsHashCheckAsync();
            await entry.Manager.HashCheckAsync(false);
        }
        finally
        {
            foreach (var index in entry.Filed.Concat(entry.Held).Distinct())
                await entry.Manager.SetFilePriorityAsync(entry.Manager.Files[index], MonoTorrent.Priority.DoNotDownload);
        }
    }

    private static void UpdateUploaded(Entry entry)
    {
        var current = entry.Manager.Monitor.DataBytesSent;
        entry.Uploaded += current >= entry.LastUploaded ? current - entry.LastUploaded : current;
        entry.LastUploaded = current;
    }

    private static long SelectedCompletedBytes(Entry entry) => entry.Manager.HasMetadata
        ? SelectedFiles(entry).Sum(i => CompletedFileBytes(entry.Manager, entry.Manager.Files[i])) : 0;

    private async Task ObserveDownloadAsync(Entry entry)
    {
        if (entry.Bound && SelectedComplete(entry))
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
        var bytes = SelectedCompletedBytes(entry);
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

    private sealed record PendingFileGroup(int[] Indices, string Path, bool Free);

    private static int[] SelectedFiles(Entry entry) => !entry.Manager.HasMetadata ? [] :
        [.. entry.Manager.Files.Select((file, index) => (file, index))
            .Where(item => item.file.Priority != MonoTorrent.Priority.DoNotDownload || entry.Held.Contains(item.index))
            .Select(item => item.index)];

    private static bool SelectedComplete(Entry entry)
    {
        var selected = SelectedFiles(entry);
        return entry.Manager.HasMetadata && selected.Length > 0 &&
            selected.All(index => entry.Manager.Files[index].BitField.AllTrue);
    }

    private static List<PendingFileGroup> PendingGroups(Entry entry)
    {
        var candidates = SelectedFiles(entry).Where(index => !entry.Manager.Files[index].BitField.AllTrue)
            .Select(index => (Index: index, File: entry.Manager.Files[index]))
            .ToArray();
        var groups = candidates.GroupBy(item => EpisodeGroupKey(item.File.Path), StringComparer.OrdinalIgnoreCase)
            .Select(group =>
            {
                var indices = group.Select(item => item.Index).ToArray();
                var path = group.Select(item => item.File.FullPath)
                    .OrderBy(value => value, StringComparer.OrdinalIgnoreCase).First();
                return new PendingFileGroup(indices, path,
                    indices.Length == 1 && group.Single().File.Length < 1024 * 1024);
            })
            .OrderBy(group => group.Indices.Any(index => !entry.Held.Contains(index) &&
                entry.Manager.Files[index].Priority != MonoTorrent.Priority.DoNotDownload) ? 0 : 1)
            .ThenBy(group => group.Path, StringComparer.OrdinalIgnoreCase)
            .ThenBy(group => group.Indices.Min())
            .ToList();
        return groups;
    }

    private static string EpisodeGroupKey(string torrentPath)
    {
        var normalized = torrentPath.Replace('\\', '/');
        var separator = normalized.LastIndexOf('/');
        var directory = separator < 0 ? string.Empty : normalized[..separator];
        var name = separator < 0 ? normalized : normalized[(separator + 1)..];
        var extension = Path.GetExtension(name);
        var stem = Path.GetFileNameWithoutExtension(name);
        if (extension.ToLowerInvariant() is ".srt" or ".ass" or ".ssa" or ".vtt" or ".sub" or ".idx")
        {
            var dot = stem.LastIndexOf('.');
            if (dot > 0 && Regex.IsMatch(stem[(dot + 1)..], @"^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$",
                    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
                stem = stem[..dot];
        }
        return directory + "/" + stem;
    }

    private static async Task ApplyHoldsAsync(Entry entry, ISet<int> released)
    {
        var selected = SelectedFiles(entry);
        var incomplete = selected.Where(index => !entry.Manager.Files[index].BitField.AllTrue).ToArray();
        var nextHeld = incomplete.Where(index => !released.Contains(index)).ToImmutableHashSet();
        var oldHeld = entry.Held;

        // Hold membership is part of selection, so publish it before lowering priorities.
        entry.Held = oldHeld.Union(nextHeld);
        foreach (var index in selected)
        {
            var priority = entry.Manager.Files[index].BitField.AllTrue || released.Contains(index)
                ? MonoTorrent.Priority.Normal
                : MonoTorrent.Priority.DoNotDownload;
            if (entry.Manager.Files[index].Priority != priority)
                await entry.Manager.SetFilePriorityAsync(entry.Manager.Files[index], priority);
        }
        entry.Held = nextHeld;
        PhysicalFiles.PrepareBoundaries(entry.Manager);
        if (!oldHeld.SetEquals(nextHeld))
        {
            entry.ProgressSince = Stopwatch.GetTimestamp();
            entry.ProgressBaseline = SelectedCompletedBytes(entry);
            entry.ProgressStalled = false;
        }
    }

    private static async Task ClearHoldsAsync(Entry entry)
    {
        var held = entry.Held;
        try
        {
            foreach (var index in held)
                if (index >= 0 && index < entry.Manager.Files.Count &&
                    entry.Manager.Files[index].Priority != MonoTorrent.Priority.Normal)
                    await entry.Manager.SetFilePriorityAsync(entry.Manager.Files[index], MonoTorrent.Priority.Normal);
        }
        finally { entry.Held = ImmutableHashSet<int>.Empty; }
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
