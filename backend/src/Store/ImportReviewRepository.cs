using System.Collections.Immutable;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

public sealed class ImportReviewRepository
{
    private readonly TorrentFlowDbContext db;
    internal ImportReviewRepository(TorrentFlowDbContext db) => this.db = db;

    public async Task SaveAsync(ImportScanView scan, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(scan, Schema.Json);
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO ImportReview(id, snapshot) VALUES ({scan.Id}, {json})
            ON CONFLICT(id) DO UPDATE SET snapshot=CASE
                WHEN ImportReview.id LIKE 'adoption:%'
                    AND json_array_length(ImportReview.snapshot,'$.items') >
                        json_array_length(excluded.snapshot,'$.items')
                THEN json_set(ImportReview.snapshot,
                    '$.state',json_extract(excluded.snapshot,'$.state'),
                    '$.error',json_extract(excluded.snapshot,'$.error'))
                ELSE excluded.snapshot END
            """, ct);
        await MarkRootScanCompleteAsync(ct);
    }

    public async Task<ImportScanView?> GetAsync(string id, CancellationToken ct)
    {
        var rows = await db.Database.SqlQueryRaw<string>(
            "SELECT snapshot AS Value FROM ImportReview WHERE id={0}", id).ToListAsync(ct);
        if (rows.Count == 0) return null;
        var scan = JsonSerializer.Deserialize<ImportScanView>(rows[0], Schema.Json)!;
        var decided = await db.Database.SqlQueryRaw<string>(
            "SELECT itemId AS Value FROM ImportDecision WHERE reviewId={0}", id).ToListAsync(ct);
        return scan with { Items = [.. scan.Items.Where(i => !decided.Contains(i.Id))] };
    }

    public async Task<ImmutableArray<ImportScanView>> ListAsync(CancellationToken ct)
    {
        var ids = await db.Database.SqlQueryRaw<string>("SELECT id AS Value FROM ImportReview ORDER BY id").ToListAsync(ct);
        var scans = ImmutableArray.CreateBuilder<ImportScanView>();
        foreach (var id in ids)
            if (await GetAsync(id, ct) is { } scan) scans.Add(scan);
        return scans.ToImmutable();
    }

    public async Task DecideAsync(string id, string item, string decision, CancellationToken ct)
    {
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO ImportDecision(reviewId,itemId,decision,decidedAt)
            VALUES ({id},{item},{decision},{DateTimeOffset.UtcNow.ToString("O")})
            ON CONFLICT(reviewId,itemId) DO NOTHING
            """, ct);
    }

    private async Task MarkRootScanCompleteAsync(CancellationToken ct)
    {
        await db.Database.ExecuteSqlRawAsync("""
            UPDATE Setting SET valueJson=json_set(valueJson,
                '$.firstFullRootScanComplete',json('true')),
                revision=revision+1,updatedAt=strftime('%Y-%m-%dT%H:%M:%f+00:00','now')
            WHERE section='scheduler' AND EXISTS(
                SELECT 1 FROM ImportReview WHERE id='adoption:complete')
            AND json_extract(valueJson,'$.firstFullRootScanComplete')<>1;
            """, ct);
    }
}
