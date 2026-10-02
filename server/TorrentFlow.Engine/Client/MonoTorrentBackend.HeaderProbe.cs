using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using Microsoft.Extensions.Logging;
using MonoTorrent;
using MonoTorrent.Client;
using TorrentFlow.Engine.Layout;

namespace TorrentFlow.Engine.Client;

/// <summary>
/// The header probe: reads a release's track list from the container header of its video files before the download is
/// admitted. It loads the torrent in MonoTorrent's streaming mode (<see cref="ClientEngine.AddStreamingAsync(Torrent, string, TorrentSettings)"/>),
/// whose piece requester fetches the pieces under the stream's read position first, and reads the header through the
/// library's own stream, which waits for those pieces. Every file but the probed ones is skipped. Each probe runs in a
/// client of its own (<see cref="CreateProbeEngine"/>), and everything it wrote is deleted before it returns.
/// </summary>
internal sealed partial class MonoTorrentBackend
{
    /// <summary>Hashes being probed; one probe per hash at a time.</summary>
    private readonly ConcurrentDictionary<string, byte> _probes = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, TorrentManager> _probeManagers = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>At most two probes at a time; waiting for a slot counts against a probe's time.</summary>
    private readonly SemaphoreSlim _probeSlots = new(2, 2);

    private string ProbeRoot => Path.Combine(_options.EngineDirectory, "probe");

    public async Task<HeaderProbeResult> ProbeHeadersAsync(byte[]? torrentBytes, IReadOnlyList<int> fileIndices,
        HeaderProbeBudget? budget, CancellationToken ct, bool alongside = false)
    {
        budget ??= HeaderProbeBudget.Default;
        var clock = Stopwatch.StartNew();
        if (torrentBytes is not { Length: > 0 } || !Torrent.TryLoad(torrentBytes, out var torrent))
            return HeaderProbeResult.Skipped(null, HeaderProbeResult.MetadataUnavailable);
        var hash = torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
        var indices = fileIndices.Distinct().Take(Math.Max(0, budget.MaxFiles)).ToList();
        if (indices.Count == 0 || indices.Any(i => i < 0 || i >= torrent.Files.Count))
            return HeaderProbeResult.Skipped(hash, HeaderProbeResult.NoSuchFile);
        // Pieces come whole: one piece has to leave room in the byte budget for the next.
        if (torrent.PieceLength > budget.MaxBytesPerFile / 2) return HeaderProbeResult.Skipped(hash, HeaderProbeResult.PiecesTooLarge);
        // A loaded transfer already has its files; there is nothing to decide before it, unless the caller checks it alongside.
        if (!alongside && _managers.ContainsKey(hash) || !_probes.TryAdd(hash, 0)) return HeaderProbeResult.Skipped(hash, HeaderProbeResult.InUse);

        var files = new List<HeaderProbeFile>();
        string? reason = null;
        long received = 0;
        var swarm = new ProbeSwarm();
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(budget.Timeout);
            try { await _probeSlots.WaitAsync(deadline.Token); }
            catch (OperationCanceledException) { return HeaderProbeResult.Skipped(hash, swarm.StopReason(ct), clock.Elapsed); }
            var dir = Path.Combine(ProbeRoot, hash);
            ClientEngine? engine = null;
            TorrentManager? manager = null;
            try
            {
                DeleteProbeFolder(dir);
                engine = CreateProbeEngine(dir);
                manager = await engine.AddStreamingAsync(torrent, Path.Combine(dir, "files"), TorrentSettingsFor());
                _probeManagers[hash] = manager;
                // Every probed file is wanted from the start: a file switched on later is ignored by the picker until
                // its pieces are hashed, and the client only tells peers it wants them again every 5 seconds. The
                // stream's read position decides which pieces come first.
                var wanted = indices.ToHashSet();
                for (var i = 0; i < manager.Files.Count; i++)
                    if (!wanted.Contains(i)) await manager.SetFilePriorityAsync(manager.Files[i], Priority.DoNotDownload);
                // A late header sits far into its file: in a sparse file only the pieces written take disk space.
                foreach (var index in indices)
                    if (manager.Files[index].Length > 0) CreateSparse(manager.Files[index].FullPath);
                PrepareSparseNeighbours(manager, wanted);
                await OneTrackerPerTierAsync(manager);
                await AddPublicTrackersAsync(manager, _options.EffectivePublicTrackers);
                await manager.StartAsync();
                foreach (var index in indices)
                {
                    deadline.Token.ThrowIfCancellationRequested();
                    files.Add(await ProbeFileAsync(manager, index, budget, swarm, ct, deadline.Token));
                }
            }
            catch (OperationCanceledException) { reason = swarm.StopReason(ct); }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Header probe for {Hash} failed", hash);
                reason = HeaderProbeResult.Failed;
            }
            finally
            {
                if (manager is not null) received = manager.Monitor.DataBytesReceived;
                await ReleaseProbeAsync(hash, engine, manager, dir);
                _probeSlots.Release();
            }
        }
        finally
        {
            _probes.TryRemove(hash, out _);
        }
        reason ??= files.Select(f => f.Scan.Unchecked).FirstOrDefault(r => r is not null);
        if (reason is null && files.Count < indices.Count) reason = swarm.StopReason(ct);
        var result = new HeaderProbeResult(hash, files, reason, received, clock.Elapsed);
        _logger.LogInformation("Header probe for {Hash}: {Outcome}, {Bytes} bytes from peers in {Ms:0} ms; {Files}", hash,
            reason ?? "checked", received, clock.Elapsed.TotalMilliseconds,
            string.Join("; ", files.Select(f => $"{f.Path}: {f.Scan.Container} {f.Scan.Unchecked ?? string.Join(",",
                f.Scan.Tracks.Select(t => $"{t.Kind}:{t.Language ?? t.RawLanguage ?? "untagged"}"))}")));
        return result;
    }

    private async Task<HeaderProbeFile> ProbeFileAsync(TorrentManager manager, int index, HeaderProbeBudget budget,
        ProbeSwarm swarm, CancellationToken caller, CancellationToken deadline)
    {
        var file = manager.Files[index];
        var started = Stopwatch.GetTimestamp();
        var baseline = manager.Monitor.DataBytesReceived;
        var watch = new ProbeWatch();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(deadline);
        // The stream waits for pieces however much the requester fetches around them; this stops the scan once peers
        // have sent the file's byte budget.
        using var watchdog = new Timer(_ =>
        {
            try
            {
                if (manager.OpenConnections > 0 || manager.Monitor.DataBytesReceived > 0) swarm.SawPeers = true;
                if (manager.Monitor.DataBytesReceived - baseline <= budget.MaxBytesPerFile) return;
                watch.OverBudget = true;
                stop.Cancel();
            }
            catch (ObjectDisposedException) { }
        }, null, 100, 100);
        MediaTrackScan scan;
        Stream? stream = null;
        try
        {
            stream = await manager.StreamProvider!.CreateStreamAsync(file, false, stop.Token);
            // The requester starts at the torrent's first piece; a seek away and back points it at this file's first piece.
            if (file.Length > 1)
            {
                stream.Seek(1, SeekOrigin.Begin);
                stream.Seek(0, SeekOrigin.Begin);
            }
            var reader = stream;
            scan = await MediaTracks.ScanAsync(file.Length,
                (offset, count, token) => ReadDownloadedAsync(manager, file, reader, offset, count, token),
                new MediaTrackBudget(budget.MaxBytesPerFile, budget.MaxReadsPerFile), stop.Token);
        }
        catch (OperationCanceledException) { scan = MediaTrackScan.Skipped(MediaTracks.Cancelled); }
        finally
        {
            if (stream is not null) await stream.DisposeAsync();
        }
        if (scan.Unchecked == MediaTracks.Cancelled)
            scan = scan with { Unchecked = watch.OverBudget ? HeaderProbeResult.ByteBudget : swarm.StopReason(caller) };
        return new HeaderProbeFile(index, file.Path, file.Length, scan, manager.Monitor.DataBytesReceived - baseline,
            Stopwatch.GetElapsedTime(started));
    }

    /// <summary>
    /// One range of a file through the library's stream, which waits until the pieces under it are downloaded and hash
    /// checked. The stream also stops waiting when the transfer stops or fails and then reads whatever is on disk, so the
    /// pieces are checked again here.
    /// </summary>
    private static async ValueTask<ReadOnlyMemory<byte>> ReadDownloadedAsync(TorrentManager manager, ITorrentManagerFile file,
        Stream stream, long offset, int count, CancellationToken ct)
    {
        stream.Seek(offset, SeekOrigin.Begin);
        var buffer = new byte[count];
        var read = 0;
        while (read < count)
        {
            var n = await stream.ReadAsync(buffer.AsMemory(read), ct);
            if (n == 0) break;
            read += n;
        }
        if (read > 0)
        {
            long pieceLength = manager.Torrent!.PieceLength;
            var first = (int)((file.OffsetInTorrent + offset) / pieceLength);
            var last = (int)((file.OffsetInTorrent + offset + read - 1) / pieceLength);
            for (var piece = first; piece <= last; piece++)
                if (!manager.Bitfield[piece]) throw new IOException($"Piece {piece} is not downloaded.");
        }
        return buffer.AsMemory(0, read);
    }

    /// <summary>
    /// A client of its own for one probe, disposed with it. MonoTorrent 3.0.2 keys its per-piece disk state (partial
    /// piece hashes, cached blocks) by info hash and keeps it after a transfer is removed, so a probe run in the main
    /// client hands a half-fetched piece to the real download of the same release, which then passes its hash check
    /// with the wrong bytes on disk. A separate client never shares that state, nor the main client's fast-resume.
    /// </summary>
    private ClientEngine CreateProbeEngine(string dir) => new(new EngineSettingsBuilder(Engine.Settings)
    {
        AllowPortForwarding = false,
        AllowLocalPeerDiscovery = false,
        AutoSaveLoadDhtCache = false,
        AutoSaveLoadFastResume = false,
        AutoSaveLoadMagnetLinkMetadata = false,
        CacheDirectory = Path.Combine(dir, "cache"),
        // Its own port, so tracker announces carry a real one; no DHT, so trackers and peer exchange find the peers.
        ListenEndPoints = new Dictionary<string, IPEndPoint> { ["ipv4"] = new(IPAddress.Any, FreePort()) },
        DhtEndPoint = null,
    }.ToSettings(), CreateFactories());

    /// <summary>Stops the probe's transfer and client, then deletes everything it wrote. Never throws.</summary>
    private async Task ReleaseProbeAsync(string hash, ClientEngine? engine, TorrentManager? manager, string dir)
    {
        if (engine is not null)
        {
            try
            {
                if (manager is not null)
                {
                    var until = DateTime.UtcNow.AddSeconds(15);
                    while (manager.State is TorrentState.Stopping && DateTime.UtcNow < until) await Task.Delay(50);
                    // Zero timeout: the "stopped" announce is sent but never awaited.
                    if (manager.State is not TorrentState.Stopped) await manager.StopAsync(TimeSpan.Zero);
                    await engine.RemoveAsync(manager, RemoveMode.CacheDataAndDownloadedData);
                }
                engine.Dispose();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Stopping the header probe for {Hash} failed", hash);
            }
        }
        _probeManagers.TryRemove(hash, out _);
        for (var attempt = 0; attempt < 20 && Directory.Exists(dir); attempt++)
        {
            try { Directory.Delete(dir, recursive: true); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { await Task.Delay(100); }
        }
        if (Directory.Exists(dir)) _logger.LogWarning("Header probe folder {Dir} is still on disk; the next start clears it", dir);
        // The shared parent goes once no probe uses it (a non-recursive delete fails while another probe's folder is there).
        try { Directory.Delete(ProbeRoot); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    private void DeleteProbeFolder(string dir)
    {
        try
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogInformation(ex, "Could not delete header probe folder {Dir}", dir);
        }
    }

    private sealed class ProbeSwarm
    {
        private volatile bool _sawPeers;

        /// <summary>A peer connected or sent data while a file was read.</summary>
        public bool SawPeers { get => _sawPeers; set => _sawPeers = value; }

        /// <summary>Why a probe stopped before its scans finished: the caller cancelled, or its time ran out.</summary>
        public string StopReason(CancellationToken caller) => caller.IsCancellationRequested ? HeaderProbeResult.Cancelled
            : SawPeers ? HeaderProbeResult.Timeout : HeaderProbeResult.NoPeers;
    }

    private sealed class ProbeWatch
    {
        private volatile bool _overBudget;
        public bool OverBudget { get => _overBudget; set => _overBudget = value; }
    }
}
