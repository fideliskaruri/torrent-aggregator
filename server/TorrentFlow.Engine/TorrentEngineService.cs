using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Queue;
using TorrentFlow.Engine.Settings;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine;

/// <summary>
/// The built-in engine: EngineTorrent row lifecycle + download queue on top of <see cref="ITorrentBackend"/>.
/// Queue decisions (admit / promote / demote) are serialised by one gate so two concurrent adds can never
/// both take the last slot.
/// </summary>
internal sealed class TorrentEngineService(
    IDbContextFactory<TorrentFlowDbContext> dbFactory,
    ITorrentBackend backend,
    IOptionsMonitor<EngineOptions> options,
    ClientSettingsStore settings,
    StorageBudget storage,
    IHttpClientFactory httpFactory,
    TimeProvider time,
    ILogger<TorrentEngineService> logger) : ITorrentEngine
{
    public const string HttpClientName = "TorrentFlow.Engine.TorrentFiles";
    public const string DownloadedCannotPause = "Downloaded files cannot be paused.";
    public const string NotFound = "Torrent not found in engine.";

    private readonly SemaphoreSlim _queueGate = new(1, 1);

    public event EventHandler<EngineTorrentCompletedEventArgs>? TorrentCompleted;

    private EngineOptions Options => options.CurrentValue;
    private int Cap => Math.Max(1, Options.MaxActiveDownloads);
    private DateTime Now => time.GetUtcNow().UtcDateTime;

    // ---------------------------------------------------------------- add

    public async Task<EngineAddResult> AddAsync(EngineAddRequest request, CancellationToken ct = default)
    {
        var purpose = request.Purpose is TorrentPurpose.Stream or TorrentPurpose.Prewarm ? request.Purpose : TorrentPurpose.Keep;
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
        if (!string.IsNullOrEmpty(magnet)) magnet = TorrentSource.WidenTrackers(magnet, Options.PublicTrackers);
        if (bytes is not null) SaveTorrentFile(hash, bytes);

        var config = await settings.GetConfigAsync(ct);
        var target = ClientSettingsStore.ResolveDownloadTarget(config, request.Category, request.SavePath);
        var savePath = target.SavePath ?? Path.Combine(Options.DataDirectory, "downloads");

        EngineTorrent row;
        bool queued;
        await _queueGate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var existing = await db.EngineTorrents.FirstOrDefaultAsync(r => r.UserId == LocalUser.Id && r.Hash == hash, ct);

            if (existing is not null && TorrentOrigin.Rank(origin) > TorrentOrigin.Rank(existing.Origin))
            {
                existing.Origin = origin;
                existing.UpdatedAt = Now;
                await db.SaveChangesAsync(ct);
                if (origin == TorrentOrigin.User && backend.Contains(hash)) await backend.SetSelectedFilesAsync(hash, null);
            }

            if (backend.Get(hash) is { } live)
            {
                if (request.Forced && existing is not null && existing.ForcedAt is null)
                {
                    existing.ForcedAt = Now;
                    await db.SaveChangesAsync(ct);
                }
                return live.State == "complete"
                    ? new EngineAddResult(true, "", new EngineAddDetails(EngineAddDetails.AlreadyComplete, 100, 0), hash)
                    : new EngineAddResult(true, "", new EngineAddDetails(EngineAddDetails.AlreadyDownloading, Math.Round(live.Progress * 100, 1), live.Peers), hash);
            }

            if (existing is not null && IsDownloaded(existing))
                return new EngineAddResult(true, "", new EngineAddDetails(EngineAddDetails.AlreadyComplete, 100, 0), hash);

            if (existing is not null && existing.Status == EngineTorrentStatus.Queued && !request.Forced && purpose == TorrentPurpose.Keep)
            {
                var pos = await QueuePositionAsync(db, hash, ct);
                return QueuedResult(hash, pos);
            }

            if (purpose == TorrentPurpose.Keep && existing is null)
            {
                var reserved = DownloadQueue.QueuedReservedBytes(await QueueRowsAsync(db, ct));
                var check = storage.Check(config.DownloadRoot, config.MaxStorageBytes, request.ExpectedSizeBytes, reserved, request.OverrideStorageCap);
                if (!check.Ok) return new EngineAddResult(false, check.Message ?? "Storage limit", null, hash) { StorageLimit = check.Limit };
            }

            var rows = await QueueRowsAsync(db, ct);
            queued = DownloadQueue.ShouldQueueNewDownload(rows.Where(r => r.Hash != hash).ToList(), Cap, origin, request.Forced);

            row = existing ?? new EngineTorrent { Id = Ids.New(), UserId = LocalUser.Id, Hash = hash, CreatedAt = Now, LastUsedAt = Now, Origin = origin };
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
            await db.SaveChangesAsync(ct);

            if (queued)
            {
                var pos = await QueuePositionAsync(db, hash, ct);
                return QueuedResult(hash, pos);
            }
        }
        finally
        {
            _queueGate.Release();
        }

        var outcome = await StartInBackendAsync(row, purpose, TimeSpan.FromSeconds(Options.MetadataTimeoutSeconds), ct);
        if (!outcome.Ok)
        {
            await MarkErrorAsync(hash, outcome.Message, ct);
            await PromoteAsync(ct);
            return new EngineAddResult(false, outcome.Message, null, hash);
        }
        var snap = outcome.Snapshot;
        if (snap is not null) await PersistSnapshotAsync(snap, ct);
        return new EngineAddResult(true, "Added to the built-in engine.",
            new EngineAddDetails(EngineAddDetails.Started, Math.Round((snap?.Progress ?? 0) * 100, 1), snap?.Peers ?? 0), hash);
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
        var spec = new BackendAddSpec(row.Hash, bytes is null ? row.Magnet : null, bytes,
            row.SavePath ?? Path.Combine(Options.DataDirectory, "downloads"), purpose, metadataTimeout);
        try
        {
            var outcome = await backend.AddAsync(spec, ct);
            if (outcome.Ok && backend.GetMetadata(row.Hash) is { } meta) SaveTorrentFile(row.Hash, meta);
            return outcome;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Adding {Hash} to the client failed", row.Hash);
            return new BackendAddOutcome(false, "Torrent was added but dropped from the engine immediately — check server logs.");
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
        new(r.Hash, r.Status, r.Origin, r.CreatedAt, r.WorkId, r.QueueKey, r.ForcedAt, r.SizeBytes);

    private static async Task<int?> QueuePositionAsync(TorrentFlowDbContext db, string hash, CancellationToken ct) =>
        DownloadQueue.Positions(await QueueRowsAsync(db, ct)).TryGetValue(hash, out var p) ? p : null;

    public async Task<long> QueuedReservedBytesAsync(CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return DownloadQueue.QueuedReservedBytes(await QueueRowsAsync(db, ct));
    }

    /// <summary>Fills free slots from the head of the queue. Runs after complete / pause / delete / fail.</summary>
    internal async Task<IReadOnlyList<string>> PromoteAsync(CancellationToken ct = default)
    {
        List<EngineTorrent> promoted;
        await _queueGate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var candidates = DownloadQueue.PromotionCandidates(await QueueRowsAsync(db, ct), Cap);
            if (candidates.Count == 0) return [];
            promoted = await db.EngineTorrents.Where(r => r.UserId == LocalUser.Id && candidates.Contains(r.Hash)).ToListAsync(ct);
            foreach (var r in promoted) { r.Status = EngineTorrentStatus.Downloading; r.UpdatedAt = Now; }
            await db.SaveChangesAsync(ct);
        }
        finally
        {
            _queueGate.Release();
        }

        foreach (var r in promoted)
        {
            // No metadata wait here: the monitor times out a magnet that never resolves and promotes the next one.
            var outcome = await StartInBackendAsync(r, TorrentPurpose.Keep, null, ct);
            if (!outcome.Ok)
            {
                logger.LogWarning("Queue promotion of {Hash} failed: {Message}", r.Hash, outcome.Message);
                await MarkErrorAsync(r.Hash, outcome.Message, ct);
            }
        }
        return promoted.Select(r => r.Hash).ToList();
    }

    /// <summary>Startup: apply the cap to whatever the database says, then start only active + forced kept rows.</summary>
    internal async Task RehydrateAsync(CancellationToken ct = default)
    {
        List<EngineTorrent> start;
        await _queueGate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var all = await db.EngineTorrents.Where(r => r.UserId == LocalUser.Id).ToListAsync(ct);
            var eligible = all.Where(ShouldRehydrate).ToList();
            var plan = DownloadQueue.PlanRehydrate(all.Where(r => r.Status == EngineTorrentStatus.Queued || eligible.Contains(r)).Select(ToQueueRow).ToList(), Cap);
            var demote = plan.Demote.ToHashSet();
            foreach (var r in all.Where(r => demote.Contains(r.Hash))) { r.Status = EngineTorrentStatus.Queued; r.UpdatedAt = Now; }
            var active = plan.Active.ToHashSet();
            start = all.Where(r => active.Contains(r.Hash)).ToList();
            foreach (var r in start) r.Status = EngineTorrentStatus.Downloading;
            await db.SaveChangesAsync(ct);
        }
        finally
        {
            _queueGate.Release();
        }
        logger.LogInformation("Engine rehydrate: starting {Count} of the kept downloads (cap {Cap})", start.Count, Cap);
        foreach (var r in start)
        {
            var outcome = await StartInBackendAsync(r, TorrentPurpose.Keep, null, ct);
            if (!outcome.Ok) await MarkErrorAsync(r.Hash, outcome.Message, ct);
        }
    }

    /// <summary>Port of builtin-engine-lifecycle shouldRehydrateTorrent, restricted to kept downloads.</summary>
    internal static bool ShouldRehydrate(EngineTorrent row)
    {
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
        var positions = DownloadQueue.Positions(rows.Select(ToQueueRow));
        return rows.Select(r => ToInfo(r, backend.Get(r.Hash), positions, includeFiles: false)).ToList();
    }

    public async Task<EngineTorrentInfo?> GetAsync(string infoHash, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var rows = await db.EngineTorrents.AsNoTracking().Where(r => r.UserId == LocalUser.Id).ToListAsync(ct);
        var row = rows.FirstOrDefault(r => r.Hash == hash);
        return row is null ? null : ToInfo(row, backend.Get(hash), DownloadQueue.Positions(rows.Select(ToQueueRow)), includeFiles: true);
    }

    private static EngineTorrentInfo ToInfo(EngineTorrent row, BackendSnapshot? live, IReadOnlyDictionary<string, int> positions, bool includeFiles)
    {
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
                WorkId = row.WorkId,
                QueueKey = row.QueueKey,
                Files = includeFiles ? live.Files.Select(f => new EngineFileInfo(f.Index, f.Path, f.Length, f.Selected, f.Progress, f.FullPath)).ToList() : null,
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
            QueuePosition = display == "queued" && positions.TryGetValue(row.Hash, out var p) ? p : null,
            WorkId = row.WorkId,
            QueueKey = row.QueueKey,
            Files = includeFiles ? VerifiedFiles(row).Select((f, i) => new EngineFileInfo(i, f.Path, f.Size, true, IsDownloaded(row) ? 1 : 0, f.FullPath)).ToList() : null,
        };
    }

    // ---------------------------------------------------------------- actions

    public async Task<EngineActionResult> PauseAsync(string infoHash, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            var row = await FindAsync(db, hash, ct);
            if (row is null) return new EngineActionResult(false, NotFound);
            if (IsDownloaded(row) || backend.Get(hash)?.State == "complete") return new EngineActionResult(false, DownloadedCannotPause);
            if (backend.Contains(hash)) await backend.PauseAsync(hash);
            row.Status = EngineTorrentStatus.Paused;
            // A paused item is the owner's decision; it must not jump back ahead of the queue as "forced".
            row.ForcedAt = null;
            row.UpdatedAt = Now;
            await db.SaveChangesAsync(ct);
        }
        await PromoteAsync(ct);
        return new EngineActionResult(true, "Paused");
    }

    public async Task<EngineActionResult> ResumeAsync(string infoHash, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        EngineTorrent row;
        await _queueGate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var found = await FindAsync(db, hash, ct);
            if (found is null) return new EngineActionResult(false, NotFound);
            row = found;
            if (IsDownloaded(row)) return new EngineActionResult(true, "Already downloaded");
            if (row.Status == EngineTorrentStatus.Downloading && backend.Contains(hash))
            {
                await backend.ResumeAsync(hash);
                return new EngineActionResult(true, "Re-announced");
            }
            if (row.Status == EngineTorrentStatus.Queued)
            {
                var pos = await QueuePositionAsync(db, hash, ct);
                return new EngineActionResult(true, pos is { } p ? $"Queued — #{p} in line" : "Queued");
            }
            var others = (await QueueRowsAsync(db, ct)).Where(r => r.Hash != hash).ToList();
            if (DownloadQueue.ShouldQueueNewDownload(others, Cap, row.Origin, forced: false))
            {
                row.Status = EngineTorrentStatus.Queued;
                row.Error = null;
                row.UpdatedAt = Now;
                await db.SaveChangesAsync(ct);
                if (backend.Contains(hash)) await backend.RemoveAsync(hash);
                var pos = await QueuePositionAsync(db, hash, ct);
                return new EngineActionResult(true, pos is { } p ? $"Queued — #{p} in line" : "Queued");
            }
            row.Status = EngineTorrentStatus.Downloading;
            row.Error = null;
            row.UpdatedAt = Now;
            await db.SaveChangesAsync(ct);
        }
        finally
        {
            _queueGate.Release();
        }
        return await StartOrResumeAsync(row, "Resumed", ct);
    }

    public async Task<EngineActionResult> ForceAsync(string infoHash, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        EngineTorrent row;
        await _queueGate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var found = await FindAsync(db, hash, ct);
            if (found is null) return new EngineActionResult(false, NotFound);
            row = found;
            if (IsDownloaded(row)) return new EngineActionResult(true, "Already downloaded");
            row.ForcedAt = Now;
            row.Status = EngineTorrentStatus.Downloading;
            row.Error = null;
            row.UpdatedAt = Now;
            await db.SaveChangesAsync(ct);
        }
        finally
        {
            _queueGate.Release();
        }
        return await StartOrResumeAsync(row, "Downloading now", ct);
    }

    private async Task<EngineActionResult> StartOrResumeAsync(EngineTorrent row, string okMessage, CancellationToken ct)
    {
        if (backend.Contains(row.Hash))
        {
            await backend.ResumeAsync(row.Hash);
            return new EngineActionResult(true, okMessage);
        }
        var outcome = await StartInBackendAsync(row, PurposeOf(row), null, ct);
        if (outcome.Ok) return new EngineActionResult(true, okMessage);
        await MarkErrorAsync(row.Hash, outcome.Message, ct);
        await PromoteAsync(ct);
        return new EngineActionResult(false, outcome.Message);
    }

    public async Task<EngineActionResult> RemoveAsync(string infoHash, bool deleteFiles, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            var row = await FindAsync(db, hash, ct);
            if (row is null) return new EngineActionResult(false, NotFound);
            var files = backend.Get(hash)?.Files.Select(f => f.FullPath).ToList()
                ?? VerifiedFiles(row).Select(f => f.FullPath).Where(p => p is not null).Select(p => p!).ToList();
            if (files.Count == 0 && LoadTorrentFile(hash) is { } meta) files = FilesFromMetadata(meta, row.SavePath);
            if (backend.Contains(hash)) await backend.RemoveAsync(hash);
            if (deleteFiles) DeleteReleaseFiles(files, row.SavePath);
            if (deleteFiles) TryDelete(TorrentFilePath(hash));
            db.EngineTorrents.Remove(row);
            await db.SaveChangesAsync(ct);
        }
        storage.ResetDirectorySizeCache();
        await PromoteAsync(ct);
        return new EngineActionResult(true, "Removed");
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
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var row = await FindAsync(db, hash, ct) ?? throw new FileNotFoundException(NotFound);
        row.LastUsedAt = Now;
        await db.SaveChangesAsync(ct);

        if (!backend.Contains(hash) && IsDownloaded(row))
        {
            var files = VerifiedFiles(row);
            var match = ResolveIndex(fileIndexOrPath, files.Select(f => f.Path).ToList());
            var path = files[match].FullPath ?? throw new FileNotFoundException("File path not recorded.");
            return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024, useAsync: true);
        }
        if (!backend.Contains(hash))
        {
            var outcome = await StartInBackendAsync(row, TorrentPurpose.Stream, TimeSpan.FromSeconds(Options.MetadataTimeoutSeconds), ct);
            if (!outcome.Ok) throw new IOException(outcome.Message);
        }
        var live = backend.Get(hash) ?? throw new FileNotFoundException(NotFound);
        var index = ResolveIndex(fileIndexOrPath, live.Files.Select(f => f.Path).ToList());
        return await backend.OpenStreamAsync(hash, index, ct);
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

    private async Task MarkErrorAsync(string hash, string message, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var row = await FindAsync(db, hash, ct);
        if (row is null) return;
        row.Status = EngineTorrentStatus.Error;
        row.Error = message;
        row.ForcedAt = null;
        row.UpdatedAt = Now;
        await db.SaveChangesAsync(ct);
        if (backend.Contains(hash)) await backend.RemoveAsync(hash);
    }

    // ---------------------------------------------------------------- monitor

    /// <summary>
    /// One monitor pass: persist live progress, finalise completed transfers (verify files, record the manifest,
    /// detach from the client so a finished download holds no peers or cache), fail magnets that never resolve,
    /// and refill the queue.
    /// </summary>
    internal async Task TickAsync(CancellationToken ct = default)
    {
        var completed = new List<EngineTorrentCompletedEventArgs>();
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            var rows = await db.EngineTorrents.Where(r => r.UserId == LocalUser.Id).ToListAsync(ct);
            foreach (var row in rows)
            {
                var live = backend.Get(row.Hash);
                if (live is null) continue;
                if (live.HasMetadata)
                {
                    row.Name = live.Name;
                    if (live.SizeBytes > 0) row.SizeBytes = live.SizeBytes;
                }
                row.Progress = Math.Round(live.Progress, 4);

                if (live.State == "error")
                {
                    row.Status = EngineTorrentStatus.Error;
                    row.Error = live.Error ?? "The torrent client reported an error.";
                    row.ForcedAt = null;
                    await backend.RemoveAsync(row.Hash);
                }
                else if (!live.HasMetadata && row.Status == EngineTorrentStatus.Downloading
                    && Now - row.UpdatedAt > TimeSpan.FromSeconds(Options.MetadataTimeoutSeconds))
                {
                    row.Status = EngineTorrentStatus.Error;
                    row.Error = "Timed out waiting for torrent metadata (no peers / blocked DHT?). Try another release or check network.";
                    row.ForcedAt = null;
                    await backend.RemoveAsync(row.Hash);
                }
                else if (live.State == "complete" && live.Files.Count > 0 && live.Files.All(f => f.Selected))
                {
                    var manifest = BuildManifest(live);
                    if (manifest is not null)
                    {
                        row.VerifiedFilesJson = JsonSerializer.Serialize(manifest, JsonOptions);
                        row.VerifiedAt = Now;
                        row.Progress = 1;
                        row.Status = EngineTorrentStatus.Parked;
                        row.ForcedAt = null;
                        row.Error = null;
                        await backend.RemoveAsync(row.Hash);
                        completed.Add(new EngineTorrentCompletedEventArgs(row.Hash, row.Name, row.SavePath, row.Origin));
                    }
                }
            }
            await db.SaveChangesAsync(ct);
        }
        if (completed.Count > 0) storage.ResetDirectorySizeCache();
        foreach (var e in completed)
        {
            logger.LogInformation("Transfer {Hash} complete; parked {Name}", e.Hash, e.Name);
            try { TorrentCompleted?.Invoke(this, e); }
            catch (Exception ex) { logger.LogError(ex, "TorrentCompleted handler failed for {Hash}", e.Hash); }
        }
        // Runs every tick so free slots (after a completion, failure or a cap raise) always refill.
        await PromoteAsync(ct);
    }

    private async Task PersistSnapshotAsync(BackendSnapshot snap, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var row = await FindAsync(db, snap.Hash, ct);
        if (row is null) return;
        if (snap.HasMetadata) { row.Name = snap.Name; if (snap.SizeBytes > 0) row.SizeBytes = snap.SizeBytes; }
        row.Progress = Math.Round(snap.Progress, 4);
        await db.SaveChangesAsync(ct);
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
