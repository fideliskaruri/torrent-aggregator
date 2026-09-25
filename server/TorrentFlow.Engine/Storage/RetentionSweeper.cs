using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;

namespace TorrentFlow.Engine.Storage;

public sealed record RetentionSweepCandidate(
    string Id, string Hash, string Name, string Origin, string RetentionPolicy, long SizeBytes, long OnDiskBytes,
    double Progress, string Status, string Kind, DateTime LastUsedAt, DateTime? CompletedAt, bool FullyWatched);

public sealed record RetentionSweepSkip(string Hash, string Reason, string? Name = null);

public sealed record RetentionSweepResult(
    string Mode, long BudgetBytes, long UsedBytes, long TargetBytes, long ReclaimedBytes, bool Satisfied, int Scanned,
    IReadOnlyList<RetentionSweepCandidate> WouldDelete, IReadOnlyList<RetentionSweepCandidate> Deleted, IReadOnlyList<RetentionSweepSkip> Skipped);

/// <summary>
/// Reclaims stream/prewarm cache, oldest use first, until the ephemeral bytes fit the budget. Kept downloads
/// (origin user), live transfers and leased rows are never candidates.
/// </summary>
public sealed class RetentionSweeper(IDbContextFactory<TorrentFlowDbContext> dbFactory, ITorrentEngine engine, TimeProvider time)
{
    public static readonly TimeSpan Grace = TimeSpan.FromMinutes(30);

    public async Task<RetentionSweepResult> SweepAsync(string mode, long budgetBytes, CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var rows = await db.EngineTorrents.AsNoTracking()
            .Where(r => r.UserId == LocalUser.Id && (r.Origin == TorrentOrigin.Stream || r.Origin == TorrentOrigin.Prewarm))
            .OrderBy(r => r.LastUsedAt).ToListAsync(ct);
        var now = time.GetUtcNow().UtcDateTime;
        var used = rows.Sum(r => OnDisk(r));
        var target = Math.Max(0, budgetBytes);
        var would = new List<RetentionSweepCandidate>();
        var deleted = new List<RetentionSweepCandidate>();
        var skipped = new List<RetentionSweepSkip>();
        long reclaimed = 0;
        var live = (await engine.ListAsync(ct)).Where(t => t.State is "downloading" or "stalledDL" or "metaDL" or "checkingDL")
            .Select(t => t.Hash).ToHashSet(StringComparer.OrdinalIgnoreCase);

        foreach (var r in rows)
        {
            if (used - reclaimed <= target) break;
            if (r.EvictLease is not null) { skipped.Add(new(r.Hash, "leased", r.Name)); continue; }
            if (live.Contains(r.Hash)) { skipped.Add(new(r.Hash, "active", r.Name)); continue; }
            if (now - r.LastUsedAt < Grace) { skipped.Add(new(r.Hash, "recently-used", r.Name)); continue; }
            var done = TorrentEngineService.IsDownloaded(r);
            var c = new RetentionSweepCandidate(r.Id, r.Hash, r.Name, r.Origin, "EPHEMERAL", r.SizeBytes, OnDisk(r), r.Progress, r.Status,
                done ? "watched" : "stalled", r.LastUsedAt, done ? r.VerifiedAt : null, false);
            would.Add(c);
            if (mode == "delete")
            {
                var result = await engine.RemoveAsync(r.Hash, deleteFiles: true, ct);
                if (result.Ok) deleted.Add(c);
                else { skipped.Add(new(r.Hash, "delete-failed", r.Name)); continue; }
            }
            reclaimed += c.OnDiskBytes;
        }
        return new RetentionSweepResult(mode, budgetBytes, used, target, reclaimed, used - reclaimed <= target, rows.Count, would, deleted, skipped);
    }

    private static long OnDisk(Data.Entities.EngineTorrent r) => (long)(Math.Max(0, r.SizeBytes) * Math.Clamp(r.Progress, 0, 1));
}
