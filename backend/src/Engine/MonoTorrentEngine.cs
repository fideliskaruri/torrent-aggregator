using System.Collections.Immutable;
using System.Net;
using System.Net.Sockets;
using MonoTorrent;
using MonoTorrent.BEncoding;
using MonoTorrent.Client;
using MonoTorrent.Connections;
using MonoTorrent.Dht;
using TorrentFlow.Domain;
using Settings = TorrentFlow.Domain.EngineSettings;
using TorrentFile = TorrentFlow.Domain.TorrentFile;

namespace TorrentFlow.Engine;

/// <summary>One physical client. Targets owns intent; Library owns payload paths.</summary>
public sealed partial class MonoTorrentEngine : IEngine, IExternalEngineAdmission, IAsyncDisposable
{
    private sealed class Entry(TorrentManager manager, string id, bool probe)
    {
        public TorrentManager Manager { get; } = manager;
        public string Id { get; set; } = id;
        public bool Probe { get; set; } = probe;
        public bool Run { get; set; }
        public long Received { get; set; }
        public long LastReceived { get; set; }
        public bool WantsRun { get; set; }
        public string? SharedSlotDownloadId { get; set; }
        public bool Bound { get; set; }
        public bool Completed { get; set; }
        public bool MetadataReported { get; set; }
        public bool MetadataStalled { get; set; }
        public bool ProgressStalled { get; set; }
        public long ActiveSince { get; set; }
        public long ProgressSince { get; set; }
        public long ProgressBaseline { get; set; }
        public long Uploaded { get; set; }
        public long LastUploaded { get; set; }
        public HashSet<int> Filed { get; } = [];
    }

    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly HashMutex hashMutex = new();
    private readonly Dictionary<string, Entry> entries = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, ProbeHandle> handles = [];
    private readonly Dictionary<string, EngineAdmissionClaim> claims = [];
    private readonly Dictionary<string, string> registered = new(StringComparer.OrdinalIgnoreCase);
    private readonly Action<string> log;
    private readonly IEngineFileState? fileState;
    private readonly string directory;
    private readonly int probeSlots;
    private Settings settings = null!;
    private ClientEngine client = null!;
    private DhtBootstrap? dht;
    private bool shuttingDown;
    private bool uncleanRecovery;

    public MonoTorrentEngine(string dataDirectory, Action<string> log, int probeSlots = 6,
        IEngineFileState? fileState = null)
    {
        directory = Path.Combine(dataDirectory, "engine");
        this.log = log;
        this.fileState = fileState;
        this.probeSlots = Math.Clamp(probeSlots, 1, 10);
    }

    public int ListenPort => settings.ListenPort;
    public string CacheDirectory => directory;
    public object PhysicalStatus => new
    {
        listenPort = settings.ListenPort,
        maximumDownloadBytesPerSecond = client.Settings.MaximumDownloadRate,
        dhtState = client.Dht.State.ToString(),
        dhtNodes = client.Dht.NodeCount,
        dhtCacheBytes = dht?.CacheBytes ?? 0,
        dhtReloadedNodes = dht?.ReloadedNodes ?? 0,
        globalConnections = settings.GlobalPeers,
        payloadConnections = settings.PerTorrentPeers,
        probeConnections = Math.Min(12, settings.ProbePeers),
        probeSlots,
        localDiscovery = settings.LocalDiscovery,
        portForwarding = settings.Upnp,
    };

    public async Task InitializeAsync(Settings configuration, Func<int, CancellationToken, Task> persistPort,
        bool restoreDevState, CancellationToken ct)
    {
        Directory.CreateDirectory(directory);
        var activePath = Path.Combine(directory, "session.active");
        uncleanRecovery = File.Exists(activePath);
        await File.WriteAllBytesAsync(activePath, [], ct);
        var port = configuration.ListenPort;
        if (port == 0 || !PortAvailable(port))
        {
            var old = port;
            do { port = FreePort(); } while (!PortAvailable(port));
            log($"Engine listen port {old} {(old == 0 ? "unassigned" : "unavailable")}; using and persisting {port}.");
            await persistPort(port, ct);
        }
        settings = configuration with { ListenPort = port };
        if (uncleanRecovery)
        {
            var resumeDirectory = BuildSettings().FastResumeCacheDirectory;
            var invalidated = 0;
            if (Directory.Exists(resumeDirectory))
                foreach (var artifact in Directory.EnumerateFiles(resumeDirectory, "*.fresume*"))
                {
                    if (!artifact.EndsWith(".fresume", StringComparison.OrdinalIgnoreCase) &&
                        !artifact.EndsWith(".fresume.new", StringComparison.OrdinalIgnoreCase)) continue;
                    File.Delete(artifact);
                    invalidated++;
                }
            log($"Unclean shutdown: invalidated {invalidated} fast-resume artifacts for every hash, including detached downloads.");
        }
        var factories = Factories.Default
            .WithDhtCreator(() =>
            {
                var physical = new ReliableDhtEngine();
                dht = new(physical, directory, log);
                return physical;
            })
            .WithHttpClientCreator(family =>
        {
            var http = Factories.Default.CreateHttpClient(family);
            http.MaxResponseContentBufferSize = 32 * 1024 * 1024;
            return http;
        });
        var statePath = Path.Combine(directory, "dev-engine.state");
        var devRuns = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        var devIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var devBindings = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        if (restoreDevState && File.Exists(statePath))
        {
            var saved = BEncodedDictionary.Decode<BEncodedDictionary>(await File.ReadAllBytesAsync(statePath, ct));
            foreach (var torrent in ((BEncodedList)saved["Torrents"]).Cast<BEncodedDictionary>())
            {
                var hash = NormalizeHash(((BEncodedString)torrent["MagnetLink"]).Text);
                devRuns[hash] =
                    !torrent.TryGetValue("DevRun", out var run) || ((BEncodedNumber)run).Number != 0;
                devIds[hash] = torrent.TryGetValue("DevId", out var id) ? ((BEncodedString)id).Text : hash;
                if (torrent.TryGetValue("DevBound", out var bound)) devBindings[hash] = ((BEncodedNumber)bound).Number != 0;
                if (torrent.TryGetValue("DevRank", out var rank))
                {
                    var now = ((BEncodedNumber)torrent["DevNow"]).Number != 0;
                    queueOrder[devIds[hash]] = new(devIds[hash], ((BEncodedNumber)rank).Number,
                        now ? TargetPriority.Now : TargetPriority.BackCatalogue, now,
                        ((BEncodedNumber)torrent["DevEligible"]).Number != 0);
                }
            }
        }
        try
        {
            client = restoreDevState && File.Exists(statePath)
                ? await ClientEngine.RestoreStateAsync(statePath, factories)
                : new ClientEngine(BuildSettings(), factories);
        }
        catch (IOException) when (restoreDevState)
        {
            log("Development engine artifact is unavailable; replaying durable download intent.");
            client = new ClientEngine(BuildSettings(), factories);
        }
        await client.UpdateSettingsAsync(new EngineSettingsBuilder(BuildSettings())
        {
            MaximumDownloadRate = restoreDevState ? client.Settings.MaximumDownloadRate : 0,
        }.ToSettings());
        if (settings.Dht && dht is not null) await dht.StartAsync(ct);
        var durableFiles = fileState is null ? ImmutableArray<EngineRecoveryFiles>.Empty : await fileState.ReadAsync(ct);
        foreach (var manager in client.Torrents.ToArray())
        {
            var hash = Hash(manager);
            var entry = new Entry(manager, devIds.GetValueOrDefault(hash, hash), false)
            {
                WantsRun = devRuns.GetValueOrDefault(hash, true),
                Bound = devBindings.GetValueOrDefault(hash, manager.HasMetadata),
            };
            entries.Add(hash, entry);
            registered[hash] = entry.Id;
            WatchCompletion(manager);
            if (durableFiles.SingleOrDefault(f => f.DownloadId == entry.Id) is { } durable && manager.HasMetadata)
            {
                await BindAsync(manager, [.. durable.Files.Select(f => new FileBinding(f.FileIndex, f.AbsolutePath, f.Selected))]);
                entry.Filed.UnionWith(durable.Files.Where(f => f.Filed).Select(f => f.FileIndex));
                // Publication changes resume identities. Verify the rebound boundary pieces on replay.
                await HashCheckBindingsAsync(entry);
            }
            if (!uncleanRecovery && manager.HasMetadata && entry.Filed.Count == 0) await LoadResumeAsync(manager);
            if (uncleanRecovery && manager.HasMetadata)
            {
                await HashCheckBindingsAsync(entry);
                log($"Unclean shutdown: rechecked {hash}; recovered {manager.Bitfield.TrueCount} verified pieces.");
            }
            log($"Restored engine artifact for {hash}, verified progress {manager.PartialProgress:F2}%.");
        }
        // Production replay supplies Store's authoritative decisions through Recover/ApplyQueue.
        // Development artifacts start under the cap too, never all-at-once before replay.
        await ReconcileQueueAsync();
        log($"Engine ready on {port}; global peers {settings.GlobalPeers}, payload peers {settings.PerTorrentPeers}, probe slots {probeSlots}.");
    }

    private MonoTorrent.Client.EngineSettings BuildSettings() => new EngineSettingsBuilder
    {
        CacheDirectory = directory,
        AutoSaveLoadDhtCache = false,
        AutoSaveLoadFastResume = false,
        AutoSaveLoadMagnetLinkMetadata = true,
        AllowPortForwarding = settings.Upnp,
        AllowLocalPeerDiscovery = settings.LocalDiscovery,
        MaximumConnections = settings.GlobalPeers,
        MaximumHalfOpenConnections = settings.HalfOpenConnections,
        MaximumOpenFiles = settings.OpenFiles,
        DiskCacheBytes = checked((int)Math.Min(int.MaxValue, settings.DiskCacheBytes)),
        DiskCachePolicy = MonoTorrent.PieceWriter.CachePolicy.WritesOnly,
        AllowedEncryption = [EncryptionType.RC4Full, EncryptionType.RC4Header, EncryptionType.PlainText],
        ListenEndPoints = Socket.OSSupportsIPv6
            ? new() { ["ipv4"] = new(IPAddress.Any, settings.ListenPort), ["ipv6"] = new(IPAddress.IPv6Any, settings.ListenPort) }
            : new() { ["ipv4"] = new(IPAddress.Any, settings.ListenPort) },
        DhtEndPoint = settings.Dht ? new(IPAddress.Any, settings.ListenPort) : null,
        WebSeedDelay = TimeSpan.FromSeconds(2),
        WebSeedSpeedTrigger = 512 * 1024,
        UsePartialFiles = false,
    }.ToSettings();

    private TorrentSettings TorrentSettings(bool probe) => new TorrentSettingsBuilder
    {
        MaximumConnections = probe ? Math.Min(12, settings.ProbePeers) : settings.PerTorrentPeers,
        AllowDht = settings.Dht,
        AllowPeerExchange = settings.Pex,
        AllowInitialSeeding = false,
        CreateContainingDirectory = false,
    }.ToSettings();

    public static string NormalizeHash(string magnetOrHash)
    {
        var link = Link(magnetOrHash);
        return link.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
    }

    private static MagnetLink Link(string value) => MagnetLink.Parse(
        value.Length == 40 && value.All(Uri.IsHexDigit) ? $"magnet:?xt=urn:btih:{value}" : value);
    private static string Hash(TorrentManager manager) => manager.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
    private static Failure Fail(string code, string message) => new(code, message, null, false);
    private static EngineResult Rejected(string code, string message) => new(false, null, Fail(code, message));
    private static bool MetadataReady(TorrentManager manager) => manager.HasMetadata &&
        manager.Files.Count > 0 && manager.Files.Count == manager.Torrent!.Files.Count;
    private static ImmutableArray<TorrentFile>? Files(TorrentManager manager) => !MetadataReady(manager) ? null :
        [.. manager.Files.Select((f, i) => new TorrentFile(i, f.Path, f.Length, f.OffsetInTorrent))];

    public Task<ProbeAttachment> AttachProbeAsync(Candidate candidate, CancellationToken ct) =>
        AttachAsync(candidate, DateTimeOffset.UtcNow.AddMinutes(2), ct);

    private async Task<ProbeAttachment> AttachAsync(Candidate candidate, DateTimeOffset expiry, CancellationToken ct)
    {
        var link = Link(candidate.Release.Magnet ?? candidate.Release.Id);
        var hash = link.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
        using var ownership = await hashMutex.LockAsync(hash, ct);
        await gate.WaitAsync(ct);
        try
        {
            ThrowIfStopped();
            PruneClaims();
            if (registered.ContainsKey(hash) || claims.Values.Any(c => c.Hash == hash))
            {
                if (!entries.TryGetValue(hash, out var live) || live.Probe)
                    return new(null, null, Fail("owned_hash", "This hash is reserved by a download."));
                var liveHandle = new ProbeHandle(Guid.NewGuid().ToString("N"), hash, false, true, expiry);
                handles.Add(liveHandle.Token, liveHandle);
                return new(liveHandle, Files(live.Manager), null);
            }
            if (entries.TryGetValue(hash, out var existing) && existing.Probe)
            {
                var existingHandle = new ProbeHandle(Guid.NewGuid().ToString("N"), hash, true, false, expiry);
                handles.Add(existingHandle.Token, existingHandle);
                return new(existingHandle, Files(existing.Manager), null);
            }
            if (entries.Values.Count(e => e.Probe) >= probeSlots)
                return new(null, null, Fail("probe_capacity", "All metadata inspection slots are in use. Try again when one finishes."));
        }
        finally { gate.Release(); }
        Torrent? torrent = await LoadCachedTorrentAsync(hash);
        if (torrent is null && candidate.Release.TorrentUri is { } uri)
        {
            try
            {
                var metadata = await TorrentMetadata.LoadAsync(uri, hash, ct);
                torrent = metadata.Torrent;
                link = metadata.Magnet ?? link;
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidDataException ||
                ex is OperationCanceledException && !ct.IsCancellationRequested)
            {
                // The source's .torrent host failed; the swarm can still supply metadata via the magnet.
            }
        }
        if (torrent is null)
        {
            var metadataBytes = await client.DownloadMetadataAsync(link, ct);
            var decoded = BEncodedDictionary.Decode<BEncodedDictionary>(metadataBytes.Span);
            if (decoded.TryGetValue("info", out var info) && info is BEncodedDictionary)
            {
                torrent = Torrent.Load(metadataBytes.Span);
            }
            else
            {
                var encoded = new BEncodedDictionary { ["info"] = decoded };
                if (link.AnnounceUrls.Count > 0)
                    encoded["announce-list"] = new BEncodedList(link.AnnounceUrls.Select(uri =>
                        new BEncodedList([(BEncodedValue)new BEncodedString(uri)])));
                if (link.Webseeds.Count > 0)
                    encoded["url-list"] = new BEncodedList(link.Webseeds.Select(uri =>
                        (BEncodedValue)new BEncodedString(uri)));
                torrent = Torrent.Load(encoded);
            }
        }
        await gate.WaitAsync(ct);
        try
        {
            ThrowIfStopped();
            PruneClaims();
            if (registered.ContainsKey(hash) || claims.Values.Any(c => c.Hash == hash))
                return new(null, null, Fail("owned_hash", "This hash is reserved by a download."));
            if (!entries.TryGetValue(hash, out var entry))
            {
                if (entries.Values.Count(e => e.Probe) >= probeSlots)
                    return new(null, null, Fail("probe_capacity", "All metadata inspection slots are in use. Try again when one finishes."));
                var path = Path.Combine(directory, "probes", hash);
                Directory.CreateDirectory(path);
                var manager = await client.AddAsync(torrent, path, TorrentSettings(true));
                entry = new(manager, hash, true);
                entries.Add(hash, entry);
                await ConfigureTrackersAsync(manager);
            }
            var handle = new ProbeHandle(Guid.NewGuid().ToString("N"), hash, true, false, expiry);
            handles.Add(handle.Token, handle);
            return new(handle, Files(entry.Manager), null);
        }
        finally { gate.Release(); }
    }

    public async Task ReleaseProbeAsync(ProbeHandle handle, CancellationToken ct)
    {
        using var ownership = await hashMutex.LockAsync(handle.Hash, ct);
        await gate.WaitAsync(ct);
        try
        {
            if (!handles.TryGetValue(handle.Token, out var owned) || owned != handle) return;
            handles.Remove(handle.Token);
            if (owned.CreatedByProbe && !handles.Values.Any(h => h.Hash == owned.Hash) &&
                entries.TryGetValue(owned.Hash, out var entry) && entry.Probe)
            {
                await RemoveManagerAsync(entry, false);
                entries.Remove(owned.Hash);
                var path = Path.Combine(directory, "probes", owned.Hash);
                if (Directory.Exists(path)) Directory.Delete(path, true);
            }
        }
        finally { gate.Release(); }
    }

    public async Task<EngineResult> ClaimAdmissionAsync(EngineAdmissionClaim claim, CancellationToken ct)
    {
        using var ownership = await hashMutex.LockAsync(claim.Hash, ct);
        await gate.WaitAsync(ct);
        try
        {
            PruneClaims();
            if (claim.ExpiresAt <= DateTimeOffset.UtcNow || claim.ExpiresAt > DateTimeOffset.UtcNow.AddSeconds(90))
                return Rejected("claim_expired", "Admission reservations last at most 90 seconds.");
            if (claim.SharedSlotDownloadId is { } current &&
                !entries.Values.Any(e => !e.Probe && e.Id == current && e.Run && e.Bound && !e.Completed))
                return Rejected("replacement_slot", "The current download no longer owns an active slot.");
            if (claim.FromProbe is { } source && (source.Hash != claim.Hash || source.ExpiresAt <= DateTimeOffset.UtcNow ||
                !handles.TryGetValue(source.Token, out var sourceOwner) || sourceOwner != source))
                return Rejected("invalid_handle", "The metadata capability expired or belongs to another hash.");
            if (registered.TryGetValue(claim.Hash, out var id) && id != claim.DownloadId ||
                claims.Values.Any(c => c.Hash == claim.Hash && c.Token != claim.Token) ||
                entries.TryGetValue(claim.Hash, out var entry) && entry.Probe &&
                    (claim.FromProbe is null || !handles.TryGetValue(claim.FromProbe.Token, out var owned) || owned != claim.FromProbe))
                return Rejected("owned_hash", "This hash already has another owner.");
            claims[claim.Token] = claim;
            return new(true, null, null);
        }
        finally { gate.Release(); }
    }

    public async Task ReleaseAdmissionClaimAsync(string token, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try { claims.Remove(token); }
        finally { gate.Release(); }
    }

    public async Task<EngineResult> AdmitFromProbeAsync(ProbeHandle handle, EngineAdmission admission, CancellationToken ct)
    {
        using var ownership = await hashMutex.LockAsync(handle.Hash, ct);
        await gate.WaitAsync(ct);
        try
        {
            if (admission.Download.Hash != handle.Hash ||
                NormalizeHash(admission.Candidate.Release.Magnet ?? admission.Candidate.Release.Id) != handle.Hash)
                return Rejected("hash_mismatch", "The metadata capability does not match this download.");
            if (!handles.TryGetValue(handle.Token, out var owned) || owned != handle || !owned.CreatedByProbe ||
                owned.ExpiresAt <= DateTimeOffset.UtcNow ||
                !entries.TryGetValue(handle.Hash, out var entry) || !entry.Probe || !entry.Manager.HasMetadata)
                return Rejected("invalid_handle", "The metadata capability is no longer available.");
            var claimFailure = ValidateAdmission(admission);
            if (claimFailure is not null) return new(false, null, claimFailure);
            if (claims.TryGetValue(admission.AdmissionToken, out var reserved) && reserved.FromProbe != handle)
                return Rejected("claim_mismatch", "The admission reservation belongs to another metadata capability.");
            // Transfer the SAME manager, drain and force a full recheck. No cache-invalidating second manager.
            await entry.Manager.StopAsync(TimeSpan.Zero);
            await client.DiskManager.FlushAsync(entry.Manager);
            try { await BindAsync(entry.Manager, admission.Files); }
            catch
            {
                await RemoveManagerAsync(entry, false);
                entries.Remove(handle.Hash);
                foreach (var token in handles.Values.Where(h => h.Hash == handle.Hash).Select(h => h.Token).ToArray())
                { handles.Remove(token); }
                throw;
            }
            await entry.Manager.SetNeedsHashCheckAsync();
            await entry.Manager.HashCheckAsync(false);
            var probePath = Path.Combine(directory, "probes", handle.Hash);
            if (Directory.Exists(probePath)) Directory.Delete(probePath, true);
            entry.Probe = false;
            entry.Id = admission.Download.Id;
            entry.SharedSlotDownloadId = claims[admission.AdmissionToken].SharedSlotDownloadId;
            entry.Bound = true;
            WatchCompletion(entry.Manager);
            registered[handle.Hash] = entry.Id;
            foreach (var token in handles.Values.Where(h => h.Hash == handle.Hash).Select(h => h.Token).ToArray())
            { handles.Remove(token); }
            claims.Remove(admission.AdmissionToken);
            entry.WantsRun = admission.Download.Intent is DownloadIntent.Run or DownloadIntent.Queued;
            await entry.Manager.UpdateSettingsAsync(TorrentSettings(false));
            await ReconcileQueueAsync();
            return new(true, await SnapshotAsync(entry), null);
        }
        finally { gate.Release(); }
    }

    public Task<EngineResult> StartAsync(EngineAdmission admission, CancellationToken ct) =>
        StartAsync(admission, false, ct);

    public async Task<string> ResolveTorrentSourceAsync(string address, CancellationToken ct)
    {
        var result = await TorrentMetadata.LoadAsync(address, null, ct);
        var hash = (result.Torrent?.InfoHashes ?? result.Magnet!.InfoHashes).V1OrV2.ToHex().ToLowerInvariant();
        if (result.Bytes is { } bytes) await PrepareExternalAsync(bytes, hash, ct);
        return hash;
    }

    public async Task<ImmutableArray<TorrentFile>> PrepareExternalAsync(byte[] torrentBytes, string hash, CancellationToken ct)
    {
        var torrent = Torrent.Load(torrentBytes);
        if (torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant() != hash)
            throw new ArgumentException("The exported torrent does not match this transfer.");
        await gate.WaitAsync(ct);
        try { await AtomicWriteAsync(Path.Combine(directory, $"{hash}.torrent"), torrentBytes); }
        finally { gate.Release(); }
        return [.. torrent.Files.Select((f, i) => new TorrentFile(i, f.Path, f.Length, f.OffsetInTorrent))];
    }

    public Task<EngineResult> AdmitExternalAsync(EngineAdmission admission, CancellationToken ct) =>
        StartAsync(admission, true, ct, true);

    private async Task<EngineResult> StartAsync(EngineAdmission admission, bool recovery, CancellationToken ct, bool forceCheck = false)
    {
        using var ownership = await hashMutex.LockAsync(admission.Download.Hash, ct);
        await gate.WaitAsync(ct);
        try
        {
            ThrowIfStopped();
            var failure = ValidateAdmission(admission);
            if (failure is not null) return new(false, null, failure);
            var hash = NormalizeHash(admission.Candidate.Release.Magnet ?? admission.Download.Hash);
            if (hash != admission.Download.Hash) return Rejected("hash_mismatch", "The magnet does not match the admitted hash.");
            if (entries.TryGetValue(hash, out var existing))
                return existing.Probe ? Rejected("probe_owned", "Transfer the metadata capability before starting payload.")
                    : new(true, await SnapshotAsync(existing), null);
            var magnet = Link(admission.Candidate.Release.Magnet ?? hash);
            var metadata = await LoadCachedTorrentAsync(hash);
            TorrentManager manager;
            if (metadata is not null)
            {
                manager = await client.AddAsync(metadata, Path.Combine(directory, "bindings", hash), TorrentSettings(false));
            }
            else if (admission.Candidate.Release.TorrentUri is { } uri)
            {
                TorrentMetadata.Result? resolved = null;
                try { resolved = await TorrentMetadata.LoadAsync(uri, hash, ct); }
                catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidDataException ||
                    ex is OperationCanceledException && !ct.IsCancellationRequested)
                {
                    log($"Torrent file download failed for {hash}, using the magnet instead: {ex.Message}");
                }
                manager = resolved?.Torrent is { } torrent
                    ? await client.AddAsync(torrent, Path.Combine(directory, "bindings", hash), TorrentSettings(false))
                    : await client.AddAsync(resolved?.Magnet ?? magnet, Path.Combine(directory, "bindings", hash), TorrentSettings(false));
            }
            else
                manager = await client.AddAsync(magnet, Path.Combine(directory, "bindings", hash), TorrentSettings(false));
            var entry = new Entry(manager, admission.Download.Id, false)
                { WantsRun = admission.Download.Intent is DownloadIntent.Run or DownloadIntent.Queued,
                    SharedSlotDownloadId = claims.GetValueOrDefault(admission.AdmissionToken)?.SharedSlotDownloadId };
            entries.Add(hash, entry);
            WatchCompletion(manager);
            registered[hash] = entry.Id;
            claims.Remove(admission.AdmissionToken);
            await ConfigureTrackersAsync(manager);
            if (manager.HasMetadata)
            {
                var durable = fileState is null ? null : (await fileState.ReadAsync(ct))
                    .SingleOrDefault(f => f.DownloadId == entry.Id);
                if (durable is not null)
                {
                    admission = admission with { Files = [.. durable.Files.Select(f =>
                        new FileBinding(f.FileIndex, f.AbsolutePath, f.Selected))] };
                    entry.Filed.UnionWith(durable.Files.Where(f => f.Filed).Select(f => f.FileIndex));
                }
                if (!admission.Files.IsDefaultOrEmpty)
                {
                    try { await BindAsync(manager, admission.Files); }
                    catch
                    {
                        await RemoveManagerAsync(entry, true);
                        entries.Remove(hash);
                        throw;
                    }
                    entry.Bound = true;
                }
                else
                    foreach (var file in manager.Files)
                        await manager.SetFilePriorityAsync(file, Priority.DoNotDownload);
                if (entry.Bound && (forceCheck || recovery && uncleanRecovery || entry.Filed.Count > 0))
                {
                    await HashCheckBindingsAsync(entry);
                    log($"Unclean shutdown: rechecked {hash}; recovered {manager.Bitfield.TrueCount} verified pieces.");
                }
                else if (entry.Bound && recovery) await LoadResumeAsync(manager);
            }
            else
            {
                // An ordinary hash/magnet may acquire metadata, but cannot request any
                // payload until the caller supplies its complete, hash-bound path map.
                if (!admission.Files.IsDefaultOrEmpty)
                {
                    await RemoveManagerAsync(entry, true);
                    entries.Remove(hash);
                    return Rejected("metadata_required", "The saved file list has no matching torrent information. Check this release again before downloading.");
                }
            }
            await ReconcileQueueAsync();
            return new(true, await SnapshotAsync(entry), null);
        }
        finally { gate.Release(); }
    }

    private Failure? ValidateAdmission(EngineAdmission admission)
    {
        PruneClaims();
        var hash = admission.Download.Hash;
        if (admission.Download.AdmissionToken != admission.AdmissionToken)
            return Fail("claim_mismatch", "The admission token does not match the durable download.");
        if (registered.TryGetValue(hash, out var id))
            return id == admission.Download.Id ? null : Fail("owned_hash", "This hash belongs to another download.");
        if (!claims.TryGetValue(admission.AdmissionToken, out var claim) || claim.Hash != hash ||
            claim.DownloadId != admission.Download.Id)
            return Fail("claim_required", "Reserve this hash before committing admission.");
        return null;
    }

    private async Task BindAsync(TorrentManager manager, ImmutableArray<FileBinding> bindings)
    {
        if (!MetadataReady(manager) || bindings.Length != manager.Files.Count ||
            bindings.Select(b => b.FileIndex).Distinct().Count() != bindings.Length ||
            bindings.Select(b => Path.GetFullPath(b.AbsolutePath)).Distinct(StringComparer.OrdinalIgnoreCase).Count() != bindings.Length ||
            bindings.Any(b => b.FileIndex < 0 || b.FileIndex >= manager.Files.Count || !Path.IsPathFullyQualified(b.AbsolutePath)))
            throw new ArgumentException("Bind every torrent file once to an absolute Library path.");
        var occupied = entries.Values.Where(e => !ReferenceEquals(e.Manager, manager))
            .SelectMany(e => e.Manager.Files).Select(f => Path.GetFullPath(f.FullPath))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (bindings.Any(b => occupied.Contains(Path.GetFullPath(b.AbsolutePath))))
            throw new ArgumentException("A payload path is already bound to another torrent.");
        foreach (var binding in bindings)
        {
            RefusePayloadLinks(binding.AbsolutePath);
            var file = manager.Files[binding.FileIndex];
            await manager.SetFilePriorityAsync(file, Priority.DoNotDownload);
            if (!string.Equals(file.FullPath, binding.AbsolutePath, StringComparison.OrdinalIgnoreCase))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(binding.AbsolutePath)!);
                await manager.MoveFileAsync(file, binding.AbsolutePath);
            }
        }
        foreach (var binding in bindings.Where(b => b.Selected))
            await manager.SetFilePriorityAsync(manager.Files[binding.FileIndex], Priority.Normal);
        PhysicalFiles.PrepareBoundaries(manager);
        foreach (var binding in bindings.Where(b => !b.Selected))
        {
            var parent = Path.GetDirectoryName(binding.AbsolutePath);
            while (parent is not null && Path.GetFileName(parent) != ".unwanted") parent = Path.GetDirectoryName(parent);
            if (parent is null) continue;
            RefusePayloadLinks(parent);
            Directory.CreateDirectory(parent);
            await File.WriteAllBytesAsync(Path.Combine(parent, ".ignore"), []);
            if (OperatingSystem.IsWindows()) File.SetAttributes(parent, File.GetAttributes(parent) | FileAttributes.Hidden);
        }
    }

    public async Task<EngineResult> SetIntentAsync(string downloadId, bool run, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var entry = entries.Values.SingleOrDefault(e => !e.Probe && e.Id == downloadId);
            if (entry is null) return Rejected("not_attached", "The download is not attached. Recover its bindings before resuming.");
            entry.WantsRun = run;
            await ReconcileQueueAsync();
            return new(true, await SnapshotAsync(entry), null);
        }
        finally { gate.Release(); }
    }

    public async Task<EngineResult> SelectAsync(string downloadId, ImmutableArray<FileBinding> files, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var entry = entries.Values.SingleOrDefault(e => !e.Probe && e.Id == downloadId);
            if (entry is null) return Rejected("not_attached", "Recover the download before changing its selection.");
            if (files.Any(f => f.Selected && entry.Filed.Contains(f.FileIndex)))
                return Rejected("filed", "An already filed file cannot be selected for download again.");
            await entry.Manager.StopAsync(TimeSpan.Zero);
            entry.Run = false;
            await BindAsync(entry.Manager, files);
            entry.Bound = true;
            entry.Completed = false;
            await ReconcileQueueAsync();
            return new(true, await SnapshotAsync(entry), null);
        }
        finally { gate.Release(); }
    }

    public async Task<EngineDrainResult> StopAndReleaseFilesAsync(string downloadId, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var pair = entries.SingleOrDefault(p => !p.Value.Probe && p.Value.Id == downloadId);
            if (pair.Value is not null)
            {
                await RemoveManagerAsync(pair.Value, true);
                entries.Remove(pair.Key);
            }
            await ReconcileQueueAsync();
        }
        finally { gate.Release(); }
        await SaveDevStateAsync(ct);
        return new(downloadId, true, true, null);
    }

    public async Task DeleteTorrentAsync(string downloadId, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var pair = entries.SingleOrDefault(p => !p.Value.Probe && p.Value.Id == downloadId);
            if (pair.Value is not null)
            {
                await RemoveManagerAsync(pair.Value, false);
                entries.Remove(pair.Key);
            }
            foreach (var hash in registered.Where(p => p.Value == downloadId).Select(p => p.Key).ToArray())
                registered.Remove(hash);
            foreach (var token in claims.Where(p => p.Value.DownloadId == downloadId).Select(p => p.Key).ToArray())
                claims.Remove(token);
            queueOrder.Remove(downloadId);
            await ReconcileQueueAsync();
        }
        finally { gate.Release(); }
        await SaveDevStateAsync(ct);
    }

    public async Task<ImmutableArray<EngineSnapshot>> SnapshotAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var snapshots = ImmutableArray.CreateBuilder<EngineSnapshot>();
            foreach (var entry in entries.Values.Where(e => !e.Probe))
            {
                await ObserveDownloadAsync(entry);
                snapshots.Add(await SnapshotAsync(entry));
            }
            await ReconcileQueueAsync();
            return snapshots.ToImmutable();
        }
        finally { gate.Release(); }
    }

    private static bool SelectedComplete(TorrentManager manager) => manager.HasMetadata &&
        manager.Files.Any(f => f.Priority != Priority.DoNotDownload) &&
        manager.Files.Where(f => f.Priority != Priority.DoNotDownload).All(f => f.BitField.AllTrue);

    private async Task<EngineSnapshot> SnapshotAsync(Entry entry)
    {
        var manager = entry.Manager;
        var peers = await manager.GetPeersAsync();
        var files = manager.Files.Select((f, i) => new EngineFileSnapshot(i, f.Length,
            CompletedFileBytes(manager, f),
            PhysicalFiles.AllocatedBytes(f.FullPath),
            f.Priority != Priority.DoNotDownload, f.FullPath, f.BitField.AllTrue)).ToImmutableArray();
        var selected = files.Where(f => f.Selected).ToArray();
        var bytes = selected.Sum(f => f.Bytes);
        var completed = selected.Sum(f => f.CompletedBytes);
        UpdateUploaded(entry);
        return new(entry.Id, Hash(manager), MetadataReady(manager), true, entry.Completed || entry.Bound && SelectedComplete(manager),
            entry.Run && entry.MetadataStalled, entry.Run && entry.ProgressStalled, bytes, completed,
            manager.Monitor.DownloadRate, peers.Count, peers.Count(p => p.IsSeeder), files,
            DateTimeOffset.UtcNow, manager.Error is not null ? Fail("engine_error", manager.Error.Exception.Message) :
                entry.Filed.Any(i => !manager.Files[i].BitField.AllTrue)
                    ? Fail("file_changed", "A filed file or its boundary data changed. Check the library before resuming.") : null)
        {
            Active = entry.Run,
            Intent = entry.Completed ? DownloadIntent.Stopped : entry.Run ? DownloadIntent.Run :
                entry.WantsRun ? DownloadIntent.Queued : DownloadIntent.Paused,
            Eta = entry.Run && manager.Monitor.DownloadRate > 0
                ? TimeSpan.FromSeconds((double)Math.Max(0, bytes - completed) / manager.Monitor.DownloadRate) : null,
            UploadedBytes = entry.Uploaded,
        };
    }

    private static long CompletedFileBytes(TorrentManager manager, ITorrentManagerFile file)
    {
        if (!manager.HasMetadata || file.Length == 0) return 0;
        var pieceLength = manager.Torrent!.PieceLength;
        long complete = 0;
        for (var piece = file.StartPieceIndex; piece <= file.EndPieceIndex; piece++)
            if (manager.Bitfield[piece])
                complete += Math.Max(0, Math.Min(file.OffsetInTorrent + file.Length, ((long)piece + 1) * pieceLength)
                    - Math.Max(file.OffsetInTorrent, (long)piece * pieceLength));
        return complete;
    }

    public async Task ApplyQueueAsync(EngineQueuePolicy policy, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            if (policy.MaximumActive is { } cap)
            {
                if (cap is < 1 or > 20) throw new ArgumentOutOfRangeException(nameof(policy));
                settings = settings with { MaxActiveDownloads = cap };
            }
            foreach (var order in policy.Order) queueOrder[order.DownloadId] = order;
            foreach (var admission in policy.Admissions)
            {
                var entry = entries.Values.SingleOrDefault(e => !e.Probe && e.Id == admission.DownloadId);
                if (entry is not null) entry.WantsRun = admission.Run;
            }
            await ReconcileQueueAsync();
        }
        finally { gate.Release(); }
    }

    public async Task RecoverAsync(ImmutableArray<DownloadRow> downloads, ImmutableArray<DownloadFileRow> files, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            foreach (var download in downloads) registered[download.Hash] = download.Id;
        }
        finally { gate.Release(); }
        foreach (var download in downloads.Where(d => d.Intent is DownloadIntent.Run or DownloadIntent.Queued or DownloadIntent.Paused))
        {
            var candidate = CandidateFor(download.Hash);
            var bindings = files.Where(f => f.DownloadId == download.Id)
                .Select(f => new FileBinding(f.FileIndex, f.EnginePath ?? f.PartialPath ??
                    throw new InvalidDataException("A recovered file has no engine binding."), f.Selected)).ToImmutableArray();
            await StartAsync(new(download with { Intent = DownloadIntent.Paused }, candidate, bindings, download.AdmissionToken), true, ct);
        }
        await ApplyQueueAsync(new([.. downloads.Select(d => new QueueAdmission(d.Id,
            d.Intent is DownloadIntent.Run or DownloadIntent.Queued))]), ct);
    }

    public static Candidate CandidateFor(string magnet, string? torrentUri = null)
    {
        var hash = NormalizeHash(magnet);
        var name = Link(magnet).Name ?? hash;
        var parsed = new ParsedRelease(name, name, null, [], [], [], [], false, false, null,
            new(null, null, null, null), null, [], false, false, false);
        var now = DateTimeOffset.UtcNow;
        return new(new ReleaseRow
        {
            Id = hash,
            Name = name,
            Parsed = parsed,
            TotalBytes = null,
            TorrentUri = torrentUri,
            Magnet = magnet,
            Files = null,
            MetadataDigest = null,
            Private = null,
            FirstSeenAt = now,
            LastSeenAt = now,
        }, [], null);
    }

    private async Task ConfigureTrackersAsync(TorrentManager manager)
    {
        if (manager.TrackerManager.Private) return;
        foreach (var tier in manager.TrackerManager.Tiers.ToArray())
            foreach (var tracker in tier.Trackers.Skip(1).ToArray())
                if (await manager.TrackerManager.RemoveTrackerAsync(tracker))
                    await manager.TrackerManager.AddTrackerAsync(tracker);
        var trackers = settings.Trackers.IsDefaultOrEmpty
            ? ["udp://tracker.opentrackr.org:1337/announce", "udp://open.stealth.si:80/announce",
                "udp://tracker.torrent.eu.org:451/announce", "https://tracker.gbitt.info/announce"]
            : settings.Trackers;
        foreach (var tracker in trackers)
            if (Uri.TryCreate(tracker, UriKind.Absolute, out var uri)) await manager.TrackerManager.AddTrackerAsync(uri);
    }

    private async Task RemoveManagerAsync(Entry entry, bool keepResume)
    {
        await entry.Manager.StopAsync(TimeSpan.Zero);
        if (entry.Manager.HasMetadata) await client.DiskManager.FlushAsync(entry.Manager);
        if (keepResume && !entry.Probe) await SaveResumeAsync(entry.Manager);
        await client.RemoveAsync(entry.Manager, keepResume ? RemoveMode.KeepAllData : RemoveMode.CacheDataOnly);
    }

    public async Task TickAsync(bool saveDevState, CancellationToken ct)
    {
        if (settings.Dht && dht is not null) await dht.TickAsync(ct);
        ProbeHandle[] expired;
        await gate.WaitAsync(ct);
        try { expired = handles.Values.Where(h => h.ExpiresAt <= DateTimeOffset.UtcNow).ToArray(); }
        finally { gate.Release(); }
        foreach (var handle in expired)
            if (handle.ExpiresAt <= DateTimeOffset.UtcNow) await ReleaseProbeAsync(handle, ct);
        await SnapshotAsync(ct);
        if (saveDevState) await SaveDevStateAsync(ct);
        else
        {
            await gate.WaitAsync(ct);
            try
            {
                foreach (var entry in entries.Values.Where(e => !e.Probe))
                    await SaveResumeAsync(entry.Manager);
            }
            finally { gate.Release(); }
        }
    }

    public async Task SaveDevStateAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            foreach (var entry in entries.Values.Where(e => !e.Probe))
                await SaveResumeAsync(entry.Manager);
            var encoded = await client.SaveStateAsync();
            var state = BEncodedDictionary.Decode<BEncodedDictionary>(encoded);
            var torrents = (BEncodedList)state["Torrents"];
            for (var i = torrents.Count - 1; i >= 0; i--)
            {
                var torrent = (BEncodedDictionary)torrents[i];
                var hash = NormalizeHash(((BEncodedString)torrent["MagnetLink"]).Text);
                if (!entries.TryGetValue(hash, out var entry) || entry.Probe) torrents.RemoveAt(i);
                else
                {
                    torrent["DevRun"] = new BEncodedNumber(entry.WantsRun && !entry.Completed ? 1 : 0);
                    torrent["DevId"] = new BEncodedString(entry.Id);
                    torrent["DevBound"] = new BEncodedNumber(entry.Bound ? 1 : 0);
                    if (queueOrder.TryGetValue(entry.Id, out var order))
                    {
                        torrent["DevRank"] = new BEncodedNumber(order.Rank);
                        torrent["DevPriority"] = new BEncodedNumber((int)order.Priority);
                        torrent["DevNow"] = new BEncodedNumber(order.Now ? 1 : 0);
                        torrent["DevEligible"] = new BEncodedNumber(order.Eligible ? 1 : 0);
                    }
                }
            }
            await AtomicWriteAsync(Path.Combine(directory, "dev-engine.state"), state.Encode());
        }
        finally { gate.Release(); }
    }

    private static async Task AtomicWriteAsync(string path, byte[] bytes)
    {
        await File.WriteAllBytesAsync(path + ".new", bytes);
        File.Move(path + ".new", path, true);
    }

    private static BEncodedList ResumeBindings(TorrentManager manager) => new(manager.Files.Select(file =>
    {
        var info = new FileInfo(file.FullPath);
        return (BEncodedValue)new BEncodedDictionary
        {
            ["path"] = new BEncodedString(file.FullPath),
            ["length"] = new BEncodedNumber(info.Exists ? info.Length : -1),
            ["written"] = new BEncodedNumber(info.Exists ? info.LastWriteTimeUtc.Ticks : 0),
        };
    }));

    private async Task SaveResumeAsync(TorrentManager manager)
    {
        if (!manager.HasMetadata || !manager.HashChecked) return;
        var saved = BEncodedDictionary.Decode<BEncodedDictionary>((await manager.SaveFastResumeAsync()).Encode());
        saved["Bindings"] = ResumeBindings(manager);
        var path = client.Settings.GetFastResumePath(manager.InfoHashes);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await AtomicWriteAsync(path, saved.Encode());
    }

    private async Task LoadResumeAsync(TorrentManager manager)
    {
        var path = client.Settings.GetFastResumePath(manager.InfoHashes);
        if (!File.Exists(path)) return;
        if (!FastResume.TryLoad(path, out var resume) || resume!.InfoHashes != manager.InfoHashes)
        {
            log($"Invalid fast resume for {Hash(manager)}; a disk recheck is required.");
            return;
        }
        var saved = BEncodedDictionary.Decode<BEncodedDictionary>(await File.ReadAllBytesAsync(path));
        if (!saved.TryGetValue("Bindings", out var bindings) || !bindings.Equals(ResumeBindings(manager)))
        {
            log($"Resume bindings or file fingerprints changed for {Hash(manager)}; a disk recheck is required.");
            return;
        }
        await manager.LoadFastResumeAsync(resume);
        log($"Loaded fast resume for {Hash(manager)} with {manager.Bitfield.TrueCount} verified pieces.");
    }

    private void PruneClaims()
    {
        foreach (var token in claims.Where(c => c.Value.ExpiresAt <= DateTimeOffset.UtcNow).Select(c => c.Key).ToArray())
            claims.Remove(token);
    }

    private void ThrowIfStopped()
    {
        if (shuttingDown || client is null) throw new InvalidOperationException("The engine is not running.");
    }

    private void WatchCompletion(TorrentManager manager)
    {
        manager.PieceHashed += (_, _) =>
        {
            if (SelectedComplete(manager)) _ = StopCompletedAsync(manager);
        };
        manager.TorrentStateChanged += (_, change) =>
        {
            if (change.NewState == TorrentState.Seeding)
                _ = StopCompletedAsync(manager);
        };
    }

    private async Task StopCompletedAsync(TorrentManager manager)
    {
        await gate.WaitAsync();
        try
        {
            if (!shuttingDown && entries.TryGetValue(Hash(manager), out var entry) &&
                !entry.Probe && entry.Bound && ReferenceEquals(entry.Manager, manager) && SelectedComplete(manager))
            {
                await CompleteDownloadAsync(entry);
                await ReconcileQueueAsync();
                log($"Selected files complete for {Hash(manager)}; seeding stopped.");
            }
        }
        catch (Exception ex) { log($"Completion stop failed and will retry on tick: {ex.Message}"); }
        finally { gate.Release(); }
    }

    public async Task<ImmutableArray<TorrentFile>> WaitMetadataAsync(ProbeHandle handle, CancellationToken ct)
    {
        TorrentManager manager;
        await gate.WaitAsync(ct);
        try
        {
            if (!handles.TryGetValue(handle.Token, out var owned) || owned != handle)
                throw new InvalidOperationException("The metadata capability was consumed.");
            manager = entries[handle.Hash].Manager;
        }
        finally { gate.Release(); }
        await manager.WaitForMetadataAsync(ct);
        while (!MetadataReady(manager)) await Task.Delay(10, ct);
        await gate.WaitAsync(ct);
        try
        {
            if (!handles.ContainsKey(handle.Token)) throw new InvalidOperationException("The metadata capability was consumed.");
            foreach (var file in manager.Files) await manager.SetFilePriorityAsync(file, Priority.DoNotDownload);
            return Files(manager)!.Value;
        }
        finally { gate.Release(); }
    }

    public async Task<ImmutableArray<EngineDiagnostics>> DiagnosticsAsync(CancellationToken ct, bool includePieces = false)
    {
        await SnapshotAsync(ct);
        await gate.WaitAsync(ct);
        try
        {
            var diagnostics = ImmutableArray.CreateBuilder<EngineDiagnostics>();
            foreach (var e in entries.Values)
            {
                var peers = await e.Manager.GetPeersAsync();
                diagnostics.Add(new EngineDiagnostics(e.Id, Hash(e.Manager), e.Probe,
                e.Manager.State.ToString(), e.Manager.PartialProgress, e.Manager.Monitor.UploadRate,
                UpdateReceived(e), e.Manager.Monitor.ProtocolBytesReceived,
                e.Manager.HashChecked, e.Manager.HashFails, e.Manager.Bitfield.TrueCount,
                e.Manager.HasMetadata ? e.Manager.Torrent!.PieceCount : 0,
                e.Manager.TrackerManager.Tiers.Sum(t => t.Trackers.Count),
                includePieces && e.Manager.HasMetadata
                    ? Enumerable.Range(0, e.Manager.Torrent!.PieceCount).Where(p => e.Manager.Bitfield[p]).ToArray() : null)
                {
                    AvailablePeers = e.Manager.Peers.Available,
                    ConnectionsEstablished = 0,
                    ConnectionFailures = 0,
                    LastDhtAnnounce = e.Manager.LastDhtAnnounce,
                    PieceLength = e.Manager.Torrent?.PieceLength,
                    ConnectedPeers = [.. peers.Select(p => new PeerDiagnostics(p.Uri.ToString(), p.IsSeeder,
                        p.IsChoking, p.AmInterested, p.AmRequestingPiecesCount, p.Monitor.DataBytesReceived))],
                    Trackers = [.. e.Manager.TrackerManager.Tiers.SelectMany(t => t.Trackers.Select(tracker =>
                        new TrackerDiagnostics(tracker.Uri.ToString(), tracker.Status.ToString(),
                            t.LastAnnounceSucceeded, tracker.FailureMessage, tracker.TimeSinceLastAnnounce)))],
                });
            }
            return diagnostics.ToImmutable();
        }
        finally { gate.Release(); }
    }

    public async Task<EngineResult> RecheckAsync(string hash, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            if (!entries.TryGetValue(hash, out var entry) || entry.Probe) return Rejected("not_found", "Download not found.");
            await entry.Manager.StopAsync(TimeSpan.Zero);
            await entry.Manager.SetNeedsHashCheckAsync();
            await entry.Manager.HashCheckAsync(false);
            entry.Run = false;
            entry.WantsRun = false;
            return new(true, await SnapshotAsync(entry), null);
        }
        finally { gate.Release(); }
    }

    public async Task<ImmutableArray<string>> RemoveDevAsync(string hash, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            if (!entries.TryGetValue(hash, out var entry))
            {
                if (registered.TryGetValue(hash, out var id))
                {
                    queueOrder.Remove(id);
                }
                registered.Remove(hash);
                return [];
            }
            if (entry.Probe) return [];
            var paths = entry.Manager.Files.Select(f => f.FullPath).ToImmutableArray();
            await RemoveManagerAsync(entry, false);
            entries.Remove(hash);
            registered.Remove(hash);
            queueOrder.Remove(entry.Id);
            foreach (var token in handles.Values.Where(h => h.Hash == hash).Select(h => h.Token).ToArray())
            { handles.Remove(token); }
            await ReconcileQueueAsync();
            return paths;
        }
        finally { gate.Release(); }
    }

    private static int FreePort()
    {
        using var tcp = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        tcp.Bind(new IPEndPoint(IPAddress.Any, 0));
        return ((IPEndPoint)tcp.LocalEndPoint!).Port;
    }

    public sealed record EngineDiagnostics(string DownloadId, string Hash, bool Probe, string State, double Progress,
        long UploadBytesPerSecond, long PayloadBytesReceived, long ProtocolBytesReceived, bool HashChecked,
        int HashFails, int VerifiedPieces, int TotalPieces, int TrackerCount, int[]? VerifiedPieceIndices)
    {
        public int AvailablePeers { get; init; }
        public int ConnectionsEstablished { get; init; }
        public int ConnectionFailures { get; init; }
        public ImmutableDictionary<string, int> DiscoveredPeers { get; init; } = ImmutableDictionary<string, int>.Empty;
        public DateTime LastDhtAnnounce { get; init; }
        public int? PieceLength { get; init; }
        public ImmutableArray<PeerDiagnostics> ConnectedPeers { get; init; } = [];
        public ImmutableArray<TrackerDiagnostics> Trackers { get; init; } = [];
    }
    public sealed record PeerDiagnostics(string Uri, bool Seeder, bool Choking, bool Interested,
        int OutstandingRequests, long PayloadBytesReceived);
    public sealed record TrackerDiagnostics(string Uri, string Status, bool TierLastAnnounceSucceeded,
        string Failure, TimeSpan TimeSinceLastAnnounce);
    private static long UpdateReceived(Entry entry)
    {
        var current = entry.Manager.Monitor.DataBytesReceived;
        entry.Received += current >= entry.LastReceived ? current - entry.LastReceived : current;
        entry.LastReceived = current;
        return entry.Received;
    }

    public async Task<ProbeHandle?> FindProbeAsync(string token, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try { return handles.GetValueOrDefault(token); }
        finally { gate.Release(); }
    }

    private static bool PortAvailable(int port)
    {
        try
        {
            using var tcp = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp) { ExclusiveAddressUse = true };
            using var udp = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp) { ExclusiveAddressUse = true };
            using var tcp6 = Socket.OSSupportsIPv6
                ? new Socket(AddressFamily.InterNetworkV6, SocketType.Stream, ProtocolType.Tcp) { ExclusiveAddressUse = true, DualMode = false } : null;
            tcp.Bind(new IPEndPoint(IPAddress.Any, port));
            udp.Bind(new IPEndPoint(IPAddress.Any, port));
            tcp6?.Bind(new IPEndPoint(IPAddress.IPv6Any, port));
            return true;
        }
        catch (SocketException) { return false; }
    }

    public async ValueTask DisposeAsync()
    {
        await gate.WaitAsync();
        try
        {
            if (shuttingDown) return;
            shuttingDown = true;
            if (client is not null)
            {
                if (settings.Dht && dht is not null) await dht.SaveAsync();
                await client.StopAllAsync(TimeSpan.Zero);
                foreach (var manager in client.Torrents.Where(m => m.HasMetadata))
                {
                    await client.DiskManager.FlushAsync(manager);
                    if (entries.TryGetValue(Hash(manager), out var entry) && !entry.Probe)
                        await SaveResumeAsync(manager);
                }
                client.Dispose();
                File.Delete(Path.Combine(directory, "session.active"));
            }
        }
        finally { gate.Release(); }
    }
}
