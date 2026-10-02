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
/// path, drop the stage folder), held in the stage folder for the owner (Keep or Find another), or rejected (stage files
/// deleted, release blocked, its wanted items handed back so the finder picks again). Only a promoted row counts as
/// downloaded (<see cref="EngineTorrent.IsDownloaded"/>), and the completion is announced then.
/// </summary>
internal sealed partial class TorrentEngineService
{
    internal const string GateFailedReason = "TorrentFlow couldn't check this download";
    internal const string NotHeldMessage = "This download isn't waiting for you.";
    internal const string FindAnotherReason = "You chose to find another release";

    // One promotion per transfer at a time: the tick and the startup resume never promote the same files twice.
    private readonly ConcurrentDictionary<string, byte> _finishing = new(StringComparer.Ordinal);

    private IPromotionGate Gate => gate ?? PromoteEverythingGate.Instance;

    /// <summary>Startup: transfers stopped in Completed or Checking go through the gate again, once each.</summary>
    private async Task ResumePromotionsAsync(CancellationToken ct)
    {
        List<string> hashes;
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
            hashes = await db.EngineTorrents.AsNoTracking()
                .Where(r => r.UserId == LocalUser.Id && r.Status == EngineTorrentStatus.Parked && r.VerifiedAt != null
                    && (r.Promotion == EnginePromotion.Completed || r.Promotion == EnginePromotion.Checking))
                .OrderBy(r => r.VerifiedAt).Select(r => r.Hash).ToListAsync(ct);
        if (hashes.Count == 0) return;
        logger.LogInformation("[promotion] resuming {Count} finished downloads that had not reached the library", hashes.Count);
        foreach (var hash in hashes)
        {
            try { await FinishAsync(hash); }
            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogError(ex, "[promotion] resuming {Hash} failed", hash); }
        }
    }

    /// <summary>
    /// Runs the gate for a finished, detached transfer and acts on its decision. <paramref name="keep"/> is the owner's Keep
    /// on a held row: promoted without asking the gate again. Returns the promotion state it ended in; null when there was
    /// nothing to do (gone, still loaded, or already being promoted).
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
                if (StagedRoot(row) is { } stage) ReconcileStaged(row, stage);
                await db.SaveChangesAsync();
                candidate = CandidateOf(row);
            }

            PromotionDecision decision;
            if (keep) decision = PromotionDecision.Promote;
            else
            {
                try { decision = await Gate.DecideAsync(candidate, CancellationToken.None); }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // Never stuck: a gate that fails leaves the decision to the owner.
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
                switch (decision.Outcome)
                {
                    case PromotionDecision.HoldOutcome:
                        row.Promotion = EnginePromotion.Held;
                        row.PromotionReason = decision.Reason ?? GateFailedReason;
                        row.UpdatedAt = Now;
                        await db.SaveChangesAsync();
                        state = EnginePromotion.Held;
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

    private PromotionCandidate CandidateOf(EngineTorrent row) => new(row.Hash, row.Name, row.WorkId, row.QueueKey, row.Provenance,
        PayloadRoot(row), row.SavePath ?? PayloadRoot(row),
        VerifiedFiles(row).Where(f => f.FullPath is not null).Select(f => new PromotionFile(f.Path, f.FullPath!, f.Size)).ToList(),
        row.LanguageCheckJson);

    /// <summary>
    /// Promotes a checked row: the completed layout validates the files and moves them from the stage folder into the final
    /// path (a legacy row is laid out where it is), then the stage folder goes. A layout that keeps the files where they are
    /// (a name clash, a name Windows can't hold) still moves them, as they are; only a file already at the target holds it.
    /// Caller holds the hash lock.
    /// </summary>
    private async Task<(string? State, EngineTorrentCompletedEventArgs? Done, EngineTorrentFailedEventArgs? Failed)> PromoteLockedAsync(
        TorrentFlowDbContext db, EngineTorrent row)
    {
        var stage = StagedRoot(row);
        if (layout is not null)
        {
            var live = backend.List().Where(s => !string.Equals(s.Hash, row.Hash, StringComparison.OrdinalIgnoreCase))
                .SelectMany(s => s.Files.Select(f => (s.Hash, f.FullPath))).ToList();
            LayoutResult result;
            try { result = await layout.FinalizeDetailedAsync(db, row, validate: true, CancellationToken.None, live, sourceRoot: stage); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "[content-layout] rewrite failed for {Hash}", row.Hash);
                result = LayoutResult.Unchanged;
            }
            // Not a real video, or not readable: the check made it an error row. Its files stay staged until it is removed.
            if (result.Outcome is LayoutOutcome.Invalid or LayoutOutcome.Unchecked) return (null, null, new(row.Hash, row.Name, row.Origin));
            if (result.Outcome == LayoutOutcome.LaidOut)
                _layoutManifest.Remember(row.Hash, row.SavePath, VerifiedFiles(row).Select(f => f.FullPath).ToList());
        }
        if (stage is not null && MoveAsIs(row, stage) is { } clash)
        {
            row.Promotion = EnginePromotion.Held;
            row.PromotionReason = clash;
            row.UpdatedAt = Now;
            await db.SaveChangesAsync();
            logger.LogWarning("[promotion] holding {Hash} ({Name}): {Reason}", row.Hash, row.Name, clash);
            return (EnginePromotion.Held, null, null);
        }
        row.Promotion = EnginePromotion.Promoted;
        row.PromotionReason = null;
        row.UpdatedAt = Now;
        await db.SaveChangesAsync();
        if (stage is not null && !await StagePaths.DeleteAsync(stage))
            logger.LogWarning("[promotion] could not remove the stage folder {Stage} of {Hash} yet", stage, row.Hash);
        storage.ResetDirectorySizeCache();
        return (EnginePromotion.Promoted, new EngineTorrentCompletedEventArgs(row.Hash, row.Name, row.SavePath, row.Origin), null);
    }

    /// <summary>
    /// Moves whatever kept files are still in the stage folder into the final path at their place in the torrent, all or
    /// nothing, and points the manifest at them (the caller saves). Returns why it could not, or null when nothing is left
    /// in the stage folder.
    /// </summary>
    private string? MoveAsIs(EngineTorrent row, string stage)
    {
        var dest = Path.GetFullPath(row.SavePath ?? PayloadRoot(row));
        var root = Path.GetFullPath(stage);
        var manifest = VerifiedFiles(row);
        var moves = new List<(int Index, string From, string To)>();
        for (var i = 0; i < manifest.Count; i++)
        {
            if (manifest[i].FullPath is not { } full || !ContentLayoutPolicy.IsInside(root, Path.GetFullPath(full))) continue;
            var to = Path.Combine(dest, Path.GetRelativePath(root, Path.GetFullPath(full)));
            if (File.Exists(to) || Directory.Exists(to)) return $"A file named {Path.GetFileName(to)} is already in the library folder";
            moves.Add((i, full, to));
        }
        if (moves.Count == 0) return null;
        var done = new Stack<(string From, string To)>();
        try
        {
            foreach (var (_, from, to) in moves)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(to)!);
                File.Move(from, to);
                done.Push((from, to));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            while (done.TryPop(out var undo))
            {
                try { File.Move(undo.To, undo.From); }
                catch (Exception back) when (back is IOException or UnauthorizedAccessException) { }
            }
            logger.LogWarning(ex, "[promotion] moving {Hash} into {Dest} failed", row.Hash, dest);
            return "TorrentFlow couldn't move the files into the library folder";
        }
        foreach (var (index, _, to) in moves) manifest[index] = manifest[index] with { FullPath = to };
        row.VerifiedFilesJson = JsonSerializer.Serialize(manifest, JsonOptions);
        logger.LogInformation("[promotion] moved {Count} file(s) of {Hash} into {Dest} as they were", moves.Count, row.Hash, dest);
        return null;
    }

    /// <summary>
    /// A restart in the middle of a promotion can leave the manifest a step ahead of or behind the files (the layout records
    /// its targets before it moves). Points each kept file whose recorded path is gone at where it really is: its place in
    /// the stage folder, or its place in the final path.
    /// </summary>
    private static void ReconcileStaged(EngineTorrent row, string stage)
    {
        var manifest = VerifiedFiles(row);
        var changed = false;
        for (var i = 0; i < manifest.Count; i++)
        {
            var f = manifest[i];
            if (f.FullPath is null || File.Exists(f.FullPath)) continue;
            var relative = f.Path.Replace('/', Path.DirectorySeparatorChar);
            var found = new[]
                {
                    Path.Combine(stage, relative), Path.Combine(stage, row.Name, relative),
                    row.SavePath is { } save ? Path.Combine(save, relative) : null,
                }
                .OfType<string>().FirstOrDefault(p => File.Exists(p) && new FileInfo(p).Length == f.Size);
            if (found is null) continue;
            manifest[i] = f with { FullPath = Path.GetFullPath(found) };
            changed = true;
        }
        if (changed) row.VerifiedFilesJson = JsonSerializer.Serialize(manifest, JsonOptions);
    }

    /// <summary>
    /// Turns a finished transfer down before it reaches the library: the row becomes an error that says why, its files go
    /// (the stage folder; a legacy row's own files), the release is blocked and its wanted items are handed back, so the
    /// finder picks another release (the path a failed English check takes). Caller holds the hash lock.
    /// </summary>
    private async Task RejectLockedAsync(TorrentFlowDbContext db, EngineTorrent row, string reason, string? code, bool byOwner)
    {
        var message = byOwner
            ? "You chose to find another release. TorrentFlow removed this one's files and is looking for another."
            : $"{reason}. TorrentFlow removed its files and will look for another release.";
        var stage = StagedRoot(row);
        var files = VerifiedFiles(row).Select(f => f.FullPath).OfType<string>().ToList();
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
        if (stage is not null)
        {
            if (!await StagePaths.DeleteAsync(stage)) logger.LogWarning("[promotion] could not remove the stage folder {Stage} of {Hash} yet", stage, row.Hash);
        }
        else DeleteReleaseFiles(files, row.SavePath);
        storage.ResetDirectorySizeCache();
        logger.LogWarning("[promotion] rejected {Hash} ({Name}): {Reason}; files removed, release blocked, looking for another", row.Hash, row.Name, reason);
    }

    public async Task<EngineActionResult> KeepAsync(string infoHash, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            var row = await FindAsync(db, hash, ct);
            if (row is null) return new EngineActionResult(false, NotFound);
            if (row.Promotion != EnginePromotion.Held) return new EngineActionResult(false, NotHeldMessage);
        }
        var state = await FinishAsync(hash, keep: true);
        if (state == EnginePromotion.Promoted) return new EngineActionResult(true, "Moved into your library.");
        await using (var db = await dbFactory.CreateDbContextAsync(CancellationToken.None))
        {
            var row = await FindAsync(db, hash, CancellationToken.None);
            return new EngineActionResult(false, row?.Promotion == EnginePromotion.Held && row.PromotionReason is { } why
                ? $"{why}. Delete the other file or find another release."
                : "TorrentFlow couldn't move it into your library. Try again in a moment.");
        }
    }

    public async Task<EngineActionResult> FindAnotherAsync(string infoHash, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        using (await LockHashAsync(hash, ct))
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var row = await FindAsync(db, hash, ct);
            if (row is null) return new EngineActionResult(false, NotFound);
            if (row.Promotion != EnginePromotion.Held || _finishing.ContainsKey(hash)) return new EngineActionResult(false, NotHeldMessage);
            await RejectLockedAsync(db, row, FindAnotherReason, null, byOwner: true);
        }
        return new EngineActionResult(true, "Looking for another release.");
    }
}
