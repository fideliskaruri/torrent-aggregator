using System.Collections.Concurrent;
using System.Net;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MonoTorrent;
using MonoTorrent.Client;
using MonoTorrent.Connections;

namespace TorrentFlow.Engine.Client;

/// <summary>
/// Singleton owner of MonoTorrent's <see cref="ClientEngine"/>. All torrents are added with
/// <c>AddStreamingAsync</c> so any of them can serve a read stream; the streaming piece picker still
/// downloads every selected piece, it just goes to the read position first when a stream is open.
/// </summary>
internal sealed class MonoTorrentBackend : ITorrentBackend, IAsyncDisposable
{
    private readonly ILogger<MonoTorrentBackend> _logger;
    private readonly EngineOptions _options;
    private readonly ConcurrentDictionary<string, TorrentManager> _managers = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, string> _errors = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, byte[]> _metadata = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, string> _purposes = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim _gate = new(1, 1);

    public MonoTorrentBackend(IOptions<EngineOptions> options, ILogger<MonoTorrentBackend> logger)
    {
        _logger = logger;
        _options = options.Value;
        Directory.CreateDirectory(_options.EngineDirectory);
        Engine = new ClientEngine(BuildSettings(_options));
    }

    public ClientEngine Engine { get; }

    internal static EngineSettings BuildSettings(EngineOptions o)
    {
        // Port 0 would be announced verbatim: trackers drop "port=0" peers and DHT cannot bind it, so resolve a real port.
        var listen = new IPEndPoint(IPAddress.Any, o.ListenPort > 0 ? o.ListenPort : FreePort());
        var builder = new EngineSettingsBuilder
        {
            MaximumConnections = o.MaxConnections,
            MaximumHalfOpenConnections = o.MaxHalfOpenConnections,
            DiskCacheBytes = (int)Math.Min(int.MaxValue, o.DiskCacheBytes),
            MaximumOpenFiles = o.MaxOpenFiles,
            MaximumUploadRate = (int)Math.Min(int.MaxValue, o.MaxUploadRate),
            AllowPortForwarding = o.PortForwarding,
            AllowLocalPeerDiscovery = o.LocalPeerDiscovery,
            AutoSaveLoadDhtCache = o.Dht,
            AutoSaveLoadFastResume = true,
            AutoSaveLoadMagnetLinkMetadata = true,
            CacheDirectory = o.EngineDirectory,
            AllowedEncryption = [EncryptionType.RC4Full, EncryptionType.RC4Header, EncryptionType.PlainText],
            ListenEndPoints = new Dictionary<string, IPEndPoint> { ["ipv4"] = listen },
            DhtEndPoint = o.Dht ? listen : null,
        };
        return builder.ToSettings();
    }

    private static int FreePort()
    {
        var probe = new System.Net.Sockets.TcpListener(IPAddress.Any, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }

    private TorrentSettings TorrentSettingsFor(string purpose) => new TorrentSettingsBuilder
    {
        MaximumConnections = purpose == Core.Contracts.Engine.TorrentPurpose.Prewarm
            ? Math.Min(_options.PrewarmMaxConnections, _options.MaxConnectionsPerTorrent)
            : _options.MaxConnectionsPerTorrent,
        AllowDht = _options.Dht,
        AllowPeerExchange = true,
        // qBittorrent "NoSubfolder": files land directly in the save path; the torrent's container folder is dropped.
        CreateContainingDirectory = false,
    }.ToSettings();

    public async Task<BackendAddOutcome> AddAsync(BackendAddSpec spec, CancellationToken ct)
    {
        TorrentManager manager;
        await _gate.WaitAsync(ct);
        try
        {
            if (_managers.TryGetValue(spec.Hash, out var existing))
                return new BackendAddOutcome(true, "", Snapshot(existing));

            Directory.CreateDirectory(spec.SavePath);
            var settings = TorrentSettingsFor(spec.Purpose);
            if (spec.TorrentBytes is { Length: > 0 })
            {
                var torrent = Torrent.Load(spec.TorrentBytes);
                _metadata[spec.Hash] = spec.TorrentBytes;
                manager = await Engine.AddStreamingAsync(torrent, spec.SavePath, settings);
            }
            else if (spec.Magnet is not null && MagnetLink.TryParse(spec.Magnet, out var magnet) && magnet is not null)
            {
                manager = await Engine.AddStreamingAsync(magnet, spec.SavePath, settings);
            }
            else
            {
                return new BackendAddOutcome(false, "No magnet or torrent URL provided.");
            }

            _errors.TryRemove(spec.Hash, out _);
            manager.TorrentStateChanged += OnStateChanged;
            _purposes[spec.Hash] = spec.Purpose;
            _managers[spec.Hash] = manager;
            if (manager.HasMetadata && spec.Purpose != Core.Contracts.Engine.TorrentPurpose.Keep) await DeselectAllAsync(manager);
            await manager.StartAsync();
        }
        finally
        {
            _gate.Release();
        }

        if (spec.MetadataTimeout is { } timeout && !manager.HasMetadata)
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(timeout);
            try
            {
                await manager.WaitForMetadataAsync(cts.Token);
            }
            catch (OperationCanceledException)
            {
                await RemoveAsync(spec.Hash);
                return new BackendAddOutcome(false,
                    "Timed out waiting for torrent metadata (no peers / blocked DHT?). Try another release or check network.");
            }
        }
        return new BackendAddOutcome(true, "", Snapshot(manager));
    }

    private static async Task DeselectAllAsync(TorrentManager manager)
    {
        foreach (var file in manager.Files)
            if (file.Priority != Priority.DoNotDownload) await manager.SetFilePriorityAsync(file, Priority.DoNotDownload);
    }

    private void OnStateChanged(object? sender, TorrentStateChangedEventArgs e)
    {
        // Stream/prewarm fetch only what the player asks for, so their files start deselected once metadata lands.
        if (e.OldState == TorrentState.Metadata && e.TorrentManager.HasMetadata
            && _purposes.TryGetValue(HashOf(e.TorrentManager), out var purpose) && purpose != Core.Contracts.Engine.TorrentPurpose.Keep)
            _ = DeselectAllAsync(e.TorrentManager).ContinueWith(
                t => _logger.LogWarning(t.Exception, "Deselecting files failed"), TaskContinuationOptions.OnlyOnFaulted);
        if (e.NewState == TorrentState.Error && e.TorrentManager.Error is { } error)
        {
            var hash = HashOf(e.TorrentManager);
            _errors[hash] = error.Exception?.Message ?? error.Reason.ToString();
            _logger.LogWarning(error.Exception, "Torrent {Hash} entered error state: {Reason}", hash, error.Reason);
        }
    }

    public bool Contains(string hash) => _managers.ContainsKey(hash);

    public BackendSnapshot? Get(string hash) => _managers.TryGetValue(hash, out var m) ? Snapshot(m) : null;

    public IReadOnlyList<BackendSnapshot> List() => _managers.Values.Select(Snapshot).ToList();

    public async Task PauseAsync(string hash)
    {
        // Stop, not Pause: a MonoTorrent pause keeps peer connections open, which is exactly the memory we want back.
        if (_managers.TryGetValue(hash, out var m) && m.State is not (TorrentState.Stopped or TorrentState.Stopping))
            await m.StopAsync(TimeSpan.FromSeconds(10));
    }

    public async Task ResumeAsync(string hash)
    {
        if (_managers.TryGetValue(hash, out var m) && m.State is TorrentState.Stopped or TorrentState.Paused or TorrentState.Error)
            await m.StartAsync();
    }

    public async Task RemoveAsync(string hash)
    {
        if (!_managers.TryRemove(hash, out var m)) return;
        m.TorrentStateChanged -= OnStateChanged;
        try
        {
            if (m.State is not TorrentState.Stopped) await m.StopAsync(TimeSpan.FromSeconds(10));
            await Engine.RemoveAsync(m, RemoveMode.CacheDataOnly);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Removing torrent {Hash} from the client failed", hash);
        }

        // Per-hash side state must go with the manager, or it grows with every transfer ever run. The service keeps
        // its own .torrent copy on disk. Under the gate so a concurrent re-add of the same hash keeps its entries.
        await _gate.WaitAsync();
        try
        {
            if (!_managers.ContainsKey(hash))
            {
                _metadata.TryRemove(hash, out _);
                _purposes.TryRemove(hash, out _);
                _errors.TryRemove(hash, out _);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task SetSelectedFilesAsync(string hash, IReadOnlySet<int>? selected)
    {
        // Selecting everything makes it a kept download: metadata landing later must not deselect it as a stream.
        if (selected is null && _purposes.ContainsKey(hash)) _purposes[hash] = Core.Contracts.Engine.TorrentPurpose.Keep;
        if (!_managers.TryGetValue(hash, out var m) || !m.HasMetadata) return;
        for (var i = 0; i < m.Files.Count; i++)
        {
            var want = selected is null || selected.Contains(i) ? Priority.Normal : Priority.DoNotDownload;
            if (m.Files[i].Priority != want) await m.SetFilePriorityAsync(m.Files[i], want);
        }
    }

    public async Task<Stream> OpenStreamAsync(string hash, int fileIndex, CancellationToken ct)
    {
        if (!_managers.TryGetValue(hash, out var m)) throw new FileNotFoundException($"Torrent {hash} is not live.");
        if (!m.HasMetadata) await m.WaitForMetadataAsync(ct);
        if (fileIndex < 0 || fileIndex >= m.Files.Count) throw new ArgumentOutOfRangeException(nameof(fileIndex));
        var file = m.Files[fileIndex];
        if (file.Priority == Priority.DoNotDownload) await m.SetFilePriorityAsync(file, Priority.Normal);
        if (m.State is TorrentState.Stopped or TorrentState.Paused) await m.StartAsync();
        if (m.StreamProvider is null) throw new InvalidOperationException("Torrent was not added in streaming mode.");
        return await m.StreamProvider.CreateStreamAsync(file, prebuffer: false, ct);
    }

    public byte[]? GetMetadata(string hash)
    {
        if (_metadata.TryGetValue(hash, out var bytes)) return bytes;
        var cached = Path.Combine(_options.EngineDirectory, "metadata", hash.ToUpperInvariant() + ".torrent");
        return File.Exists(cached) ? File.ReadAllBytes(cached) : null;
    }

    /// <summary>Test seam for the loopback swarm: connect to a known peer without trackers or DHT.</summary>
    internal async Task AddPeerAsync(string hash, IPEndPoint endPoint)
    {
        if (_managers.TryGetValue(hash, out var m))
            await m.AddPeerAsync(new PeerInfo(new Uri($"ipv4://{endPoint.Address}:{endPoint.Port}")));
    }

    internal static string HashOf(TorrentManager m) => m.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();

    private BackendSnapshot Snapshot(TorrentManager m)
    {
        var hash = HashOf(m);
        var files = new List<BackendFile>();
        long wanted = 0, have = 0;
        if (m.HasMetadata)
        {
            for (var i = 0; i < m.Files.Count; i++)
            {
                var f = m.Files[i];
                var selected = f.Priority != Priority.DoNotDownload;
                var pct = f.BitField.PercentComplete / 100.0;
                files.Add(new BackendFile(i, f.Path, f.FullPath, f.Length, selected, pct));
                if (selected) { wanted += f.Length; have += (long)(f.Length * pct); }
            }
        }
        var progress = wanted > 0 ? Math.Clamp((double)have / wanted, 0, 1) : 0;
        var complete = m.HasMetadata && wanted > 0 && files.Where(f => f.Selected).All(f => f.Progress >= 1);
        var rate = m.Monitor.DownloadRate;
        var state = m.State switch
        {
            TorrentState.Metadata => "metaDL",
            TorrentState.Hashing or TorrentState.FetchingHashes or TorrentState.HashingPaused => "checkingDL",
            TorrentState.Stopped or TorrentState.Stopping or TorrentState.Paused => complete ? "complete" : "paused",
            TorrentState.Error => "error",
            _ when complete => "complete",
            TorrentState.Starting => "metaDL",
            _ => rate > 0 ? "downloading" : "stalledDL",
        };
        _errors.TryGetValue(hash, out var err);
        return new BackendSnapshot(
            hash,
            m.Torrent?.Name ?? m.MagnetLink?.Name ?? hash,
            progress,
            m.Torrent?.Size ?? 0,
            rate,
            m.Monitor.UploadRate,
            m.OpenConnections,
            state,
            m.HasMetadata,
            m.SavePath,
            files,
            err);
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            // Stopping writes fast-resume data; the DB rows (not engine state) drive rehydration.
            await Engine.StopAllAsync(TimeSpan.FromSeconds(10));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Stopping MonoTorrent cleanly failed");
        }
        Engine.Dispose();
    }
}
