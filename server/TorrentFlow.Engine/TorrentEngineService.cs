using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Torrents;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Layout;
using TorrentFlow.Engine.Queue;
using TorrentFlow.Engine.Settings;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine;

/// <summary>
/// The built-in engine: EngineTorrent row lifecycle + download queue on top of <see cref="ITorrentBackend"/>.
/// Queue decisions (admit / promote / demote) are serialised by one gate so two concurrent adds can never
/// both take the last slot. Lifecycle operations on one transfer (add, start, pause, resume, force, delete, stream
/// open) are serialised by a per-hash lock, and every deferred start re-reads the row first, so a pause or delete
/// that lands between a queue decision and the client start wins instead of being resurrected.
/// </summary>
internal sealed class TorrentEngineService(
    IDbContextFactory<TorrentFlowDbContext> dbFactory,
    ITorrentBackend backend,
    IOptionsMonitor<EngineOptions> options,
    ClientSettingsStore settings,
    StorageBudget storage,
    IHttpClientFactory httpFactory,
    TimeProvider time,
    ILogger<TorrentEngineService> logger,
    CompletedLayoutFinalizer? layout = null,
    CompletedLayoutManifestStore? layoutManifest = null,
    ISmartCategorizer? categorizer = null,
    DownloadLimits? limits = null) : ITorrentEngine, ILayoutTidy
{
    public const string HttpClientName = "TorrentFlow.Engine.TorrentFiles";
    public const string DownloadedCannotPause = "Downloaded files cannot be paused.";
    public const string NotFound = "Torrent not found in engine.";

    private readonly SemaphoreSlim _queueGate = new(1, 1);
    // Lock order: a hash lock is always taken before _queueGate, and never while holding another hash lock, except by
    // RemoveManyAsync, which holds _removeGate and takes its hashes in ordinal order.
    private readonly SemaphoreSlim _removeGate = new(1, 1);
    // Entries are ref-counted (holder + waiters) and dropped at zero, so the map never outgrows the in-flight work.
    private readonly Dictionary<string, HashLock> _hashLocks = new(StringComparer.Ordinal);
    // Rows marked downloading whose backend start is still in flight; the monitor must not treat them as stranded.
    private readonly ConcurrentDictionary<string, byte> _starting = new(StringComparer.Ordinal);
    // When each transfer was last loaded into the client; the metadata deadline counts from here, not the row.
    private readonly ConcurrentDictionary<string, DateTime> _startedAt = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _openStreams = new(StringComparer.Ordinal);
    private readonly HashSet<string> _pendingDetach = new(StringComparer.Ordinal);
    private readonly CompletedLayoutManifestStore _layoutManifest = layoutManifest ?? new CompletedLayoutManifestStore(Path.Combine(options.CurrentValue.EngineDirectory, "layout-manifest.json"));
    // Lifecycle operations bump _wakes; a tick that found nothing live, queued or stranded records the generation it
    // started under, and later ticks skip the database until the next wake. A failed tick never marks idle.
    private int _wakes;
    private int _idleAtWake = -1;
    // Completed transfers whose content layout waits for the last reader to close (guarded by _openStreams).
    private readonly HashSet<string> _pendingLayout = new(StringComparer.Ordinal);

    public event EventHandler<EngineTorrentCompletedEventArgs>? TorrentCompleted;

    private EngineOptions Options => options.CurrentValue;
    /// <summary>The owner's download hours evaluated now (server local time); unrestricted when none are saved.</summary>
    private ScheduleState Schedule => limits is null ? ScheduleState.Unrestricted : DownloadWindows.Evaluate(limits.Windows, time.GetLocalNow());
    /// <summary>An open window's own downloads-at-once wins over the saved cap, which wins over the configured default.</summary>
    private int CapFor(ScheduleState schedule) =>
        Math.Max(1, schedule.Active?.MaxActiveDownloads ?? limits?.MaxActiveOverride ?? Options.MaxActiveDownloads);
    private int Cap => CapFor(Schedule);
    // The window speed caps last pushed to the client; null until the first tick applies them.
    private (long? Down, long? Up)? _appliedRates;
    private int _limitsAttached;
    private DateTime Now => time.GetUtcNow().UtcDateTime;

    // ---------------------------------------------------------------- add

    /// <summary>
    /// An explicit SavePath wins; otherwise a named release is routed like resolveSmartSendTarget
    /// (&lt;base&gt;/&lt;category&gt;/&lt;show&gt;/Season NN), which is what every Next send path (grab, automation, prewarm) uses.
    /// </summary>
    private DownloadTarget ResolveTarget(ClientConfig config, EngineAddRequest request)
    {
        if (!string.IsNullOrEmpty(request.SavePath) || categorizer is null || string.IsNullOrWhiteSpace(request.Name))
            return ClientSettingsStore.ResolveDownloadTarget(config, request.Category, request.SavePath);
        var smart = SmartSendTargets.Resolve(config, categorizer, new SmartSendOptions
        {
            Name = request.Name, Tags = request.Tags, Metadata = request.Metadata, Source = request.Source,
            SearchCategory = request.SearchCategory, CategoryManual = request.CategoryManual, Category = request.Category,
        });
        return new DownloadTarget(smart.Category, smart.SavePath);
    }

    public async Task<EngineAddResult> AddAsync(EngineAddRequest request, CancellationToken ct = default)
    {
        var purpose = request.Purpose is TorrentPurpose.Stream or TorrentPurpose.Prewarm ? request.Purpose : TorrentPurpose.Keep;
        if (purpose != TorrentPurpose.Keep && !options.CurrentValue.Streaming)
            return new EngineAddResult(false, "Streaming is turned off.");
        var origin = TorrentOrigin.FromPurpose(purpose);

        var bytes = request.TorrentBytes;
        if (bytes is null && !string.IsNullOrWhiteSpace(request.TorrentUrl))
        {
            try { bytes = await FetchTorrentAsync(request.TorrentUrl!, ct); }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidDataException)
            {
                logger.LogInformation(ex, "Fetching .torrent failed; falling back to magnet if present");
                if (string.IsNullOrWhiteSpace(request.Magnet) && string.IsNullOrWhiteSpace(request.InfoHash))
                    return new EngineAddResult(false, "Could not download the .torrent file. Try another release.");
            }
        }

        string? hash = bytes is not null ? TorrentSource.HashFromTorrent(bytes) : null;
        string? magnet = request.Magnet?.Trim();
        if (hash is null && !string.IsNullOrEmpty(magnet)) hash = TorrentSource.HashFromMagnet(magnet);
        if (hash is null && TorrentSource.NormalizeInfoHash(request.InfoHash) is { } ih)
        {
            hash = ih;
            magnet = TorrentSource.BuildMagnet(ih, request.Name, []);
        }
        if (hash is null) return new EngineAddResult(false, "No magnet or torrent URL provided.");
        if (!string.IsNullOrEmpty(magnet)) magnet = TorrentSource.WidenTrackers(magnet, Options.EffectivePublicTrackers);
        if (bytes is not null) SaveTorrentFile(hash, bytes);

        var config = await settings.GetConfigAsync(ct);
        var target = ResolveTarget(config, request);
        var savePath = target.SavePath ?? Path.Combine(Options.DataDirectory, "downloads");
        // builtin-engine addTorrent mkdirs the destination before any row exists: an unusable path fails cleanly.
        try { Directory.CreateDirectory(savePath); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
        {
            return new EngineAddResult(false, ex.Message);
        }

        Admission admission;
        EngineAddResult result;
        var failed = false;
        using (await LockHashAsync(hash, ct))
        {
            await _queueGate.WaitAsync(ct);
            try { admission = await AdmitAsync(request, hash, magnet, purpose, origin, config, target, savePath, ct); }
            finally { _queueGate.Release(); }

            if (admission.StartRow is not { } row)
            {
                result = admission.Result!;
            }
            else
            {
                // The row is persisted as downloading: the request token must not strand it half-started.
                try
                {
                    var outcome = await StartInBackendAsync(row, purpose, TimeSpan.FromSeconds(Options.MetadataTimeoutSeconds), CancellationToken.None);
                    if (!outcome.Ok)
                    {
                        await MarkErrorAsync(hash, outcome.Message);
                        failed = true;
                        result = new EngineAddResult(false, outcome.Message, null, hash);
                    }
                    else
                    {
                        var snap = outcome.Snapshot;
                        if (snap is not null) await PersistSnapshotAsync(snap);
                        result = new EngineAddResult(true, "Added to the built-in engine.",
                            new EngineAddDetails(EngineAddDetails.Started, Math.Round((snap?.Progress ?? 0) * 100, 1), snap?.Peers ?? 0), hash);
                    }
                }
                finally
                {
                    _starting.TryRemove(hash, out _);
                }
            }
        }

        await StartClaimedAsync(admission.Claimed);
        if (failed) await PromoteAsync(CancellationToken.None);
        return result;
    }

    private sealed record Admission(EngineAddResult? Result, EngineTorrent? StartRow, List<EngineTorrent> Claimed);

    /// <summary>Runs under the hash lock and the queue gate: decides start / queue and persists the row.</summary>
    private async Task<Admission> AdmitAsync(EngineAddRequest request, string hash, string? magnet, string purpose, string origin,
        ClientConfig config, DownloadTarget target, string savePath, CancellationToken ct)
    {
        static Admission Done(EngineAddResult result) => new(result, null, []);

        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var existing = await db.EngineTorrents.FirstOrDefaultAsync(r => r.UserId == LocalUser.Id && r.Hash == hash, ct);
        var lane = purpose == TorrentPurpose.Keep ? TorrentLane.Rank(request.Lane) : 0;

        if (existing is not null && TorrentOrigin.Rank(origin) > TorrentOrigin.Rank(existing.Origin))
        {
            existing.Origin = origin;
            // A stream/prewarm row carried no real lane; the keep request that adopts it decides.
            if (origin == TorrentOrigin.User) existing.Lane = lane;
            existing.UpdatedAt = Now;
            await db.SaveChangesAsync(ct);
            if (origin == TorrentOrigin.User && backend.Contains(hash)) await backend.SetSelectedFilesAsync(hash, null);
        }
        else if (existing is not null && purpose == TorrentPurpose.Keep && lane < existing.Lane)
        {
            // Lanes only rise: the owner asking for something automation queued moves it up, never the reverse.
            existing.Lane = lane;
            existing.UpdatedAt = Now;
            await db.SaveChangesAsync(ct);
        }

        if (backend.Get(hash) is { } live)
        {
            if (request.Forced && existing is not null && existing.ForcedAt is null)
            {
                existing.ForcedAt = Now;
                await db.SaveChangesAsync(ct);
            }
            return Done(live.State == "complete"
                ? new EngineAddResult(true, "", new EngineAddDetails(EngineAddDetails.AlreadyComplete, 100, 0), hash)
                : new EngineAddResult(true, "", new EngineAddDetails(EngineAddDetails.AlreadyDownloading, Math.Round(live.Progress * 100, 1), live.Peers), hash));
        }

        if (existing is not null && IsDownloaded(existing))
            return Done(new EngineAddResult(true, "", new EngineAddDetails(EngineAddDetails.AlreadyComplete, 100, 0), hash));

        if (existing is not null && existing.Status == EngineTorrentStatus.Queued && !request.Forced && purpose == TorrentPurpose.Keep)
        {
            var pos = await QueuePositionAsync(db, hash, ct);
            return Done(QueuedResult(hash, pos));
        }

        if (purpose == TorrentPurpose.Keep && existing is null)
        {
            var reserved = DownloadQueue.QueuedReservedBytes(await QueueRowsAsync(db, ct));
            var check = storage.Check(config.DownloadRoot, config.MaxStorageBytes, request.ExpectedSizeBytes, reserved, request.OverrideStorageCap);
            if (!check.Ok) return Done(new EngineAddResult(false, check.Message ?? "Storage limit", null, hash) { StorageLimit = check.Limit });
        }

        var rows = await QueueRowsAsync(db, ct);
        var schedule = Schedule;
        var queued = DownloadQueue.ShouldQueueNewDownload(rows.Where(r => r.Hash != hash).ToList(), CapFor(schedule), origin, request.Forced, schedule.Open);

        var row = existing ?? new EngineTorrent { Id = Ids.New(), UserId = LocalUser.Id, Hash = hash, CreatedAt = Now, LastUsedAt = Now, Origin = origin, Lane = lane };
        row.Name = FirstNonBlank(request.Name, existing?.Name, hash)!;
        row.Magnet = magnet ?? existing?.Magnet;
        row.TorrentUrl = request.TorrentUrl ?? existing?.TorrentUrl;
        row.SavePath = savePath;
        row.Category = target.Category;
        row.WorkId = request.WorkId ?? existing?.WorkId;
        row.QueueKey = request.QueueKey ?? existing?.QueueKey;
        if (request.ExpectedSizeBytes is > 0 && row.SizeBytes <= 0) row.SizeBytes = request.ExpectedSizeBytes.Value;
        if (request.Forced) row.ForcedAt = Now;
        row.Status = queued ? EngineTorrentStatus.Queued : EngineTorrentStatus.Downloading;
        row.Error = null;
        row.UpdatedAt = Now;
        if (existing is null) db.EngineTorrents.Add(row);
        if (!queued) _starting.TryAdd(hash, 0);
        try { await db.SaveChangesAsync(ct); }
        catch
        {
            if (!queued) _starting.TryRemove(hash, out _);
            throw;
        }
        // Persisted: everything after this point ignores the request token.
        if (!queued) return new Admission(null, row, []);
        // Rows are already waiting, so the new one joins the line and the head of the queue takes any free slot.
        var claimed = await ClaimPromotionsAsync(db);
        var self = claimed.FirstOrDefault(r => r.Hash == hash);
        if (self is not null)
        {
            claimed.Remove(self);
            _starting.TryAdd(hash, 0);
            return new Admission(null, self, claimed);
        }
        var position = await QueuePositionAsync(db, hash, CancellationToken.None);
        return new Admission(QueuedResult(hash, position), null, claimed);
    }

    private static EngineAddResult QueuedResult(string hash, int? position) =>
        new(true, position is { } p ? $"Queued — #{p} in line" : "Queued", new EngineAddDetails(EngineAddDetails.Queued, 0, 0, position), hash);

    private async Task<byte[]> FetchTorrentAsync(string url, CancellationToken ct)
    {
        var client = httpFactory.CreateClient(HttpClientName);
        using var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength is > 20 * 1024 * 1024) throw new InvalidDataException(".torrent too large");
        var bytes = await response.Content.ReadAsByteArrayAsync(ct);
        if (bytes.Length == 0 || bytes[0] != (byte)'d') throw new InvalidDataException("Not a .torrent file");
        return bytes;
    }

    private string TorrentFilePath(string hash) => Path.Combine(Options.EngineDirectory, "torrents", hash + ".torrent");

    private void SaveTorrentFile(string hash, byte[] bytes)
    {
        var path = TorrentFilePath(hash);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (!File.Exists(path)) File.WriteAllBytes(path, bytes);
    }

    private byte[]? LoadTorrentFile(string hash)
    {
        var path = TorrentFilePath(hash);
        if (File.Exists(path)) return File.ReadAllBytes(path);
        var meta = backend.GetMetadata(hash);
        if (meta is not null) SaveTorrentFile(hash, meta);
        return meta;
    }

    private async Task<BackendAddOutcome> StartInBackendAsync(EngineTorrent row, string purpose, TimeSpan? metadataTimeout, CancellationToken ct)
    {
        var bytes = LoadTorrentFile(row.Hash);
        if (bytes is null && string.IsNullOrWhiteSpace(row.Magnet))
            return new BackendAddOutcome(false, "No saved source to retry this release.");
        // A laid-out torrent is re-added in its own release folder with each file pointed at where the layout put it, so
        // a file moved aside or kept nested is re-checked in place and a neighbour's file at the flat path is never touched.
        var indexed = bytes is null ? null
            : _layoutManifest.IndexedPaths(row.Hash, row.SavePath) ?? _layoutManifest.PlacedPaths(row.Hash, row.SavePath);
        var reuseFlatLayout = indexed is null && (row.TorrentUrl == DownloadRecoveryService.SeedingMarker
            || _layoutManifest.CanReuseFlatLayout(row.Hash, row.SavePath, out _));
        // A kept download writes straight into the save path, without its release folder, wherever that is free.
        var flatten = layout is not null && indexed is null && !reuseFlatLayout && purpose == TorrentPurpose.Keep;
        var spec = new BackendAddSpec(row.Hash, bytes is null ? row.Magnet : null, bytes,
            row.SavePath ?? Path.Combine(Options.DataDirectory, "downloads"), purpose, metadataTimeout, !reuseFlatLayout, indexed, flatten);
        var wasLoaded = backend.Contains(row.Hash);
        try
        {
            var outcome = await backend.AddAsync(spec, ct);
            if (outcome.Ok)
            {
                if (!wasLoaded) _startedAt[row.Hash] = Now;
                if (backend.GetMetadata(row.Hash) is { } meta) SaveTorrentFile(row.Hash, meta);
                if (flatten && backend.Get(row.Hash) is { Files.Count: > 0 } placed && row.SavePath is { } save
                    && placed.Files.Any(f => string.Equals(Path.GetFullPath(f.FullPath), Path.GetFullPath(Path.Combine(save, f.Path)), StringComparison.OrdinalIgnoreCase)))
                    _layoutManifest.Place(row.Hash, save, placed.Files.OrderBy(f => f.Index).Select(f => (string?)f.FullPath).ToList());
                // Already live as a stream (files deselected): a kept download wants every file.
                if (wasLoaded && purpose == TorrentPurpose.Keep) await backend.SetSelectedFilesAsync(row.Hash, null);
            }
            return outcome;
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogWarning(ex, "Adding {Hash} to the client failed", row.Hash);
            return new BackendAddOutcome(false, "Torrent was added but dropped from the engine immediately — check server logs.");
        }
    }

    private async Task<IDisposable> LockHashAsync(string hash, CancellationToken ct)
    {
        // Every lifecycle operation (add, start, pause, resume, force, delete, stream open) passes through here.
        WakeMonitor();
        HashLock entry;
        lock (_hashLocks)
        {
            if (!_hashLocks.TryGetValue(hash, out entry!)) _hashLocks[hash] = entry = new HashLock();
            entry.Refs++;
        }
        try
        {
            await entry.Gate.WaitAsync(ct);
        }
        catch
        {
            ReleaseRef(hash, entry);
            throw;
        }
        return new Releaser(this, hash, entry);
    }

    private void ReleaseRef(string hash, HashLock entry)
    {
        lock (_hashLocks)
        {
            if (--entry.Refs == 0) _hashLocks.Remove(hash);
        }
    }

    /// <summary>Test seam: per-hash lock entries currently held or awaited.</summary>
    internal int HashLockCount
    {
        get { lock (_hashLocks) return _hashLocks.Count; }
    }

    private sealed class HashLock
    {
        public readonly SemaphoreSlim Gate = new(1, 1);
        public int Refs;
    }

    private sealed class Releaser(TorrentEngineService owner, string hash, HashLock entry) : IDisposable
    {
        private int _released;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) != 0) return;
            entry.Gate.Release();
            owner.ReleaseRef(hash, entry);
        }
    }

    private static string PurposeOf(EngineTorrent row) => row.Origin switch
    {
        TorrentOrigin.Stream => TorrentPurpose.Stream,
        TorrentOrigin.Prewarm => TorrentPurpose.Prewarm,
        _ => TorrentPurpose.Keep,
    };

    // ---------------------------------------------------------------- queue

    private static async Task<List<QueueRow>> QueueRowsAsync(TorrentFlowDbContext db, CancellationToken ct) =>
        (await db.EngineTorrents.AsNoTracking().Where(r => r.UserId == LocalUser.Id).ToListAsync(ct)).Select(ToQueueRow).ToList();

    private static QueueRow ToQueueRow(EngineTorrent r) =>
        new(r.Hash, r.Status, r.Origin, r.CreatedAt, r.WorkId, r.QueueKey, r.ForcedAt, r.SizeBytes, r.Lane);

    private static async Task<int?> QueuePositionAsync(TorrentFlowDbContext db, string hash, CancellationToken ct) =>
        DownloadQueue.Positions(await QueueRowsAsync(db, ct)).TryGetValue(hash, out var p) ? p : null;

    public async Task<long> QueuedReservedBytesAsync(CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return DownloadQueue.QueuedReservedBytes(await QueueRowsAsync(db, ct));
    }

    /// <summary>
    /// Loads the owner's saved downloads-at-once cap and refills slots whenever it changes, so raising it starts
    /// queued downloads right away. Lowering it never stops a running transfer; the queue just waits longer.
    /// </summary>
    internal async Task AttachLimitsAsync(CancellationToken ct = default)
    {
        if (limits is null || Interlocked.Exchange(ref _limitsAttached, 1) == 1) return;
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            var saved = await db.ClientSettings.AsNoTracking().Where(s => s.UserId == LocalUser.Id)
                .Select(s => new { s.MaxActiveDownloads, s.DownloadWindows }).FirstOrDefaultAsync(ct);
            limits.SetMaxActive(saved?.MaxActiveDownloads);
            limits.SetWindows(DownloadWindows.Parse(saved?.DownloadWindows));
        }
        limits.Changed += (_, _) =>
        {
            WakeMonitor();
            _ = ApplyRateLimitsAsync();
            _ = PromoteAsync(CancellationToken.None).ContinueWith(
                t => logger.LogWarning(t.Exception, "Refilling the queue after a cap change failed"),
                TaskContinuationOptions.OnlyOnFaulted);
        };
    }

    /// <summary>Fills free slots from the head of the queue. Runs after complete / pause / delete / fail.</summary>
    internal async Task<IReadOnlyList<string>> PromoteAsync(CancellationToken ct = default)
    {
        List<EngineTorrent> promoted;
        await _queueGate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            promoted = await ClaimPromotionsAsync(db);
        }
        finally
        {
            _queueGate.Release();
        }
        await StartClaimedAsync(promoted);
        return promoted.Select(r => r.Hash).ToList();
    }

    /// <summary>
    /// Caller holds <see cref="_queueGate"/>. Marks the queue head downloading for every free slot and records the
    /// hashes as starting; the caller must hand the result to <see cref="StartClaimedAsync"/> (outside any hash lock).
    /// </summary>
    private async Task<List<EngineTorrent>> ClaimPromotionsAsync(TorrentFlowDbContext db)
    {
        var schedule = Schedule;
        var candidates = DownloadQueue.PromotionCandidates(await QueueRowsAsync(db, CancellationToken.None), CapFor(schedule), schedule.Open);
        if (candidates.Count == 0) return [];
        var rows = await db.EngineTorrents.Where(r => r.UserId == LocalUser.Id && candidates.Contains(r.Hash)).ToListAsync(CancellationToken.None);
        foreach (var r in rows)
        {
            r.Status = EngineTorrentStatus.Downloading;
            r.UpdatedAt = Now;
            _starting.TryAdd(r.Hash, 0);
        }
        await db.SaveChangesAsync(CancellationToken.None);
        return candidates.Select(h => rows.FirstOrDefault(r => r.Hash == h)).OfType<EngineTorrent>().ToList();
    }

    /// <summary>Starts claimed rows one by one. A failure frees its slot, so the queue is refilled afterwards.</summary>
    private async Task StartClaimedAsync(IReadOnlyList<EngineTorrent> claimed)
    {
        var failed = false;
        foreach (var r in claimed)
        {
            // No metadata wait here: the monitor times out a magnet that never resolves and promotes the next one.
            try { failed |= !await StartValidatedAsync(r.Hash); }
            catch (Exception ex)
            {
                logger.LogError(ex, "Starting {Hash} failed", r.Hash);
                await MarkErrorAsync(r.Hash, "The torrent client could not start this transfer.");
                failed = true;
            }
        }
        if (failed) await PromoteAsync(CancellationToken.None);
    }

    /// <summary>
    /// Starts a row that was marked downloading, under its hash lock, only if it still is: a pause or delete that
    /// landed between the queue decision and this start wins instead of being resurrected. False when it failed.
    /// </summary>
    private async Task<bool> StartValidatedAsync(string hash)
    {
        using (await LockHashAsync(hash, CancellationToken.None))
        {
            try
            {
                await using var db = await dbFactory.CreateDbContextAsync(CancellationToken.None);
                var row = await FindAsync(db, hash, CancellationToken.None);
                if (row is null || row.Status != EngineTorrentStatus.Downloading || IsDownloaded(row)) return true;
                var outcome = await StartInBackendAsync(row, PurposeOf(row), null, CancellationToken.None);
                if (outcome.Ok) return true;
                logger.LogWarning("Starting {Hash} failed: {Message}", hash, outcome.Message);
                await MarkErrorAsync(hash, outcome.Message);
                return false;
            }
            finally
            {
                _starting.TryRemove(hash, out _);
            }
        }
    }

    /// <summary>
    /// Startup: apply the cap to whatever the database says, then start only active + forced kept rows. Outside the
    /// download hours only forced rows start; the rest wait as queued until a window opens.
    /// </summary>
    internal async Task RehydrateAsync(CancellationToken ct = default)
    {
        await AttachLimitsAsync(ct);
        await using (var seedDb = await dbFactory.CreateDbContextAsync(ct))
        {
            var seeds = await seedDb.EngineTorrents.Where(r => r.UserId == LocalUser.Id
                && r.TorrentUrl == DownloadRecoveryService.SeedingMarker
                && (r.Status == "seeding" || r.Status == EngineTorrentStatus.Downloading)).ToListAsync(ct);
            foreach (var seed in seeds)
                if (File.Exists(TorrentFilePath(seed.Hash)))
                    await RestoreForSeedingAsync(seed.Hash, await File.ReadAllBytesAsync(TorrentFilePath(seed.Hash), ct), ct);
        }
        List<EngineTorrent> start;
        await _queueGate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var all = await db.EngineTorrents.Where(r => r.UserId == LocalUser.Id).ToListAsync(ct);
            var eligible = all.Where(ShouldRehydrate).ToList();
            var schedule = Schedule;
            var plan = DownloadQueue.PlanRehydrate(all.Where(r => r.Status == EngineTorrentStatus.Queued || eligible.Contains(r)).Select(ToQueueRow).ToList(),
                CapFor(schedule), schedule.Open);
            var demote = plan.Demote.ToHashSet();
            foreach (var r in all.Where(r => demote.Contains(r.Hash))) { r.Status = EngineTorrentStatus.Queued; r.UpdatedAt = Now; }
            start = plan.Active.Select(h => all.First(r => r.Hash == h)).ToList();
            foreach (var r in start) r.Status = EngineTorrentStatus.Downloading;
            await db.SaveChangesAsync(ct);
            foreach (var r in start) _starting.TryAdd(r.Hash, 0);
        }
        finally
        {
            _queueGate.Release();
        }
        logger.LogInformation("Engine rehydrate: starting {Count} of the kept downloads (cap {Cap})", start.Count, Cap);
        // One failure (or shutdown mid-way) must not strand the rest as downloading.
        await StartClaimedAsync(start);
    }

    /// <summary>Port of builtin-engine-lifecycle shouldRehydrateTorrent, restricted to kept downloads.</summary>
    internal static bool ShouldRehydrate(EngineTorrent row)
    {
        if (row.TorrentUrl == DownloadRecoveryService.SeedingMarker) return false;
        if (row.Origin != TorrentOrigin.User) return false;
        var status = row.Status.ToLowerInvariant();
        if (status is EngineTorrentStatus.Removed or EngineTorrentStatus.Error or EngineTorrentStatus.Parked
            or EngineTorrentStatus.Queued or EngineTorrentStatus.Paused) return false;
        if (IsDownloaded(row)) return false;
        return !string.IsNullOrWhiteSpace(row.TorrentUrl) || !string.IsNullOrWhiteSpace(row.Magnet) || status == EngineTorrentStatus.Downloading;
    }

    internal static bool IsDownloaded(EngineTorrent row) => row.VerifiedAt is not null && row.Progress >= 0.9999;

    /// <summary>Port of persistedTorrentDisplayState: the UI state of a row that is not live in the client.</summary>
    internal static string PersistedDisplayState(EngineTorrent row)
    {
        var status = row.Status.ToLowerInvariant();
        if (status == EngineTorrentStatus.Error) return "error";
        if (IsDownloaded(row)) return "downloaded";
        if (status is EngineTorrentStatus.Paused or EngineTorrentStatus.Parked) return "paused";
        // Waiting for a slot. Distinct from paused: the owner did not stop it, so the UI offers "Download now".
        if (status == EngineTorrentStatus.Queued) return "queued";
        return row.Progress > 0 ? "downloading" : "metaDL";
    }

    // ---------------------------------------------------------------- read

    public async Task<IReadOnlyList<EngineTorrentInfo>> ListAsync(CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var rows = await db.EngineTorrents.AsNoTracking()
            .Where(r => r.UserId == LocalUser.Id && r.Status != EngineTorrentStatus.Removed)
            .OrderBy(r => r.CreatedAt).ToListAsync(ct);
        var view = QueueViewOf(rows);
        return rows.Select(r => WithMagnet(r, ToInfo(r, backend.Get(r.Hash), view, includeFiles: false))).ToList();
    }

    public async Task<EngineTorrentInfo?> GetAsync(string infoHash, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var rows = await db.EngineTorrents.AsNoTracking().Where(r => r.UserId == LocalUser.Id).ToListAsync(ct);
        var row = rows.FirstOrDefault(r => r.Hash == hash);
        return row is null ? null : WithMagnet(row, ToInfo(row, backend.Get(hash), QueueViewOf(rows), includeFiles: true));
    }

    /// <summary>
    /// A shareable magnet: the transfer's own trackers (from its magnet, else its .torrent) widened with the public
    /// list. Private torrents, and magnets whose trackers are all local/private, keep only their own trackers.
    /// </summary>
    private EngineTorrentInfo WithMagnet(EngineTorrent row, EngineTorrentInfo info)
    {
        if (row.TorrentUrl == DownloadRecoveryService.ImportedMarker) return info with { Imported = true };
        var own = PublicTrackers.TrackersOf(row.Magnet);
        var file = TorrentFileTrackers(row.Hash);
        if (own.Count == 0 && file is { } f) own = f.Trackers;
        var isPrivate = file?.Private ?? false;
        var magnet = PublicTrackers.BuildMagnet(row.Hash, info.Name, own);
        return info with { Magnet = isPrivate ? magnet : PublicTrackers.WidenMagnet(magnet, PublicTrackers.Current) };
    }

    // A saved .torrent never changes for its hash, so its trackers are read once.
    private readonly ConcurrentDictionary<string, (IReadOnlyList<string> Trackers, bool Private)> _torrentTrackers = new(StringComparer.Ordinal);

    private (IReadOnlyList<string> Trackers, bool Private)? TorrentFileTrackers(string hash)
    {
        if (_torrentTrackers.TryGetValue(hash, out var cached)) return cached;
        var path = TorrentFilePath(hash);
        if (!File.Exists(path)) return null;
        try
        {
            var torrent = MonoTorrent.Torrent.Load(path);
            (IReadOnlyList<string>, bool) result = (torrent.AnnounceUrls.SelectMany(t => t).ToList(), torrent.IsPrivate);
            _torrentTrackers[hash] = result;
            return result;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or MonoTorrent.TorrentException or FormatException or ArgumentException or InvalidOperationException)
        {
            // Unreadable metadata: treat as private so nothing beyond the bare hash is shared.
            return ([], true);
        }
    }

    /// <summary>Queue positions and wait reasons for the UI, computed once per read over every row.</summary>
    private sealed record QueueView(IReadOnlyDictionary<string, int> Positions, IReadOnlyDictionary<string, string> Reasons);

    private QueueView QueueViewOf(IReadOnlyCollection<EngineTorrent> rows)
    {
        var queueRows = rows.Select(ToQueueRow).ToList();
        return new QueueView(DownloadQueue.Positions(queueRows), DownloadQueue.WaitReasons(queueRows, Schedule.Open));
    }

    private static EngineTorrentInfo ToInfo(EngineTorrent row, BackendSnapshot? live, QueueView view, bool includeFiles)
    {
        var lane = row.Origin == TorrentOrigin.User ? TorrentLane.FromRank(row.Lane) : null;
        var retention = row.Origin switch
        {
            TorrentOrigin.User => "kept",
            TorrentOrigin.Stream => "stream",
            TorrentOrigin.Prewarm => "prewarm",
            _ => "unknown",
        };
        if (live is not null && row.Status != EngineTorrentStatus.Paused)
        {
            var state = live.State switch
            {
                "complete" => "downloaded",
                "error" => "error",
                var s => s,
            };
            long? eta = null;
            if (live.DownloadRate > 0 && live.SizeBytes > 0)
            {
                var secs = (long)(live.SizeBytes * (1 - live.Progress) / live.DownloadRate);
                if (secs > 0 && secs < 100L * 24 * 3600) eta = secs;
            }
            return new EngineTorrentInfo
            {
                Hash = row.Hash,
                Name = live.HasMetadata ? live.Name : row.Name,
                Progress = live.Progress,
                SizeBytes = live.SizeBytes > 0 ? live.SizeBytes : row.SizeBytes,
                Dlspeed = live.DownloadRate,
                Upspeed = live.UploadRate,
                State = state,
                Eta = eta,
                Peers = live.Peers,
                Error = live.Error ?? row.Error,
                Playable = state == "downloaded" ? true : null,
                Category = row.Category,
                SavePath = row.SavePath,
                RetentionState = retention,
                Lane = lane,
                WorkId = row.WorkId,
                QueueKey = row.QueueKey,
                Files = includeFiles ? live.Files.Select(f => new EngineFileInfo(f.Index, f.Path, f.Length, f.Selected, f.Progress, f.FullPath)).ToList() : null,
                BytesReceived = live.BytesReceived,
            };
        }
        var display = PersistedDisplayState(row);
        return new EngineTorrentInfo
        {
            Hash = row.Hash,
            Name = row.Name,
            Progress = row.Progress,
            SizeBytes = row.SizeBytes,
            State = display,
            Peers = 0,
            Error = row.Error,
            Playable = display == "downloaded" ? true : null,
            Category = row.Category,
            SavePath = row.SavePath,
            RetentionState = retention,
            QueuePosition = display == "queued" && view.Positions.TryGetValue(row.Hash, out var p) ? p : null,
            Lane = lane,
            WaitReason = display == "queued" && view.Reasons.TryGetValue(row.Hash, out var why) ? why : null,
            WorkId = row.WorkId,
            QueueKey = row.QueueKey,
            Files = includeFiles ? VerifiedFiles(row).Select((f, i) => new EngineFileInfo(i, f.Path, f.Size, true, IsDownloaded(row) ? 1 : 0, f.FullPath)).ToList() : null,
        };
    }

    // ---------------------------------------------------------------- actions

    internal async Task<bool> RestoreForSeedingAsync(string hash, byte[] metadata, CancellationToken ct)
    {
        using (await LockHashAsync(hash, ct))
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var row = await FindAsync(db, hash, ct);
            if (row is null || row.Status is not ("seeding" or EngineTorrentStatus.Downloading)) return false;
            SaveTorrentFile(hash, metadata);
            try
            {
                var outcome = await backend.AddAsync(new BackendAddSpec(hash, null, metadata, row.SavePath!,
                    TorrentPurpose.Keep, null, false), ct);
                if (!outcome.Ok) { row.Status = EngineTorrentStatus.Error; row.Error = outcome.Message; }
                else row.Status = "seeding";
                _startedAt[hash] = Now;
                WakeMonitor();
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                logger.LogWarning(ex, "Could not restore {Hash} for seeding", hash);
                row.Status = EngineTorrentStatus.Error;
                row.Error = "Could not restart the saved torrent.";
            }
            await db.SaveChangesAsync(CancellationToken.None);
            return row.Status == "seeding";
        }
    }

    public async Task<EngineActionResult> PauseAsync(string infoHash, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        using (await LockHashAsync(hash, ct))
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var row = await FindAsync(db, hash, ct);
            if (row is null) return new EngineActionResult(false, NotFound);
            if (IsDownloaded(row) || backend.Get(hash)?.State == "complete") return new EngineActionResult(false, DownloadedCannotPause);
            row.Status = EngineTorrentStatus.Paused;
            // A paused item is the owner's decision; it must not jump back ahead of the queue as "forced".
            row.ForcedAt = null;
            row.UpdatedAt = Now;
            await db.SaveChangesAsync(ct);
            if (backend.Contains(hash)) await backend.PauseAsync(hash);
        }
        await PromoteAsync(CancellationToken.None);
        return new EngineActionResult(true, "Paused");
    }

    /// <summary>
    /// Resume is the owner's explicit decision, so it overrides the queue: the transfer starts now even when every
    /// slot is taken (it is marked forced, like "Download now"). Queued rows wait behind it; nothing is preempted.
    /// </summary>
    public Task<EngineActionResult> ResumeAsync(string infoHash, CancellationToken ct = default) =>
        StartNowAsync(infoHash, "Resumed", reannounceIfLive: true, ct);

    public Task<EngineActionResult> ForceAsync(string infoHash, CancellationToken ct = default) =>
        StartNowAsync(infoHash, "Downloading now", reannounceIfLive: false, ct);

    private async Task<EngineActionResult> StartNowAsync(string infoHash, string okMessage, bool reannounceIfLive, CancellationToken ct)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        EngineActionResult result;
        using (await LockHashAsync(hash, ct))
        {
            EngineTorrent row;
            await _queueGate.WaitAsync(ct);
            try
            {
                await using var db = await dbFactory.CreateDbContextAsync(ct);
                var found = await FindAsync(db, hash, ct);
                if (found is null) return new EngineActionResult(false, NotFound);
                row = found;
                if (IsDownloaded(row)) return new EngineActionResult(true, "Already downloaded");
                if (reannounceIfLive && row.Status == EngineTorrentStatus.Downloading && backend.Get(hash) is { State: not "paused" })
                {
                    if (row.Origin == TorrentOrigin.User) await backend.SetSelectedFilesAsync(hash, null);
                    await backend.ResumeAsync(hash);
                    return new EngineActionResult(true, "Re-announced");
                }
                row.ForcedAt = Now;
                row.Status = EngineTorrentStatus.Downloading;
                row.Error = null;
                row.UpdatedAt = Now;
                await db.SaveChangesAsync(ct);
                _starting.TryAdd(hash, 0);
            }
            finally
            {
                _queueGate.Release();
            }
            WakeMonitor();
            result = await StartOrResumeAsync(row, okMessage);
        }
        if (!result.Ok) await PromoteAsync(CancellationToken.None);
        return result;
    }

    /// <summary>Caller holds the hash lock and has persisted the row as downloading, so no request token applies.</summary>
    private async Task<EngineActionResult> StartOrResumeAsync(EngineTorrent row, string okMessage)
    {
        try
        {
            if (backend.Contains(row.Hash))
            {
                // Loaded earlier as a stream (files deselected): a kept download fetches every file.
                if (row.Origin == TorrentOrigin.User) await backend.SetSelectedFilesAsync(row.Hash, null);
                // The metadata deadline counts from this start, not from before the pause.
                _startedAt[row.Hash] = Now;
                await backend.ResumeAsync(row.Hash);
                return new EngineActionResult(true, okMessage);
            }
            var outcome = await StartInBackendAsync(row, PurposeOf(row), null, CancellationToken.None);
            if (outcome.Ok) return new EngineActionResult(true, okMessage);
            await MarkErrorAsync(row.Hash, outcome.Message);
            return new EngineActionResult(false, outcome.Message);
        }
        finally
        {
            _starting.TryRemove(row.Hash, out _);
        }
    }

    public async Task<EngineActionResult> RemoveAsync(string infoHash, bool deleteFiles, CancellationToken ct = default) =>
        (await RemoveManyAsync([infoHash], deleteFiles, ct))[0].Result;

    /// <summary>
    /// Removes several transfers as one delete. Every row goes before any file does, so a season folder the batch
    /// shares only with itself is proven its own and removed whole (sidecars included), and the queue is refilled once
    /// at the end instead of starting a sibling that is about to be deleted. Deletes are serialized, so concurrent
    /// single deletes of one season still see each other gone and the last one takes the folder.
    /// </summary>
    public async Task<IReadOnlyList<(string Hash, EngineActionResult Result)>> RemoveManyAsync(
        IReadOnlyCollection<string> infoHashes, bool deleteFiles, CancellationToken ct = default)
    {
        var hashes = infoHashes.Select(h => h.Trim().ToLowerInvariant()).ToList();
        var results = hashes.Select(h => (Hash: h, Result: new EngineActionResult(false, NotFound))).ToList();
        var removed = new List<(string Hash, string? SavePath, IReadOnlyList<string> Files)>();
        var held = new List<IDisposable>();
        await _removeGate.WaitAsync(ct);
        try
        {
            foreach (var hash in hashes.Where(h => h.Length > 0).Distinct().Order(StringComparer.Ordinal))
            {
                held.Add(await LockHashAsync(hash, ct));
                await using var db = await dbFactory.CreateDbContextAsync(ct);
                var row = await FindAsync(db, hash, ct);
                if (row is null) continue;
                var files = backend.Get(hash)?.Files.Select(f => f.FullPath).ToList()
                    ?? VerifiedFiles(row).Select(f => f.FullPath).Where(p => p is not null).Select(p => p!).ToList();
                if (files.Count == 0 && LoadTorrentFile(hash) is { } meta) files = FilesFromMetadata(meta, row.SavePath);
                db.EngineTorrents.Remove(row);
                await db.SaveChangesAsync(ct);
                if (backend.Contains(hash)) await backend.RemoveAsync(hash);
                _startedAt.TryRemove(hash, out _);
                lock (_openStreams) { _pendingDetach.Remove(hash); _pendingLayout.Remove(hash); }
                removed.Add((hash, row.SavePath, files));
                for (var i = 0; i < results.Count; i++)
                    if (results[i].Hash == hash) results[i] = (hash, new EngineActionResult(true, "Removed"));
            }

            if (deleteFiles && removed.Count > 0)
            {
                var baseRoot = (await settings.GetConfigAsync(CancellationToken.None)).DownloadRoot;
                List<string> otherPaths = [];
                if (!string.IsNullOrWhiteSpace(baseRoot))
                {
                    await using var db = await dbFactory.CreateDbContextAsync(CancellationToken.None);
                    foreach (var other in await db.EngineTorrents.AsNoTracking().ToListAsync(CancellationToken.None))
                    {
                        if (!string.IsNullOrWhiteSpace(other.SavePath)) otherPaths.Add(other.SavePath);
                        otherPaths.AddRange(VerifiedFiles(other).Select(f => f.FullPath).Where(p => p is not null).Select(p => p!));
                    }
                }
                await DeleteReleasesAsync(removed.Select(r => (r.SavePath, r.Files)).ToList(), baseRoot, otherPaths);
                foreach (var r in removed)
                {
                    TryDelete(TorrentFilePath(r.Hash));
                    _layoutManifest.Forget(r.Hash, r.SavePath);
                }
            }
        }
        finally
        {
            foreach (var h in held) h.Dispose();
            _removeGate.Release();
        }
        storage.ResetDirectorySizeCache();
        if (removed.Count > 0) await PromoteAsync(CancellationToken.None);
        return results;
    }

    public async Task<EngineActionResult> SelectFilesAsync(string infoHash, IReadOnlyCollection<int> fileIndices, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        if (!backend.Contains(hash)) return new EngineActionResult(false, NotFound);
        await backend.SetSelectedFilesAsync(hash, fileIndices.ToHashSet());
        return new EngineActionResult(true, "Selection updated");
    }

    public async Task<Stream> OpenFileStreamAsync(string infoHash, string fileIndexOrPath, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        int index;
        using (await LockHashAsync(hash, ct))
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var row = await FindAsync(db, hash, ct) ?? throw new FileNotFoundException(NotFound);
            row.LastUsedAt = Now;
            await db.SaveChangesAsync(ct);

            if (!backend.Contains(hash) && IsDownloaded(row))
            {
                var files = VerifiedFiles(row);
                var match = ResolveIndex(fileIndexOrPath, files.Select(f => f.Path).ToList());
                var path = files[match].FullPath ?? throw new FileNotFoundException("File path not recorded.");
                var local = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024, useAsync: true);
                // Counted like a live stream so the content layout never moves a file out from under a reader.
                lock (_openStreams) _openStreams[hash] = _openStreams.GetValueOrDefault(hash) + 1;
                return new TrackedStream(local, () => OnStreamClosed(hash));
            }
            if (!backend.Contains(hash))
            {
                // The row's own purpose: playing a kept download must not deselect the files it is downloading.
                var outcome = await StartInBackendAsync(row, PurposeOf(row), TimeSpan.FromSeconds(Options.MetadataTimeoutSeconds), ct);
                if (!outcome.Ok) throw new IOException(outcome.Message);
            }
            var live = backend.Get(hash) ?? throw new FileNotFoundException(NotFound);
            index = ResolveIndex(fileIndexOrPath, live.Files.Select(f => f.Path).ToList());
            // Counted before the lock is released so a completion in between defers its detach.
            lock (_openStreams) _openStreams[hash] = _openStreams.GetValueOrDefault(hash) + 1;
        }
        try
        {
            var inner = await backend.OpenStreamAsync(hash, index, ct);
            return new TrackedStream(inner, () => OnStreamClosed(hash));
        }
        catch
        {
            OnStreamClosed(hash);
            throw;
        }
    }

    internal int OpenStreamCount(string hash)
    {
        lock (_openStreams) return _openStreams.GetValueOrDefault(hash);
    }

    public async Task<IReadOnlyList<EngineByteRange>> GetDownloadedRangesAsync(string infoHash, int fileIndex, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        if (backend.Contains(hash))
            return backend.DownloadedRanges(hash, fileIndex).Select(r => new EngineByteRange(r.Start, r.End)).ToList();
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var row = await FindAsync(db, hash, ct);
        if (row is null || !IsDownloaded(row)) return [];
        var files = VerifiedFiles(row);
        return fileIndex >= 0 && fileIndex < files.Count && files[fileIndex].Size > 0 ? [new EngineByteRange(0, files[fileIndex].Size)] : [];
    }

    private void OnStreamClosed(string hash)
    {
        bool detach;
        lock (_openStreams)
        {
            var n = _openStreams.GetValueOrDefault(hash) - 1;
            if (n > 0) _openStreams[hash] = n;
            else _openStreams.Remove(hash);
            detach = n <= 0 && (_pendingDetach.Contains(hash) || _pendingLayout.Contains(hash));
        }
        if (detach)
            _ = DetachDeferredAsync(hash).ContinueWith(t => logger.LogWarning(t.Exception, "Deferred detach of {Hash} failed", hash),
                TaskContinuationOptions.OnlyOnFaulted);
    }

    /// <summary>
    /// A completion that landed while a player was reading: detach now that the last stream closed, then lay the files
    /// out (the layout waits for the same moment, since it renames the files the reader had open).
    /// </summary>
    private async Task DetachDeferredAsync(string hash)
    {
        using (await LockHashAsync(hash, CancellationToken.None))
        {
            bool detach;
            lock (_openStreams)
            {
                if (_openStreams.GetValueOrDefault(hash) > 0) return;
                detach = _pendingDetach.Remove(hash);
                if (!_pendingLayout.Remove(hash) && !detach) return;
            }
            if (detach)
            {
                await backend.RemoveAsync(hash);
                _startedAt.TryRemove(hash, out _);
            }
            await FinalizeLayoutLockedAsync(hash);
        }
    }

    /// <summary>
    /// Validates and lays out a parked download. Caller holds the hash lock; runs only once the client has let go of
    /// the files and no reader is open, otherwise it is deferred to the last stream's close.
    /// </summary>
    private async Task<LayoutOutcome> FinalizeLayoutLockedAsync(string hash) => (await FinalizeLayoutLockedAsync(hash, validate: true, tidy: false)).Outcome;

    /// <param name="tidy">An owner's re-run over old downloads: an open stream skips the row instead of deferring it.</param>
    private async Task<LayoutResult> FinalizeLayoutLockedAsync(string hash, bool validate, bool tidy)
    {
        if (layout is null) return LayoutResult.Unchanged;
        lock (_openStreams)
        {
            if (_openStreams.GetValueOrDefault(hash) > 0)
            {
                if (!tidy) _pendingLayout.Add(hash);
                return LayoutResult.Unchanged;
            }
        }
        if (backend.Contains(hash)) return LayoutResult.Unchanged;
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(CancellationToken.None);
            var row = await FindAsync(db, hash, CancellationToken.None);
            if (row is null || row.Status != EngineTorrentStatus.Parked || !IsDownloaded(row)) return LayoutResult.Unchanged;
            // Loaded downloads write without a release folder, so a path they will write to is taken even before it exists.
            var live = backend.List().Where(s => !string.Equals(s.Hash, hash, StringComparison.OrdinalIgnoreCase))
                .SelectMany(s => s.Files.Select(f => (s.Hash, f.FullPath))).ToList();
            var result = await layout.FinalizeDetailedAsync(db, row, validate, CancellationToken.None, live);
            if (result.Outcome == LayoutOutcome.LaidOut)
                _layoutManifest.Remember(row.Hash, row.SavePath, VerifiedFiles(row).Select(f => f.FullPath).ToList());
            if (result.Outcome != LayoutOutcome.Unchanged) storage.ResetDirectorySizeCache();
            return result;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // A layout tweak must never stop a download from counting as finished.
            logger.LogWarning(ex, "[content-layout] rewrite failed for {Hash}", hash);
            return LayoutResult.Unchanged;
        }
    }

    /// <summary>
    /// Re-runs the content layout over every finished download, oldest first: files still sitting in a release folder
    /// move into place (all-or-nothing per torrent). A transfer the client holds or a reader has open is skipped. Media
    /// was validated when it finished, so it is not re-probed.
    /// </summary>
    public async Task<LayoutTidyResult> TidyAsync(CancellationToken ct)
    {
        List<string> hashes;
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            hashes = await db.EngineTorrents.AsNoTracking()
                .Where(r => r.UserId == LocalUser.Id && r.Status == EngineTorrentStatus.Parked && r.VerifiedAt != null && r.VerifiedFilesJson != null)
                .OrderBy(r => r.VerifiedAt).Select(r => r.Hash).ToListAsync(ct);
        }
        int tidied = 0, moved = 0, kept = 0, skipped = 0;
        foreach (var hash in hashes)
        {
            ct.ThrowIfCancellationRequested();
            bool busy;
            lock (_openStreams) busy = _openStreams.GetValueOrDefault(hash) > 0;
            if (busy || backend.Contains(hash))
            {
                skipped++;
                continue;
            }
            LayoutResult result;
            using (await LockHashAsync(hash, ct)) result = await FinalizeLayoutLockedAsync(hash, validate: false, tidy: true);
            if (result.Outcome != LayoutOutcome.LaidOut) continue;
            tidied++;
            moved += result.Moved;
            kept += result.KeptVideos;
        }
        logger.LogInformation("[content-layout] tidy: {Tidied} of {Checked} downloads rearranged, {Moved} files moved, {Kept} videos kept in a release folder, {Skipped} busy",
            tidied, hashes.Count, moved, kept, skipped);
        return new LayoutTidyResult(hashes.Count, tidied, moved, kept, skipped);
    }

    private static int ResolveIndex(string fileIndexOrPath, IReadOnlyList<string> paths)
    {
        if (int.TryParse(fileIndexOrPath, out var i) && i >= 0 && i < paths.Count) return i;
        var norm = fileIndexOrPath.Replace('\\', '/').Trim('/');
        for (var k = 0; k < paths.Count; k++)
            if (string.Equals(paths[k].Replace('\\', '/').Trim('/'), norm, StringComparison.OrdinalIgnoreCase)) return k;
        throw new FileNotFoundException($"No file '{fileIndexOrPath}' in torrent.");
    }

    private static Task<EngineTorrent?> FindAsync(TorrentFlowDbContext db, string hash, CancellationToken ct) =>
        db.EngineTorrents.FirstOrDefaultAsync(r => r.UserId == LocalUser.Id && r.Hash == hash, ct);

    /// <summary>Always runs to completion: it is the cleanup that releases a slot, so it never takes a request token.</summary>
    private async Task MarkErrorAsync(string hash, string message)
    {
        await using (var db = await dbFactory.CreateDbContextAsync(CancellationToken.None))
        {
            var row = await FindAsync(db, hash, CancellationToken.None);
            if (row is not null)
            {
                row.Status = EngineTorrentStatus.Error;
                row.Error = message;
                row.ForcedAt = null;
                row.UpdatedAt = Now;
                await db.SaveChangesAsync(CancellationToken.None);
            }
        }
        if (backend.Contains(hash)) await backend.RemoveAsync(hash);
        _startedAt.TryRemove(hash, out _);
    }

    // ---------------------------------------------------------------- monitor

    /// <summary>
    /// One monitor pass: persist live progress, finalise completed transfers (verify files, record the manifest,
    /// detach from the client so a finished download holds no peers or cache), fail magnets that never resolve,
    /// and refill the queue.
    /// </summary>
    internal async Task TickAsync(CancellationToken ct = default)
    {
        await ApplyRateLimitsAsync();
        var liveHashes = backend.LiveHashes().ToList();
        var generation = Volatile.Read(ref _wakes);
        if (liveHashes.Count == 0 && Volatile.Read(ref _idleAtWake) == generation) return;

        var completed = new List<EngineTorrentCompletedEventArgs>();
        var detach = new List<string>();
        var finalize = new List<string>();
        var stranded = new List<string>();
        var anyQueued = false;
        HashSet<string> lostHashes;
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            // Only rows the tick can act on: live transfers, plus downloading (stranded) and queued (promotable) rows.
            // Finished library rows stay unread; EF then writes only the columns that actually changed.
            var rows = await db.EngineTorrents
                .Where(r => r.UserId == LocalUser.Id && (liveHashes.Contains(r.Hash)
                    || r.Status.ToLower() == EngineTorrentStatus.Downloading || r.Status.ToLower() == EngineTorrentStatus.Queued))
                .ToListAsync(ct);
            anyQueued = rows.Any(r => string.Equals(r.Status, EngineTorrentStatus.Queued, StringComparison.OrdinalIgnoreCase));
            foreach (var row in rows)
            {
                var live = backend.Get(row.Hash);
                if (live is null)
                {
                    // Marked downloading but not in the client (a start that died, a client drop): it holds a slot
                    // and nothing would ever move it, so restart it.
                    if (row.Origin == TorrentOrigin.User && row.Status == EngineTorrentStatus.Downloading && !IsDownloaded(row)
                        && !_starting.ContainsKey(row.Hash))
                        stranded.Add(row.Hash);
                    continue;
                }
                if (row.Status == EngineTorrentStatus.Parked && IsDownloaded(row))
                {
                    // Finalised while a stream was open; the last stream normally detaches it, this is the backstop.
                    if (OpenStreamCount(row.Hash) == 0) { detach.Add(row.Hash); finalize.Add(row.Hash); }
                    continue;
                }
                if (live.HasMetadata)
                {
                    row.Name = live.Name;
                    if (live.SizeBytes > 0) row.SizeBytes = live.SizeBytes;
                }
                row.Progress = Math.Round(live.Progress, 4);

                var startedAt = _startedAt.TryGetValue(row.Hash, out var t) ? t : row.UpdatedAt;
                if (live.State == "error")
                {
                    row.Status = EngineTorrentStatus.Error;
                    row.Error = live.Error ?? "The torrent client reported an error.";
                    row.ForcedAt = null;
                    detach.Add(row.Hash);
                }
                else if (!live.HasMetadata && row.Status == EngineTorrentStatus.Downloading
                    && Now - startedAt > TimeSpan.FromSeconds(Options.MetadataTimeoutSeconds))
                {
                    row.Status = EngineTorrentStatus.Error;
                    row.Error = "Timed out waiting for torrent metadata (no peers / blocked DHT?). Try another release or check network.";
                    row.ForcedAt = null;
                    detach.Add(row.Hash);
                }
                else if (live.State == "complete" && live.Files.Count > 0 && live.Files.All(f => f.Selected))
                {
                    if (row.TorrentUrl == DownloadRecoveryService.SeedingMarker && IsDownloaded(row)) continue;
                    var manifest = BuildManifest(live);
                    if (manifest is not null)
                    {
                        row.VerifiedFilesJson = JsonSerializer.Serialize(manifest, JsonOptions);
                        row.VerifiedBitfield = live.PieceBitfield;
                        row.VerifiedAt = Now;
                        row.Progress = 1;
                        row.Status = row.TorrentUrl == DownloadRecoveryService.SeedingMarker ? "seeding" : EngineTorrentStatus.Parked;
                        row.ForcedAt = null;
                        row.Error = null;
                        if (row.TorrentUrl == DownloadRecoveryService.SeedingMarker)
                        {
                            completed.Add(new EngineTorrentCompletedEventArgs(row.Hash, row.Name, row.SavePath, row.Origin));
                            continue;
                        }
                        // Detaching under an open stream would cut the player off mid-file.
                        var deferred = false;
                        lock (_openStreams)
                        {
                            if (_openStreams.GetValueOrDefault(row.Hash) > 0) { _pendingDetach.Add(row.Hash); deferred = true; }
                        }
                        if (!deferred) { detach.Add(row.Hash); finalize.Add(row.Hash); }
                        completed.Add(new EngineTorrentCompletedEventArgs(row.Hash, row.Name, row.SavePath, row.Origin));
                    }
                }
            }
            // State first, then detach: a crash in between leaves a parked/error row, never a lost transfer.
            var lost = await SaveTolerantAsync(db);
            completed.RemoveAll(e => lost.Contains(e.Hash));
            lostHashes = lost;
        }
        foreach (var hash in detach)
        {
            try { await backend.RemoveAsync(hash); }
            catch (Exception ex) { logger.LogWarning(ex, "Detaching {Hash} failed", hash); }
            _startedAt.TryRemove(hash, out _);
        }
        // Released by the client, so the files can be validated and moved to their final layout.
        foreach (var hash in finalize)
        {
            if (lostHashes.Contains(hash)) continue;
            LayoutOutcome outcome;
            using (await LockHashAsync(hash, CancellationToken.None)) outcome = await FinalizeLayoutLockedAsync(hash);
            // Not playable video: it is an error row now, not a finished download.
            if (outcome == LayoutOutcome.Invalid) completed.RemoveAll(e => e.Hash == hash);
        }
        foreach (var hash in stranded)
        {
            if (!_starting.TryAdd(hash, 0)) continue;
            logger.LogWarning("Transfer {Hash} was marked downloading but not loaded; restarting it", hash);
            try { await StartValidatedAsync(hash); }
            catch (Exception ex) { logger.LogError(ex, "Restarting {Hash} failed", hash); }
        }
        if (completed.Count > 0) storage.ResetDirectorySizeCache();
        foreach (var e in completed)
        {
            logger.LogInformation("Transfer {Hash} complete; parked {Name}", e.Hash, e.Name);
            try { TorrentCompleted?.Invoke(this, e); }
            catch (Exception ex) { logger.LogError(ex, "TorrentCompleted handler failed for {Hash}", e.Hash); }
        }
        // Queued rows can take a slot freed by a completion, failure or cap raise; with none there is nothing to promote.
        if (liveHashes.Count == 0 && !anyQueued && stranded.Count == 0) Volatile.Write(ref _idleAtWake, generation);
        if (anyQueued) await PromoteAsync(ct);
    }

    private void WakeMonitor() => Interlocked.Increment(ref _wakes);

    private readonly SemaphoreSlim _rateGate = new(1, 1);

    /// <summary>
    /// Pushes the active window's speed caps to the client, and the base limits back once it ends. Runs every tick so a
    /// window boundary takes effect within one monitor interval. A failure is logged and retried on the next tick.
    /// </summary>
    internal async Task ApplyRateLimitsAsync()
    {
        var active = Schedule.Active;
        (long? Down, long? Up) desired = (active?.MaxDownloadRate, active?.MaxUploadRate);
        await _rateGate.WaitAsync();
        try
        {
            if (_appliedRates == desired) return;
            await backend.ApplyRateLimitsAsync(desired.Down, desired.Up);
            _appliedRates = desired;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Applying download-window speed limits failed");
        }
        finally
        {
            _rateGate.Release();
        }
    }

    /// <summary>
    /// Saves the monitor's batch. A row deleted meanwhile (the user removed it) makes the whole batch fail with a
    /// concurrency error; drop just those rows and save the rest. Returns the hashes that were dropped.
    /// </summary>
    private static async Task<HashSet<string>> SaveTolerantAsync(TorrentFlowDbContext db)
    {
        var lost = new HashSet<string>(StringComparer.Ordinal);
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                await db.SaveChangesAsync(CancellationToken.None);
                return lost;
            }
            catch (DbUpdateConcurrencyException ex) when (attempt < 5)
            {
                foreach (var entry in ex.Entries)
                {
                    if (entry.Entity is EngineTorrent t) lost.Add(t.Hash);
                    entry.State = EntityState.Detached;
                }
            }
        }
    }

    private async Task PersistSnapshotAsync(BackendSnapshot snap)
    {
        await using var db = await dbFactory.CreateDbContextAsync(CancellationToken.None);
        var row = await FindAsync(db, snap.Hash, CancellationToken.None);
        if (row is null) return;
        if (snap.HasMetadata) { row.Name = snap.Name; if (snap.SizeBytes > 0) row.SizeBytes = snap.SizeBytes; }
        row.Progress = Math.Round(snap.Progress, 4);
        await db.SaveChangesAsync(CancellationToken.None);
    }

    // ---------------------------------------------------------------- files

    internal sealed record ManifestFile(string Path, long Size, long MtimeMs, string? FullPath);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>Completion evidence: every file exists at its expected size. Null when any is missing.</summary>
    private static List<ManifestFile>? BuildManifest(BackendSnapshot live)
    {
        var list = new List<ManifestFile>();
        foreach (var f in live.Files)
        {
            var info = new FileInfo(f.FullPath);
            if (!info.Exists || info.Length != f.Length) return null;
            list.Add(new ManifestFile(f.Path, f.Length, new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds(), info.FullName));
        }
        return list;
    }

    internal static List<ManifestFile> VerifiedFiles(EngineTorrent row)
    {
        if (string.IsNullOrWhiteSpace(row.VerifiedFilesJson)) return [];
        try { return JsonSerializer.Deserialize<List<ManifestFile>>(row.VerifiedFilesJson, JsonOptions) ?? []; }
        catch (JsonException) { return []; }
    }

    private static List<string> FilesFromMetadata(byte[] meta, string? savePath)
    {
        if (string.IsNullOrWhiteSpace(savePath)) return [];
        try
        {
            var t = MonoTorrent.Torrent.Load(meta);
            return t.Files.Select(f => Path.Combine(savePath, f.Path.Replace('/', Path.DirectorySeparatorChar))).ToList();
        }
        catch (Exception) { return []; }
    }

    /// <summary>
    /// Deletes a batch of releases whose rows are already gone, so <paramref name="otherPaths"/> never holds a sibling
    /// from the same batch and a season folder holding only this batch's episodes is proven theirs. A file the client
    /// is still letting go of (Windows keeps a handle for a moment after a stop) is retried briefly, not left behind.
    /// </summary>
    internal static async Task DeleteReleasesAsync(IReadOnlyList<(string? SavePath, IReadOnlyList<string> Files)> releases,
        string? baseRoot, IReadOnlyList<string> otherPaths, int attempts = 12, int delayMs = 250)
    {
        var owned = releases.SelectMany(r => ReleaseFileRemoval.Plan(r.Files, r.SavePath, baseRoot, []).Files).ToList();
        for (var attempt = 0; ; attempt++)
        {
            foreach (var (savePath, files) in releases) DeleteReleaseFiles(files, savePath, baseRoot, otherPaths);
            if (attempt + 1 >= attempts || !owned.Any(File.Exists)) return;
            await Task.Delay(delayMs);
        }
    }

    /// <summary>
    /// Deletes a release from disk the way Next's <c>deleteTorrent</c> does: its recorded files and its own folder
    /// (sidecar junk included) per <see cref="ReleaseFileRemoval.Plan"/>, then empty folders below the save path and
    /// up to (never including) the download root. Without a root, only the files and folders they leave empty inside
    /// the save path go.
    /// </summary>
    internal static void DeleteReleaseFiles(IReadOnlyList<string> files, string? savePath, string? baseRoot, IReadOnlyList<string> otherPaths)
    {
        if (string.IsNullOrWhiteSpace(baseRoot))
        {
            DeleteReleaseFiles(files, savePath);
            return;
        }
        var plan = ReleaseFileRemoval.Plan(files, savePath, baseRoot, otherPaths);
        ReleaseFileRemoval.Execute(plan);
        ReleaseFileRemoval.PruneEmptyDescendants(savePath, baseRoot);
        foreach (var start in plan.Files.Select(Path.GetDirectoryName).Append(savePath).Where(p => p is not null).Distinct())
            Clients.External.ExternalClientRegistry.PruneEmptyParents(start, baseRoot);
    }

    /// <summary>
    /// Deletes a release's recorded files and then any directories they leave empty, walking up but never past
    /// the transfer's save path, so shared category folders and other releases are untouched.
    /// </summary>
    internal static void DeleteReleaseFiles(IEnumerable<string> files, string? savePath)
    {
        var root = string.IsNullOrWhiteSpace(savePath) ? null : Path.GetFullPath(savePath).TrimEnd(Path.DirectorySeparatorChar);
        var dirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in files)
        {
            var full = Path.GetFullPath(file);
            if (root is null || !full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) continue;
            TryDelete(full);
            var dir = Path.GetDirectoryName(full);
            while (dir is not null && dir.Length > root.Length) { dirs.Add(dir); dir = Path.GetDirectoryName(dir); }
        }
        foreach (var dir in dirs.OrderByDescending(d => d.Length))
        {
            try { if (Directory.Exists(dir) && !Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static string? FirstNonBlank(params string?[] values) => values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v))?.Trim();
}
