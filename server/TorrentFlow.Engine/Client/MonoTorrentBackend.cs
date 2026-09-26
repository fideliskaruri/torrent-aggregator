using System.Collections.Concurrent;
using System.Net;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MonoTorrent;
using MonoTorrent.Client;
using MonoTorrent.Connections;

namespace TorrentFlow.Engine.Client;

/// <summary>
/// Singleton owner of MonoTorrent's <see cref="ClientEngine"/>. Torrents use the standard (rarest-first) picker unless
/// <see cref="EngineOptions.Streaming"/> is on, in which case they are added with <c>AddStreamingAsync</c> so any of
/// them can serve a read stream. The streaming picker downloads sequentially and is much slower on a full download.
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
            // HTTP webseeds (url-list / ws=) are a reliable source; don't sit a minute on a slow swarm before using them.
            WebSeedDelay = TimeSpan.FromSeconds(5),
            WebSeedSpeedTrigger = 512 * 1024,
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

    /// <summary>The stricter of two byte/s limits where 0 (or null) means unlimited.</summary>
    internal static int EffectiveRate(long baseRate, long? windowRate)
    {
        var b = baseRate > 0 ? baseRate : long.MaxValue;
        var w = windowRate is > 0 ? windowRate.Value : long.MaxValue;
        var min = Math.Min(b, w);
        return min == long.MaxValue ? 0 : (int)Math.Min(int.MaxValue, min);
    }

    /// <summary>
    /// Copies the running settings and changes only the two rate fields: rebuilding from options would re-pick the
    /// listen port (port 0 resolves to a fresh free port) and rebind DHT.
    /// </summary>
    public async Task ApplyRateLimitsAsync(long? maxDownloadRate, long? maxUploadRate)
    {
        var download = EffectiveRate(0, maxDownloadRate);
        var upload = EffectiveRate(_options.MaxUploadRate, maxUploadRate);
        await _gate.WaitAsync();
        try
        {
            var current = Engine.Settings;
            if (current.MaximumDownloadRate == download && current.MaximumUploadRate == upload) return;
            var builder = new EngineSettingsBuilder(current) { MaximumDownloadRate = download, MaximumUploadRate = upload };
            await Engine.UpdateSettingsAsync(builder.ToSettings());
            _logger.LogInformation("Engine speed limits now {Down} B/s down, {Up} B/s up (0 = unlimited)", download, upload);
        }
        finally
        {
            _gate.Release();
        }
    }

    private TorrentSettings TorrentSettingsFor(string purpose, bool createContainingDirectory = true) => new TorrentSettingsBuilder
    {
        MaximumConnections = purpose == Core.Contracts.Engine.TorrentPurpose.Prewarm
            ? Math.Min(_options.PrewarmMaxConnections, _options.MaxConnectionsPerTorrent)
            : _options.MaxConnectionsPerTorrent,
        AllowDht = _options.Dht,
        AllowPeerExchange = true,
        // A multi-file torrent downloads into its own release folder, so two releases sharing a season folder never
        // write over each other mid-download. When a torrent is re-added against files we already laid out, the engine
        // can ask MonoTorrent to use the flat paths directly and hash-check those files instead.
        CreateContainingDirectory = createContainingDirectory,
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
            var settings = TorrentSettingsFor(spec.Purpose, spec.CreateContainingDirectory);
            if (spec.TorrentBytes is { Length: > 0 })
            {
                var torrent = Torrent.Load(spec.TorrentBytes);
                _metadata[spec.Hash] = spec.TorrentBytes;
                manager = _options.Streaming
                    ? await Engine.AddStreamingAsync(torrent, spec.SavePath, settings)
                    : await Engine.AddAsync(torrent, spec.SavePath, settings);
            }
            else if (spec.Magnet is not null && MagnetLink.TryParse(spec.Magnet, out var magnet) && magnet is not null)
            {
                manager = _options.Streaming
                    ? await Engine.AddStreamingAsync(magnet, spec.SavePath, settings)
                    : await Engine.AddAsync(magnet, spec.SavePath, settings);
            }
            else
            {
                return new BackendAddOutcome(false, "No magnet or torrent URL provided.");
            }

            _errors.TryRemove(spec.Hash, out _);
            if (spec.ForceHashCheck && spec.FilePaths is { Count: > 0 })
            {
                try
                {
                    if (!manager.HasMetadata) throw new IOException("File mappings require torrent metadata.");
                    for (var index = 0; index < manager.Files.Count; index++)
                    {
                        var file = manager.Files[index];
                        if (index >= spec.FilePaths.Count || spec.FilePaths[index] is not { } mapped || mapped == file.FullPath) continue;
                        if (File.Exists(file.FullPath)) throw new IOException("Cannot import a renamed file when both payload names exist.");
                        if (!File.Exists(mapped)) throw new IOException("The renamed payload disappeared. Scan again before importing.");
                        // Hold the destination against deletion/rename. MonoTorrent only changes its mapping when
                        // the original path is absent; it never overwrites this existing destination.
                        using var hold = new FileStream(mapped, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                        await manager.MoveFileAsync(file, mapped);
                    }
                }
                catch
                {
                    await Engine.RemoveAsync(manager, RemoveMode.CacheDataOnly);
                    _metadata.TryRemove(spec.Hash, out _);
                    throw;
                }
            }
            manager.TorrentStateChanged += OnStateChanged;
            await OneTrackerPerTierAsync(manager);
            if (!spec.ForceHashCheck || manager.HasMetadata)
                await AddPublicTrackersAsync(manager, _options.EffectivePublicTrackers);
            _purposes[spec.Hash] = spec.Purpose;
            _managers[spec.Hash] = manager;
            if (!spec.ForceHashCheck && spec.FilePaths is { } paths && manager.HasMetadata) await PointAtLaidOutFilesAsync(manager, paths);
            else if (spec.FlattenWrapper && manager.HasMetadata) await DropWrapperAsync(manager, spec.SavePath);
            if (manager.HasMetadata && spec.Purpose != Core.Contracts.Engine.TorrentPurpose.Keep) await DeselectAllAsync(manager);
            // Also applies to magnets: MetadataMode re-enters StartAsync after receiving metadata,
            // and StartingMode must hash before downloading when this flag is cleared.
            if (spec.ForceHashCheck) await manager.SetNeedsHashCheckAsync();
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
            if (spec.FlattenWrapper && spec.FilePaths is null)
            {
                await _gate.WaitAsync(CancellationToken.None);
                try
                {
                    if (_managers.TryGetValue(spec.Hash, out var live) && ReferenceEquals(live, manager))
                    {
                        await manager.StopAsync();
                        await DropWrapperAsync(manager, spec.SavePath);
                        await manager.StartAsync();
                    }
                }
                finally
                {
                    _gate.Release();
                }
            }
        }
        return new BackendAddOutcome(true, "", Snapshot(manager));
    }

    /// <summary>
    /// Downloads a multi-file torrent without its release folder, as the Next.js engine and qBittorrent's NoSubfolder do:
    /// each file of a stopped manager is pointed at <c>&lt;save path&gt;/&lt;torrent path&gt;</c>. A file stays in the
    /// release folder when that path is taken — something is on disk there, a parent is a file, or another loaded
    /// torrent writes there — so two releases never write over each other; the completed layout moves it later.
    /// Caller holds the gate.
    /// </summary>
    private async Task DropWrapperAsync(TorrentManager manager, string savePath)
    {
        if (manager.Files.Count == 0) return;
        var root = Path.GetFullPath(savePath);
        var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var other in _managers.Values)
            if (!ReferenceEquals(other, manager) && other.HasMetadata)
                foreach (var f in other.Files) taken.Add(Path.GetFullPath(f.FullPath));
        foreach (var file in manager.Files)
        {
            var target = Path.GetFullPath(Path.Combine(root, file.Path));
            if (string.Equals(target, Path.GetFullPath(file.FullPath), StringComparison.OrdinalIgnoreCase)) continue;
            if (!Layout.ContentLayoutPolicy.IsInside(root, target) || !taken.Add(target) || Blocked(root, target)) continue;
            try { await manager.MoveFileAsync(file, target); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
        // A release folder emptied by the move (files left from an earlier attempt) would linger in the season folder.
        if (manager.Torrent?.Name is { Length: > 0 } name && Path.Combine(root, name) is var wrapper && Directory.Exists(wrapper))
            DeleteEmptyTree(wrapper);
    }

    private static void DeleteEmptyTree(string dir)
    {
        try
        {
            foreach (var sub in Directory.EnumerateDirectories(dir)) DeleteEmptyTree(sub);
            if (!Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    private static bool Blocked(string root, string target)
    {
        if (File.Exists(target) || Directory.Exists(target)) return true;
        for (var dir = Path.GetDirectoryName(target); dir is not null && dir.Length > root.Length; dir = Path.GetDirectoryName(dir))
            if (File.Exists(dir)) return true;
        return false;
    }

    /// <summary>
    /// Re-points a stopped manager's files at where an earlier layout put them. MonoTorrent's MoveFileAsync also moves a
    /// file found at the old path, so a file is only re-pointed when nothing sits at its default path (the release
    /// folder this torrent owns); a leftover there is simply re-checked in place.
    /// </summary>
    private static async Task PointAtLaidOutFilesAsync(TorrentManager manager, IReadOnlyList<string?> paths)
    {
        if (paths.Count != manager.Files.Count) return;
        for (var i = 0; i < paths.Count; i++)
        {
            var file = manager.Files[i];
            if (paths[i] is not { } target || string.Equals(Path.GetFullPath(target), Path.GetFullPath(file.FullPath), StringComparison.OrdinalIgnoreCase)) continue;
            if (File.Exists(file.FullPath) || Directory.Exists(file.FullPath)) continue;
            // A file that cannot be re-pointed is downloaded into the release folder again and laid out afterwards.
            try { await manager.MoveFileAsync(file, target); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
    }

    /// <summary>
    /// MonoTorrent announces to one tracker per tier and sticks with it while it answers. Magnets and most public
    /// torrents put every tracker in one tier, so a tracker that answers with zero peers stalls the download for a
    /// whole announce interval (seen after a restart: 120 seeders, 0 peers). Give each tracker its own tier so every
    /// one is announced to, as WebTorrent does in the Next app.
    /// </summary>
    internal static async Task OneTrackerPerTierAsync(TorrentManager manager)
    {
        var trackers = manager.TrackerManager;
        if (trackers.Private) return;
        foreach (var tier in trackers.Tiers.ToList())
        {
            foreach (var tracker in tier.Trackers.Skip(1).ToList())
            {
                if (await trackers.RemoveTrackerAsync(tracker)) await trackers.AddTrackerAsync(tracker);
            }
        }
    }

    /// <summary>
    /// Indexer .torrent files often list one or two trackers; magnets are widened before they get here. Adding the
    /// public trackers to every public torrent (each in its own tier) finds far more of the swarm. Private torrents
    /// must only talk to their own tracker.
    /// </summary>
    internal static async Task AddPublicTrackersAsync(TorrentManager manager, IReadOnlyList<string> trackers)
    {
        var tiers = manager.TrackerManager;
        if (tiers.Private || trackers.Count == 0) return;
        var known = tiers.Tiers.SelectMany(t => t.Trackers).Select(t => t.Uri.AbsoluteUri.TrimEnd('/'))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var url in trackers)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || !known.Add(uri.AbsoluteUri.TrimEnd('/'))) continue;
            await tiers.AddTrackerAsync(uri);
        }
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

    public IReadOnlyCollection<string> LiveHashes() => _managers.Keys.ToList();

    public async Task PauseAsync(string hash)
    {
        // Stop, not Pause: a MonoTorrent pause keeps peer connections open, which is exactly the memory we want back.
        if (_managers.TryGetValue(hash, out var m) && m.State is not (TorrentState.Stopped or TorrentState.Stopping))
            await m.StopAsync(TimeSpan.FromSeconds(10));
    }

    public async Task ResumeAsync(string hash)
    {
        if (!_managers.TryGetValue(hash, out var m)) return;
        // A pause stops the manager, which announces "stopped" to every tracker first; resuming in that window used to
        // be a silent no-op, leaving the torrent paused after the owner pressed resume.
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (m.State is TorrentState.Stopping && DateTime.UtcNow < deadline) await Task.Delay(100);
        if (m.State is TorrentState.Stopped or TorrentState.Paused or TorrentState.Error)
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
        if (m.StreamProvider is null) throw new InvalidOperationException("Streaming is turned off.");
        return await _sharedStreams.GetValue(m, static mgr => new SharedTorrentStreams(mgr)).OpenAsync(file, ct);
    }

    internal bool HasSideState(string hash) =>
        _metadata.ContainsKey(hash) || _purposes.ContainsKey(hash) || _errors.ContainsKey(hash);
    private readonly System.Runtime.CompilerServices.ConditionalWeakTable<TorrentManager, SharedTorrentStreams> _sharedStreams = new();

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
            err)
        { BytesReceived = m.Monitor.DataBytesReceived, PieceBitfield = complete ? PieceBitfieldOf(m) : null };
    }

    /// <summary>TS bitfieldBase64: one bit per piece, most significant bit first.</summary>
    internal static string? PieceBitfieldOf(TorrentManager m)
    {
        var bits = m.Bitfield;
        if (!m.HasMetadata || bits.Length == 0) return null;
        var bytes = new byte[(bits.Length + 7) / 8];
        for (var i = 0; i < bits.Length; i++)
            if (bits[i]) bytes[i >> 3] |= (byte)(0x80 >> (i & 7));
        return Convert.ToBase64String(bytes);
    }

    public IReadOnlyList<(long Start, long End)> DownloadedRanges(string hash, int fileIndex)
    {
        if (!_managers.TryGetValue(hash, out var m) || !m.HasMetadata || m.Torrent is null) return [];
        if (fileIndex < 0 || fileIndex >= m.Files.Count) return [];
        var file = m.Files[fileIndex];
        if (file.Length <= 0) return [];
        var pieceLength = (long)m.Torrent.PieceLength;
        var bitfield = m.Bitfield;
        var fileStart = file.OffsetInTorrent;
        var fileEnd = fileStart + file.Length;
        var ranges = new List<(long Start, long End)>();
        for (var piece = file.StartPieceIndex; piece <= file.EndPieceIndex && piece < bitfield.Length; piece++)
        {
            if (!bitfield[piece]) continue;
            var start = Math.Clamp(Math.Max(piece * pieceLength, fileStart) - fileStart, 0, file.Length);
            var end = Math.Clamp(Math.Min((piece + 1) * pieceLength, fileEnd) - fileStart, 0, file.Length);
            if (end <= start) continue;
            if (ranges.Count > 0 && start <= ranges[^1].End) ranges[^1] = (ranges[^1].Start, Math.Max(ranges[^1].End, end));
            else ranges.Add((start, end));
        }
        return ranges;
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
