using System.Diagnostics;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine;

/// <summary>
/// Finishes the deletes <see cref="RemoveManyAsync"/> recorded. A batch of tombstones waits for its transfers to leave
/// the client, deletes their files when asked, then drops the tombstones. A file another program holds is retried with
/// a growing delay, and tombstones survive a restart, so the files still end up deleted. Every step is safe to repeat.
/// </summary>
internal sealed partial class TorrentEngineService
{
    private static readonly TimeSpan FirstCleanupRetry = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan LastCleanupRetry = TimeSpan.FromMinutes(15);
    private readonly SemaphoreSlim _cleanupSignal = new(0, 1);

    private void SignalCleanup()
    {
        try { _cleanupSignal.Release(); }
        catch (SemaphoreFullException) { }
    }

    /// <summary>
    /// The cleanup worker, until the host stops. The first pass takes every leftover from before a restart at once;
    /// after that a batch runs when a delete signals or its retry is due.
    /// </summary>
    internal async Task RunDeletionCleanupAsync(CancellationToken ct)
    {
        await Task.Yield();
        var firstPass = true;
        while (!ct.IsCancellationRequested)
        {
            TimeSpan wait;
            try
            {
                wait = await CleanupDeletionsAsync(includeNotDue: firstPass, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Cleaning up deleted downloads failed");
                wait = TimeSpan.FromMinutes(1);
            }
            firstPass = false;
            try { await _cleanupSignal.WaitAsync(wait, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    /// <summary>One pass over the due batches, oldest first. Returns how long until the next retry is due.</summary>
    internal async Task<TimeSpan> CleanupDeletionsAsync(bool includeNotDue, CancellationToken ct)
    {
        var now = Now;
        foreach (var batch in (await PendingDeletionsAsync(ct)).Where(d => includeNotDue || d.NextAttemptAt <= now)
            .GroupBy(d => d.BatchId).OrderBy(b => b.Min(d => d.CreatedAt)).ToList())
        {
            ct.ThrowIfCancellationRequested();
            await CleanupBatchAsync(batch.Key, batch.Select(d => d.Hash).ToList());
        }
        var pending = await PendingDeletionsAsync(ct);
        if (pending.Count == 0) return Timeout.InfiniteTimeSpan;
        var next = pending.Min(d => d.NextAttemptAt) - Now;
        return next > TimeSpan.Zero ? next : TimeSpan.Zero;
    }

    private async Task<List<EngineDeletion>> PendingDeletionsAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.EngineDeletions.AsNoTracking().Where(d => d.UserId == LocalUser.Id).ToListAsync(ct);
    }

    private async Task CleanupBatchAsync(string batchId, IReadOnlyList<string> hashes)
    {
        var started = Stopwatch.GetTimestamp();
        var held = new List<IDisposable>();
        await _removeGate.WaitAsync();
        try
        {
            foreach (var hash in hashes.Distinct().Order(StringComparer.Ordinal)) held.Add(await LockHashAsync(hash, CancellationToken.None));
        }
        finally
        {
            _removeGate.Release();
        }
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync();
            // Re-read under the locks: a delete in between may have moved a tombstone into a newer batch.
            var tombstones = await db.EngineDeletions.Where(d => d.UserId == LocalUser.Id && d.BatchId == batchId && hashes.Contains(d.Hash)).ToListAsync();
            if (tombstones.Count == 0) return;
            var keys = tombstones.Select(d => d.Hash).ToList();
            var readded = (await db.EngineTorrents.AsNoTracking().Where(r => r.UserId == LocalUser.Id && keys.Contains(r.Hash))
                .Select(r => r.Hash).ToListAsync()).ToHashSet(StringComparer.Ordinal);
            // Added again since the delete: the files belong to the new transfer now, so this delete ends without them.
            db.EngineDeletions.RemoveRange(tombstones.Where(d => readded.Contains(d.Hash)));
            var gone = tombstones.Where(d => !readded.Contains(d.Hash)).ToList();
            await Task.WhenAll(gone.Select(d => backend.RemoveAsync(d.Hash)));

            // A transfer that never reached the library owns its whole stage folder: it goes in one piece, files or not,
            // since nothing in a stage folder is the owner's library.
            var staged = gone.Where(d => StagePaths.IsStage(d.SavePath)).ToList();
            var withFiles = gone.Where(d => d.DeleteFiles || staged.Contains(d)).ToList();
            IReadOnlyList<string> left = [];
            if (withFiles.Count > 0)
            {
                var inPlace = withFiles.Except(staged).ToList();
                var baseRoot = (await settings.GetConfigAsync(CancellationToken.None)).DownloadRoot;
                List<string> otherPaths = [];
                if (!string.IsNullOrWhiteSpace(baseRoot))
                    foreach (var other in await db.EngineTorrents.AsNoTracking().ToListAsync())
                    {
                        if (!string.IsNullOrWhiteSpace(other.SavePath)) otherPaths.Add(other.SavePath);
                        otherPaths.AddRange(VerifiedFiles(other).Select(f => f.FullPath).OfType<string>());
                    }
                if (inPlace.Count > 0)
                    left = await DeleteReleasesAsync(inPlace.Select(d => (d.SavePath, (IReadOnlyList<string>)DeletionFiles(d))).ToList(), baseRoot, otherPaths);
                foreach (var d in staged)
                    if (!await StagePaths.DeleteAsync(d.SavePath)) left = [.. left, d.SavePath!];
                storage.ResetDirectorySizeCache();
            }

            var names = string.Join(", ", gone.Select(d => d.Name));
            if (left.Count == 0)
            {
                foreach (var d in withFiles)
                {
                    TryDelete(TorrentFilePath(d.Hash));
                    _layoutManifest.Forget(d.Hash, d.SavePath);
                }
                db.EngineDeletions.RemoveRange(gone);
                if (gone.Count > 0)
                    logger.LogInformation("Finished deleting {Count} downloads ({Names}), files {Files}, {AgeMs:0} ms after the delete ({Ms:0} ms of cleanup)",
                        gone.Count, names, withFiles.Count > 0 ? "deleted" : "kept", (Now - gone.Min(d => d.CreatedAt)).TotalMilliseconds,
                        Stopwatch.GetElapsedTime(started).TotalMilliseconds);
            }
            else
            {
                var attempts = gone.Max(d => d.Attempts) + 1;
                var delay = TimeSpan.FromTicks(Math.Min(LastCleanupRetry.Ticks, FirstCleanupRetry.Ticks << Math.Min(attempts - 1, 16)));
                foreach (var d in gone)
                {
                    d.Attempts = attempts;
                    d.LastError = $"{left.Count} files could not be deleted yet, for example {left[0]}";
                    d.NextAttemptAt = Now + delay;
                }
                logger.LogWarning("Could not delete {Count} files of {Names} yet (attempt {Attempt}), for example {File}; retrying in {Delay}",
                    left.Count, names, attempts, left[0], delay);
            }
            await db.SaveChangesAsync();
        }
        finally
        {
            foreach (var h in held) h.Dispose();
        }
    }

    /// <summary>The full paths a tombstone recorded; an unreadable list deletes nothing.</summary>
    internal static List<string> DeletionFiles(EngineDeletion deletion)
    {
        if (string.IsNullOrWhiteSpace(deletion.FilesJson)) return [];
        try { return JsonSerializer.Deserialize<List<string>>(deletion.FilesJson, JsonOptions) ?? []; }
        catch (JsonException) { return []; }
    }
}
