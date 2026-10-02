using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine;

internal sealed partial class TorrentEngineService
{
    public async Task<EngineAddResult> SwapAsync(string hash, EngineReleaseSwap request, CancellationToken ct = default)
    {
        hash = hash.Trim().ToLowerInvariant();
        var nextHash = TorrentSource.NormalizeInfoHash(request.Hash);
        if (nextHash is null || nextHash == hash) return new(false, "Choose a different release.");
        if (TorrentSource.HashFromMagnet(request.Magnet ?? "") != nextHash)
            return new(false, "The release magnet does not match its hash.");

        var held = new List<IDisposable>();
        EngineTorrent? replacement = null;
        await _removeGate.WaitAsync(ct);
        try
        {
            // Like batch removal, multiple hash locks are ordered and protected by the remove gate.
            foreach (var key in new[] { hash, nextHash }.Order(StringComparer.Ordinal))
                held.Add(await LockHashAsync(key, ct));
            await _queueGate.WaitAsync(ct);
            try
            {
                await using var db = await dbFactory.CreateDbContextAsync(ct);
                var old = await FindAsync(db, hash, ct);
                if (old is null) return new(false, NotFound);
                var live = backend.Get(hash);
                if (old.Origin != TorrentOrigin.User || PayloadVerified(old) || live?.Progress >= .9999)
                    return new(false, "Only downloads that haven't finished can be replaced.");
                if (await db.EngineTorrents.AnyAsync(r => r.Hash == nextHash, ct))
                    return new(false, "That release is already in your downloads.");
                if (await db.ReleaseAttempts.AnyAsync(r => r.UserId == LocalUser.Id && r.WorkKey == request.WorkKey
                    && r.Scope == request.Scope && r.Hash == nextHash, ct)
                    && !(request.UseBlocked && (await ReleaseBlocks.GetAsync(db, LocalUser.Id, [nextHash], ct)).Count > 0))
                    return new(false, "That release has already been tried.");
                var config = await settings.GetConfigAsync(ct);
                var check = storage.Check(config.DownloadRoot, config.MaxStorageBytes, request.SizeBytes,
                    Queue.DownloadQueue.QueuedReservedBytes((await QueueRowsAsync(db, ct)).Where(r => r.Hash != hash)), false,
                    await StagingOutsideRootAsync(db, config, old.StagePath, ct));
                if (!check.Ok) return new(false, check.Message ?? "Storage limit") { StorageLimit = check.Limit };

                // The old release's partial files are wherever it was writing: its stage folder, or its save path (legacy).
                var oldRoot = PayloadRoot(old);
                var oldStage = StagedRoot(old);
                var files = live?.Files.Where(f => f.Progress < 1).Select(f => f.FullPath).ToList()
                    ?? IncompleteFilesFromMetadata(hash, oldRoot);
                var others = await db.EngineTorrents.AsNoTracking().Where(r => r.Hash != hash).ToListAsync(ct);
                var protectedFiles = others.SelectMany(r => (backend.Get(r.Hash)?.Files.Select(f => f.FullPath)
                    ?? VerifiedFiles(r).Select(f => f.FullPath).OfType<string>())
                    .Concat(LoadTorrentFile(r.Hash) is { } otherMeta ? FilesFromMetadata(otherMeta, PayloadRoot(r)) : [])).ToList();
                files = PartialFilesToRemove(files, oldRoot, protectedFiles).ToList();
                // The new release gets a stage folder of its own (made when it starts); nothing it writes lands in the library
                // before the gate.
                var nextStage = old.SavePath is { } finalPath ? StagePaths.For(finalPath, config, nextHash) : null;
                if (nextStage is not null && StagePaths.PrepareRoot(Path.GetDirectoryName(nextStage)!) is { } stageError) return new(false, stageError);
                replacement = new EngineTorrent
                {
                    Id = Ids.New(), UserId = old.UserId, Hash = nextHash, Name = request.Name,
                    Magnet = TorrentSource.WidenTrackers(request.Magnet!, Options.EffectivePublicTrackers),
                    SavePath = old.SavePath, StagePath = nextStage, Category = old.Category, Origin = old.Origin, WorkId = old.WorkId,
                    QueueKey = old.QueueKey, Lane = old.Lane, ForcedAt = old.ForcedAt, ForcedReason = old.ForcedReason, CreatedAt = old.CreatedAt,
                    LastUsedAt = Now, UpdatedAt = Now, SizeBytes = request.SizeBytes ?? 0,
                    Provenance = EngineProvenance.Of(request.ByHand),
                    Status = old.Status == EngineTorrentStatus.Paused ? EngineTorrentStatus.Paused : EngineTorrentStatus.Queued,
                };

                // Admission and linkage commit together. No replacement backend can write until cleanup has finished.
                await using var tx = await db.Database.BeginTransactionAsync(ct);
                db.EngineTorrents.Add(replacement);
                foreach (var tried in new[] { hash, nextHash })
                    if (!await db.ReleaseAttempts.AnyAsync(r => r.UserId == old.UserId && r.WorkKey == request.WorkKey
                        && r.Scope == request.Scope && r.Hash == tried, ct))
                        db.ReleaseAttempts.Add(new() { UserId = old.UserId, WorkKey = request.WorkKey, Scope = request.Scope, Hash = tried, TriedAt = Now });
                await BlockReplacedAsync(db, old, replacement, request, ct);
                var lifted = request.UseBlocked ? await ReleaseBlocks.UnblockAsync(db, old.UserId, nextHash, ct) : null;
                await CarrySwapLinks(db, old, replacement, request.Source, ct);
                db.EngineTorrents.Remove(old);
                await db.SaveChangesAsync(ct);
                // Stop can fail: keep the transaction uncommitted so the old transfer stays recoverable.
                if (backend.Contains(hash)) await backend.RemoveAsync(hash);
                await tx.CommitAsync(CancellationToken.None);
                if (lifted is not null)
                    logger.LogInformation("[builtin-engine] Unblocked {Hash} ({Name}): chosen by hand with Use it anyway (was {Reason})",
                        nextHash, request.Name, lifted.Reason);
                _startedAt.TryRemove(hash, out _);
                _health.Forget(hash);
                // Deliberately never use recursive folder removal here: only this release's partial files.
                var plan = new ReleaseRemovalPlan(files, null, "release swap preserves shared folders");
                for (var i = 0; i < 12; i++)
                {
                    ReleaseFileRemoval.Execute(plan);
                    if (!files.Any(File.Exists)) break;
                    await Task.Delay(250);
                }
                // A staged release owns its whole stage folder (finished files and fragments included): it goes, now or, if a
                // file is still held, through the cleanup's sweep (the old row is gone, so nothing owns the folder any more).
                if (oldStage is not null) await DeleteStageAsync(oldStage, hash);
                TryDelete(TorrentFilePath(hash));
                _layoutManifest.Forget(hash, oldRoot);
            }
            finally { _queueGate.Release(); }
        }
        finally
        {
            foreach (var item in held) item.Dispose();
            _removeGate.Release();
        }
        storage.ResetDirectorySizeCache();
        if (replacement!.ForcedAt is not null && replacement.Status != EngineTorrentStatus.Paused)
            await ForceAsync(nextHash, CancellationToken.None);
        else
            await PromoteAsync(CancellationToken.None);
        return new(true, "Using the new release. Safely identified partial files were removed.", Hash: nextHash);
    }

    private List<string> IncompleteFilesFromMetadata(string hash, string? savePath)
    {
        if (savePath is null || LoadTorrentFile(hash) is not { } bytes) return [];
        try
        {
            // Without a live bitfield a full-length file may be complete. Preserve it rather than guessing.
            return MonoTorrent.Torrent.Load(bytes).Files.Select(f => (Path: Path.Combine(savePath, f.Path), f.Length))
                .Where(f => !File.Exists(f.Path) || new FileInfo(f.Path).Length < f.Length).Select(f => f.Path).ToList();
        }
        catch (Exception error) when (error is IOException or MonoTorrent.TorrentException or FormatException) { return []; }
    }

    internal static IReadOnlyList<string> PartialFilesToRemove(IEnumerable<string> files, string? savePath, IEnumerable<string> protectedFiles)
    {
        var shared = protectedFiles.Select(Path.GetFullPath).ToHashSet(OperatingSystem.IsWindows()
            ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        return ReleaseFileRemoval.Plan(files, savePath, null, []).Files.Where(file =>
        {
            if (shared.Contains(file) || shared.Contains(file + ".part") || shared.Contains(file + ".!qB")) return false;
            // Never traverse a symlink/junction on the way to a payload.
            for (var dir = Path.GetDirectoryName(file); dir is not null; dir = Path.GetDirectoryName(dir))
                if (Directory.Exists(dir) && new DirectoryInfo(dir).Attributes.HasFlag(FileAttributes.ReparsePoint)) return false;
            return !File.Exists(file) || !File.GetAttributes(file).HasFlag(FileAttributes.ReparsePoint);
        }).ToList();
    }

    /// <summary>
    /// The owner replaced <paramref name="old"/> with <paramref name="next"/>: blocks the old release for this work and
    /// scope (<see cref="ReleaseBlocks.Replaced"/>), so no automatic pick takes it again. Its name and site come from how
    /// it was grabbed, so this runs before <see cref="CarrySwapLinks"/> moves those records to the new hash. Tracks the
    /// change; the swap's save commits it together with the replacement.
    /// </summary>
    private static async Task BlockReplacedAsync(TorrentFlowDbContext db, EngineTorrent old, EngineTorrent next, EngineReleaseSwap request, CancellationToken ct)
    {
        var grabbed = await ReleaseBlocks.GrabbedAsync(db, old.UserId, old.Hash, ct);
        await ReleaseBlocks.BlockAsync(db, new ReleaseBlock
        {
            UserId = old.UserId, Hash = old.Hash, WorkKey = request.WorkKey, Scope = request.Scope, Reason = ReleaseBlocks.Replaced,
            Title = grabbed?.Title ?? old.Name, Source = grabbed?.Source, ReplacedBy = next.Hash, Origin = ReleaseBlocks.FromSwap,
            CreatedAt = next.UpdatedAt,
        }, ct);
    }

    private static async Task CarrySwapLinks(TorrentFlowDbContext db, EngineTorrent old, EngineTorrent next, string? source, CancellationToken ct)
    {
        db.DownloadHistories.Add(new DownloadHistory { Id = Ids.New(), UserId = old.UserId, Title = next.Name,
            InfoHash = next.Hash, Magnet = next.Magnet, WorkId = next.WorkId, Status = "sent", Context = "release-swap",
            Retention = "keep", ClientType = "builtin", SendKind = "magnet", Source = source, Message = "Replaced " + old.Hash, CreatedAt = next.UpdatedAt });
        foreach (var job in await db.GrabJobs.Where(r => r.UserId == old.UserId && r.InfoHash == old.Hash).ToListAsync(ct))
        {
            job.InfoHash = next.Hash; job.Magnet = next.Magnet; job.Title = next.Name; job.Source = source; job.UpdatedAt = next.UpdatedAt;
        }
        foreach (var target in await db.AcquisitionTargets.Where(r => r.UserId == old.UserId && r.InfoHash == old.Hash).ToListAsync(ct))
        {
            target.InfoHash = next.Hash; target.Progress = 0; target.FilePath = null; target.Status = "queued"; target.UpdatedAt = next.UpdatedAt;
        }
        foreach (var watch in await db.WatchListItems.Where(r => r.UserId == old.UserId && r.LatestReleaseMagnet != null).ToListAsync(ct))
            if (TorrentSource.HashFromMagnet(watch.LatestReleaseMagnet!) == old.Hash)
            {
                watch.LatestReleaseMagnet = next.Magnet; watch.LatestReleaseTitle = next.Name; watch.UpdatedAt = next.UpdatedAt;
            }
        foreach (var request in await db.MediaRequests.Where(r => r.GrabbedHashes != null).ToListAsync(ct))
        {
            var hashes = request.GrabbedHashes!.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (!hashes.Contains(old.Hash, StringComparer.OrdinalIgnoreCase)) continue;
            request.GrabbedHashes = string.Join(',', hashes.Select(h => h.Equals(old.Hash, StringComparison.OrdinalIgnoreCase) ? next.Hash : h));
            request.UpdatedAt = next.UpdatedAt;
        }
    }
}
