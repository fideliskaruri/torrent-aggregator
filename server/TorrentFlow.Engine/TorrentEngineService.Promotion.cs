using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Layout;
using TorrentFlow.Engine.Queue;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine;

/// <summary>
/// Promotion (docs/english-gates-plan.md section 1). A finished payload waits in its stage folder as Completed. The gate
/// (<see cref="IPromotionGate"/>) decides, with Checking saved first so a restart asks again; then the kept files are
/// promoted into the library through the completed layout (validate, lay out, move from the stage folder to the final
/// path), held in the stage folder for the owner (Keep or Find another), or rejected (stage files deleted, release blocked,
/// its wanted items handed back so the finder picks again). Every move is a rename that never copies
/// (<see cref="NoCopyMove"/>), so a library on another drive is held for the owner, never copied. Nothing counts as
/// promoted, and the stage folder never goes, until every kept file is in the final path at its recorded size. Only a
/// promoted row counts as downloaded (<see cref="EngineTorrent.IsDownloaded"/>), and the completion is announced then. A
/// promotion that fails is tried again with backoff and held for the owner after five failures, so none is stranded.
/// </summary>
internal sealed partial class TorrentEngineService
{
    internal const string GateFailedReason = "TorrentFlow couldn't check this download";
    internal const string NotHeldMessage = "This download isn't waiting for you.";
    internal const string FindAnotherReason = "You chose to find another release";
    internal const string OtherDriveReason = "The library folder is on another drive. Move the files yourself, or change the download folder";
    internal const string MoveFailedReason = "TorrentFlow couldn't move the files into the library folder";
    internal const string NotInLibraryReason = "TorrentFlow couldn't confirm every file reached the library folder";
    internal const string StillFinishingMessage = "TorrentFlow is still finishing this download. Try again in a moment.";
    private const string KeepFailedMessage = "TorrentFlow couldn't move it into your library. Try again in a moment.";

    private const int MaxFinishAttempts = 5;
    private static readonly TimeSpan FirstFinishRetry = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan LastFinishRetry = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan PromotionScanInterval = TimeSpan.FromSeconds(30);

    // One promotion per transfer at a time: the tick, a retry and the owner's Keep never promote the same files twice.
    private readonly ConcurrentDictionary<string, byte> _finishing = new(StringComparer.Ordinal);
    // Promotions that failed: how many tries each has had, and when it may be tried again.
    private readonly ConcurrentDictionary<string, (int Attempts, DateTime NextAt)> _finishRetries = new(StringComparer.Ordinal);
    private DateTime _nextPromotionScan = DateTime.MinValue;

    private IPromotionGate Gate => gate ?? PromoteEverythingGate.Instance;
    private IPromotionTestHooks Hooks => hooks ?? NoPromotionTestHooks.Instance;

    /// <summary>
    /// Runs every tick, even while nothing downloads: promotions due a retry, and (at startup, then every 30 seconds) any
    /// row a restart, a failure or a cut-short tick left in Completed or Checking. Never throws.
    /// </summary>
    private async Task RetryPromotionsAsync()
    {
        try
        {
            var now = Now;
            var due = _finishRetries.Where(p => p.Value.NextAt <= now).Select(p => p.Key).ToList();
            if (now >= _nextPromotionScan)
            {
                var startup = _nextPromotionScan == DateTime.MinValue;
                _nextPromotionScan = now + PromotionScanInterval;
                List<string> waiting;
                await using (var db = await dbFactory.CreateDbContextAsync())
                    waiting = await db.EngineTorrents.AsNoTracking()
                        .Where(r => r.UserId == LocalUser.Id && r.Status == EngineTorrentStatus.Parked && r.VerifiedAt != null
                            && (r.Promotion == EnginePromotion.Completed || r.Promotion == EnginePromotion.Checking))
                        .OrderBy(r => r.VerifiedAt).Select(r => r.Hash).ToListAsync();
                var stranded = waiting.Where(h => !_finishing.ContainsKey(h) && !_finishRetries.ContainsKey(h) && !backend.Contains(h)).ToList();
                if (stranded.Count > 0 && startup)
                    logger.LogInformation("[promotion] resuming {Count} finished downloads that had not reached the library", stranded.Count);
                else if (stranded.Count > 0)
                    logger.LogInformation("[promotion] picking up {Count} finished downloads left short of the library", stranded.Count);
                due.AddRange(stranded);
            }
            foreach (var hash in due.Distinct(StringComparer.Ordinal)) await TryFinishAsync(hash);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "[promotion] looking for promotions to retry failed");
        }
    }

    /// <summary>
    /// <see cref="FinishAsync"/> that never throws: a failure (a busy database, a file race) is tried again with backoff, and
    /// after five the row is held for the owner with <see cref="GateFailedReason"/>, so nothing stays on Moving to library.
    /// </summary>
    private async Task<string?> TryFinishAsync(string hash)
    {
        try
        {
            var state = await FinishAsync(hash);
            _finishRetries.TryRemove(hash, out _);
            return state;
        }
        catch (Exception ex)
        {
            var attempts = (_finishRetries.TryGetValue(hash, out var retry) ? retry.Attempts : 0) + 1;
            if (attempts >= MaxFinishAttempts && await TryHoldAsync(hash, GateFailedReason))
            {
                _finishRetries.TryRemove(hash, out _);
                logger.LogError(ex, "[promotion] finishing {Hash} failed {Attempts} times; holding it for the owner", hash, attempts);
                return EnginePromotion.Held;
            }
            var delay = TimeSpan.FromTicks(Math.Min(LastFinishRetry.Ticks, FirstFinishRetry.Ticks << Math.Min(attempts - 1, 16)));
            _finishRetries[hash] = (attempts, Now + delay);
            logger.LogWarning(ex, "[promotion] finishing {Hash} failed (attempt {Attempt}); trying again in {Delay}", hash, attempts, delay);
            return null;
        }
    }

    /// <summary>Holds a finished row for the owner with <paramref name="reason"/>. Never throws; false when it couldn't.</summary>
    private async Task<bool> TryHoldAsync(string hash, string reason)
    {
        try
        {
            using (await LockHashAsync(hash, CancellationToken.None))
            {
                await using var db = await dbFactory.CreateDbContextAsync();
                var row = await FindAsync(db, hash, CancellationToken.None);
                if (row is null || row.Status != EngineTorrentStatus.Parked
                    || row.Promotion is not (EnginePromotion.Completed or EnginePromotion.Checking or EnginePromotion.Held)) return false;
                row.Promotion = EnginePromotion.Held;
                row.PromotionReason = reason;
                row.UpdatedAt = Now;
                await db.SaveChangesAsync();
                return true;
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "[promotion] holding {Hash} for the owner failed", hash);
            return false;
        }
    }

    /// <summary>
    /// Runs the gate for a finished, detached transfer and acts on its decision. <paramref name="keep"/> is the owner's Keep
    /// on a held row: promoted without asking the gate again. Returns the promotion state it ended in; null when there was
    /// nothing to do (gone, still loaded, or already being promoted). Throws on a failure the caller retries
    /// (<see cref="TryFinishAsync"/>) or reports (<see cref="KeepAsync"/>).
    /// </summary>
    private async Task<string?> FinishAsync(string hash, bool keep = false)
    {
        if (!_finishing.TryAdd(hash, 0)) return null;
        try
        {
            PromotionCandidate candidate;
            using (await LockHashAsync(hash, CancellationToken.None))
            {
                await using var db = await dbFactory.CreateDbContextAsync();
                var row = await FindAsync(db, hash, CancellationToken.None);
                if (row is null || row.Status != EngineTorrentStatus.Parked || !PayloadVerified(row) || backend.Contains(hash)) return null;
                if (row.Promotion == EnginePromotion.Promoted)
                {
                    // In the library already (parked before staging, and its detach failed then): only the layout is left.
                    await FinalizeLayoutLockedAsync(hash, validate: true);
                    return EnginePromotion.Promoted;
                }
                if (!(row.Promotion is EnginePromotion.Completed or EnginePromotion.Checking || keep && row.Promotion == EnginePromotion.Held))
                    return null;
                // Saved before the gate runs: a restart from here asks the gate again.
                row.Promotion = EnginePromotion.Checking;
                row.UpdatedAt = Now;
                if (StagedRoot(row) is { } stage) Reconcile(row, stage);
                await db.SaveChangesAsync();
                candidate = CandidateOf(row);
            }

            PromotionDecision decision;
            if (keep) decision = PromotionDecision.Promote;
            else
            {
                try { decision = await Gate.DecideAsync(candidate, CancellationToken.None); }
                catch (Exception ex)
                {
                    // Never stuck and never fatal: a gate that throws or gives up (OperationCanceledException included)
                    // leaves the decision to the owner.
                    logger.LogWarning(ex, "[promotion] the gate failed for {Hash}; holding it for the owner", hash);
                    decision = PromotionDecision.Hold(GateFailedReason);
                }
            }
            logger.LogInformation("[promotion] {Hash} ({Name}), {Provenance} pick, {Files} file(s): {Outcome}{Reason}", hash, candidate.Name,
                candidate.Provenance, candidate.Files.Count, keep ? "kept by the owner" : decision.Outcome,
                decision.Reason is null ? "" : $" ({decision.Reason})");

            string? state;
            EngineTorrentCompletedEventArgs? done = null;
            EngineTorrentFailedEventArgs? failed = null;
            using (await LockHashAsync(hash, CancellationToken.None))
            {
                await using var db = await dbFactory.CreateDbContextAsync();
                var row = await FindAsync(db, hash, CancellationToken.None);
                // Deleted (or retried) while the gate ran: nothing left to promote.
                if (row is null || row.Status != EngineTorrentStatus.Parked || row.Promotion != EnginePromotion.Checking) return null;
                Hooks.Fail(hash, "finish");
                switch (decision.Outcome)
                {
                    case PromotionDecision.HoldOutcome:
                        (state, _, _) = await HoldLockedAsync(db, row, decision.Reason ?? GateFailedReason);
                        break;
                    case PromotionDecision.RejectOutcome:
                        await RejectLockedAsync(db, row, decision.Reason ?? "Not used", decision.Code, byOwner: false);
                        failed = new(row.Hash, row.Name, row.Origin);
                        state = EnginePromotion.Rejected;
                        break;
                    default:
                        (state, done, failed) = await PromoteLockedAsync(db, row);
                        break;
                }
            }
            if (failed is not null) RaiseFailed(failed);
            if (done is not null)
            {
                logger.LogInformation("Transfer {Hash} complete; promoted {Name} into {Path}", done.Hash, done.Name, done.SavePath);
                try { TorrentCompleted?.Invoke(this, done); }
                catch (Exception ex) { logger.LogError(ex, "TorrentCompleted handler failed for {Hash}", done.Hash); }
            }
            return state;
        }
        finally
        {
            _finishing.TryRemove(hash, out _);
        }
    }

    /// <summary>The stage folder a row's payload sits in until promotion; null for a row that writes in place (legacy, imports).</summary>
    private static string? StagedRoot(EngineTorrent row) =>
        row.StagePath is { Length: > 0 } stage && StagePaths.IsStage(stage) && row.Promotion != EnginePromotion.Promoted ? stage : null;

    /// <summary>
    /// A row still needs its stage folder: it writes there, or its files wait there (Completed, Checking, Held, or an error
    /// row whose files stay until it is removed). Promoted and rejected rows don't; the cleanup's sweep removes theirs.
    /// </summary>
    internal static bool OwnsStage(EngineTorrent row, string folder) =>
        row.StagePath is { } stage && SamePath(stage, folder)
        && !(row.Promotion == EnginePromotion.Promoted
            || row.Promotion == EnginePromotion.Rejected && row.Status == EngineTorrentStatus.Error);

    private static bool SamePath(string a, string b) =>
        string.Equals(Path.GetFullPath(a).TrimEnd(Path.DirectorySeparatorChar), Path.GetFullPath(b).TrimEnd(Path.DirectorySeparatorChar),
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private PromotionCandidate CandidateOf(EngineTorrent row) => new(row.Hash, row.Name, row.WorkId, row.QueueKey, row.Provenance,
        PayloadRoot(row), row.SavePath ?? PayloadRoot(row),
        VerifiedFiles(row).Where(f => f.FullPath is not null).Select(f => new PromotionFile(f.Path, f.FullPath!, f.Size)).ToList(),
        row.LanguageCheckJson);

    /// <summary>
    /// Promotes a checked row. Only ever by renaming: a stage on another drive than the final path is held for the owner
    /// before anything moves, and a move that would cross drives anyway moves nothing and holds it too. The completed
    /// layout validates and moves the files (as they are, with <paramref name="asIs"/>); whatever it leaves in the stage
    /// follows as it is. Then every kept file must be in the final path at its recorded size, or the row is held and the
    /// stage folder stays. Only then is it Promoted, remembered for a re-add, and its stage folder removed. Caller holds
    /// the hash lock.
    /// </summary>
    private async Task<(string? State, EngineTorrentCompletedEventArgs? Done, EngineTorrentFailedEventArgs? Failed)> PromoteLockedAsync(
        TorrentFlowDbContext db, EngineTorrent row, bool asIs = false)
    {
        var stage = StagedRoot(row);
        if (stage is not null && row.SavePath is { } final && StagePaths.SameDevice(stage, final) == false)
            return await HoldLockedAsync(db, row, OtherDriveReason);
        if (!asIs && layout is not null)
        {
            var live = backend.List().Where(s => !string.Equals(s.Hash, row.Hash, StringComparison.OrdinalIgnoreCase))
                .SelectMany(s => s.Files.Select(f => (s.Hash, f.FullPath))).ToList();
            LayoutResult result;
            try
            {
                result = await layout.FinalizeDetailedAsync(db, row, validate: true, CancellationToken.None, live, sourceRoot: stage,
                    checkpoint: point => Hooks.Checkpoint(row.Hash, point));
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "[content-layout] rewrite failed for {Hash}", row.Hash);
                result = LayoutResult.Unchanged;
            }
            // Not a real video, or not readable: the check made it an error row. Its files stay staged until it is removed.
            if (result.Outcome is LayoutOutcome.Invalid or LayoutOutcome.Unchecked) return (null, null, new(row.Hash, row.Name, row.Origin));
            if (result.CrossDevice) return await HoldLockedAsync(db, row, OtherDriveReason);
        }
        if (stage is not null && await MoveAsIsAsync(db, row, stage) is { } why) return await HoldLockedAsync(db, row, why);
        if (NotInLibrary(row, stage) is { } missing)
        {
            logger.LogWarning("[promotion] {Hash} ({Name}) is not all in the library folder ({Missing}); keeping its stage folder", row.Hash, row.Name, missing);
            return await HoldLockedAsync(db, row, NotInLibraryReason);
        }
        row.Promotion = EnginePromotion.Promoted;
        row.PromotionReason = null;
        row.UpdatedAt = Now;
        await db.SaveChangesAsync();
        // Added again later (after "Remove, keep files"), this release is re-checked where its files are, never downloaded twice.
        _layoutManifest.Remember(row.Hash, row.SavePath, VerifiedFiles(row).Select(f => f.FullPath).ToList());
        if (stage is not null) await DeleteStageAsync(stage, row.Hash);
        storage.ResetDirectorySizeCache();
        return (EnginePromotion.Promoted, new EngineTorrentCompletedEventArgs(row.Hash, row.Name, row.SavePath, row.Origin), null);
    }

    private async Task<(string? State, EngineTorrentCompletedEventArgs? Done, EngineTorrentFailedEventArgs? Failed)> HoldLockedAsync(
        TorrentFlowDbContext db, EngineTorrent row, string reason)
    {
        row.Promotion = EnginePromotion.Held;
        row.PromotionReason = reason;
        row.UpdatedAt = Now;
        await db.SaveChangesAsync();
        logger.LogWarning("[promotion] holding {Hash} ({Name}) for the owner: {Reason}", row.Hash, row.Name, reason);
        return (EnginePromotion.Held, null, null);
    }

    /// <summary>
    /// Why the row can't count as promoted: a kept file still in the stage folder, outside the final path, missing, or not
    /// its recorded size. Null when every kept file is in the final path whole.
    /// </summary>
    private static string? NotInLibrary(EngineTorrent row, string? stage)
    {
        if (string.IsNullOrWhiteSpace(row.SavePath)) return "no library folder";
        var dest = Path.GetFullPath(row.SavePath);
        var kept = VerifiedFiles(row).Where(f => f.FullPath is not null).ToList();
        if (kept.Count == 0) return "no kept files";
        foreach (var f in kept)
        {
            var full = Path.GetFullPath(f.FullPath!);
            if (stage is not null && ContentLayoutPolicy.IsInside(stage, full)) return $"{f.Path} is still in the stage folder";
            if (!ContentLayoutPolicy.IsInside(dest, full)) return $"{f.Path} is outside the library folder";
            if (!Whole(full, f.Size)) return $"{f.Path} is missing or not {f.Size} bytes";
        }
        return null;
    }

    private static bool Whole(string path, long size)
    {
        try
        {
            var info = new FileInfo(path);
            return info.Exists && info.Length == size;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return false;
        }
    }

    /// <summary>
    /// Moves whatever kept files are still in the stage folder into the final path at their place in the torrent, all or
    /// nothing, and only by renaming. The manifest records the targets before anything moves, so a restart in between finds
    /// each file at one end (<see cref="Reconcile"/>). Returns why it could not, or null when nothing is left in the stage.
    /// </summary>
    private async Task<string?> MoveAsIsAsync(TorrentFlowDbContext db, EngineTorrent row, string stage)
    {
        var dest = Path.GetFullPath(row.SavePath ?? PayloadRoot(row));
        var root = Path.GetFullPath(stage);
        var manifest = VerifiedFiles(row);
        var moves = new List<(int Index, string From, string To)>();
        for (var i = 0; i < manifest.Count; i++)
        {
            if (manifest[i].FullPath is not { } full || !ContentLayoutPolicy.IsInside(root, Path.GetFullPath(full))) continue;
            var to = Path.Combine(dest, Path.GetRelativePath(root, Path.GetFullPath(full)));
            if (File.Exists(to) || Directory.Exists(to))
                return $"A file named {Path.GetFileName(to)} is already in the library folder. Remove that file, or find another release";
            moves.Add((i, Path.GetFullPath(full), to));
        }
        if (moves.Count == 0) return null;
        var before = row.VerifiedFilesJson;
        foreach (var (index, _, to) in moves) manifest[index] = manifest[index] with { FullPath = to };
        row.VerifiedFilesJson = JsonSerializer.Serialize(manifest, JsonOptions);
        row.UpdatedAt = Now;
        await db.SaveChangesAsync();
        var done = new Stack<(string From, string To)>();
        try
        {
            foreach (var (_, from, to) in moves)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(to)!);
                NoCopyMove.Move(from, to);
                done.Push((from, to));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            while (done.TryPop(out var undo))
            {
                try { NoCopyMove.Move(undo.To, undo.From); }
                catch (Exception back) when (back is IOException or UnauthorizedAccessException) { }
            }
            row.VerifiedFilesJson = before;
            await db.SaveChangesAsync();
            logger.LogWarning(ex, "[promotion] moving {Hash} into {Dest} failed; nothing moved", row.Hash, dest);
            return ex is CrossDeviceMoveException ? OtherDriveReason : MoveFailedReason;
        }
        logger.LogInformation("[promotion] moved {Count} file(s) of {Hash} into {Dest} as they were", moves.Count, row.Hash, dest);
        return null;
    }

    /// <summary>
    /// A restart in the middle of a promotion can leave the manifest a step ahead of the files: the layout and the as-is move
    /// record their targets before anything moves, and the layout renames each file aside (<c>*.tflayout</c>) before it
    /// lands. Every move is a rename, so each kept file is whole at exactly one place. Points each entry at it: still at its
    /// place in the stage folder (a file renamed aside is renamed back first), else its recorded target when that holds its
    /// full size. A file found nowhere is left as recorded, and the promotion holds the row rather than count it.
    /// </summary>
    private void Reconcile(EngineTorrent row, string stage)
    {
        var manifest = VerifiedFiles(row);
        var changed = false;
        for (var i = 0; i < manifest.Count; i++)
        {
            var f = manifest[i];
            if (f.FullPath is null) continue;
            var relative = f.Path.Replace('/', Path.DirectorySeparatorChar);
            string? found = null;
            foreach (var native in new[] { Path.Combine(stage, row.Name, relative), Path.Combine(stage, relative) })
            {
                if (Whole(native, f.Size)) { found = native; break; }
                var aside = native + CompletedLayoutFinalizer.StageSuffix;
                if (!Whole(aside, f.Size)) continue;
                try
                {
                    NoCopyMove.Move(aside, native);
                    logger.LogInformation("[promotion] {Hash}: renamed {File} back from an interrupted layout", row.Hash, Path.GetFileName(native));
                    found = native;
                    break;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    logger.LogWarning(ex, "[promotion] {Hash}: could not rename {File} back", row.Hash, aside);
                }
            }
            found ??= Whole(f.FullPath, f.Size) ? f.FullPath : null;
            if (found is null || SamePath(found, f.FullPath)) continue;
            manifest[i] = f with { FullPath = Path.GetFullPath(found) };
            changed = true;
        }
        if (!changed) return;
        row.VerifiedFilesJson = JsonSerializer.Serialize(manifest, JsonOptions);
        logger.LogInformation("[promotion] {Hash}: found the files an interrupted promotion left behind", row.Hash);
    }

    /// <summary>Removes a stage folder now when it can; otherwise the cleanup worker's sweep keeps trying, across restarts.</summary>
    private async Task DeleteStageAsync(string stage, string hash)
    {
        if (await StagePaths.DeleteAsync(stage)) return;
        logger.LogWarning("[promotion] could not remove the stage folder {Stage} of {Hash} yet; the cleanup will try again", stage, hash);
        SignalCleanup();
    }

    /// <summary>
    /// Turns a finished transfer down before it reaches the library: the row becomes an error that says why, its files go
    /// (the stage folder, any a promotion had already moved into the library; a legacy row's own files), the release is
    /// blocked and its wanted items are handed back, so the finder picks another release (the path a failed English check
    /// takes). Caller holds the hash lock.
    /// </summary>
    private async Task RejectLockedAsync(TorrentFlowDbContext db, EngineTorrent row, string reason, string? code, bool byOwner)
    {
        var message = byOwner
            ? "You chose to find another release. TorrentFlow removed this one's files and is looking for another."
            : $"{reason}. TorrentFlow removed its files and will look for another release.";
        var stage = StagedRoot(row);
        var files = VerifiedFiles(row).Select(f => f.FullPath).OfType<string>()
            .Where(f => stage is null || !ContentLayoutPolicy.IsInside(stage, f)).ToList();
        row.Status = EngineTorrentStatus.Error;
        row.Error = message;
        row.Promotion = EnginePromotion.Rejected;
        row.PromotionReason = reason;
        row.VerifiedAt = null;
        row.VerifiedBitfield = null;
        row.Progress = 0;
        row.ClearForced();
        row.UpdatedAt = Now;
        await CompletedLayoutFinalizer.BlockFailedCheckAsync(db, row, Now, CancellationToken.None, code ?? ReleaseBlocks.Rejected, ReleaseBlocks.FromPromotion);
        await CompletedLayoutFinalizer.ReleaseTargetsAsync(db, row.Hash, message, Now, CancellationToken.None);
        await db.SaveChangesAsync();
        if (files.Count > 0) DeleteReleaseFiles(files, row.SavePath);
        if (stage is not null) await DeleteStageAsync(stage, row.Hash);
        storage.ResetDirectorySizeCache();
        logger.LogWarning("[promotion] rejected {Hash} ({Name}): {Reason}; files removed, release blocked, looking for another", row.Hash, row.Name, reason);
    }

    /// <summary>
    /// "Remove, keep files" on a finished download that hasn't reached the library (Completed, Checking or Held): its kept
    /// files are promoted as they are, by renaming, before the row goes, so keeping them never means losing them. Returns
    /// why it couldn't (the row stays, held with that reason), or null. Caller holds the hash lock.
    /// </summary>
    private async Task<string?> KeepFilesLockedAsync(TorrentFlowDbContext db, EngineTorrent row)
    {
        if (backend.Contains(row.Hash) || _finishing.ContainsKey(row.Hash)) return StillFinishingMessage;
        Reconcile(row, StagedRoot(row)!);
        var (state, _, _) = await PromoteLockedAsync(db, row, asIs: true);
        if (state == EnginePromotion.Promoted)
        {
            logger.LogInformation("[promotion] {Hash} ({Name}) removed with its files kept: moved into {Path} as they were", row.Hash, row.Name, row.SavePath);
            return null;
        }
        return $"{row.PromotionReason ?? MoveFailedReason}. Nothing was removed.";
    }

    public async Task<EngineActionResult> KeepAsync(string infoHash, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        string reason;
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            var row = await FindAsync(db, hash, ct);
            if (row is null) return new EngineActionResult(false, NotFound);
            if (row.Promotion != EnginePromotion.Held) return new EngineActionResult(false, NotHeldMessage);
            reason = row.PromotionReason ?? GateFailedReason;
        }
        string? state;
        try { state = await FinishAsync(hash, keep: true); }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "[promotion] keeping {Hash} failed", hash);
            // Back to waiting for the owner with its reason, so Keep can be pressed again.
            await TryHoldAsync(hash, reason);
            return new EngineActionResult(false, KeepFailedMessage);
        }
        if (state == EnginePromotion.Promoted) return new EngineActionResult(true, "Moved into your library.");
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(CancellationToken.None);
            var row = await FindAsync(db, hash, CancellationToken.None);
            return new EngineActionResult(false, row?.Promotion == EnginePromotion.Held && row.PromotionReason is { } why ? $"{why}." : KeepFailedMessage);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new EngineActionResult(false, KeepFailedMessage);
        }
    }

    public async Task<EngineActionResult> FindAnotherAsync(string infoHash, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        try
        {
            using (await LockHashAsync(hash, ct))
            {
                await using var db = await dbFactory.CreateDbContextAsync(ct);
                var row = await FindAsync(db, hash, ct);
                if (row is null) return new EngineActionResult(false, NotFound);
                if (row.Promotion != EnginePromotion.Held || _finishing.ContainsKey(hash)) return new EngineActionResult(false, NotHeldMessage);
                await RejectLockedAsync(db, row, FindAnotherReason, null, byOwner: true);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogWarning(ex, "[promotion] finding another release for {Hash} failed", hash);
            return new EngineActionResult(false, "TorrentFlow couldn't drop this release. Try again in a moment.");
        }
        return new EngineActionResult(true, "Looking for another release.");
    }
}
