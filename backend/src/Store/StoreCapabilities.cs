using System.Collections.Immutable;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

internal abstract class StoreCapability(TorrentFlowDbContext db, StoreOwner owner, string[] writable,
    ITargetEvents? events = null) : IStore
{
    public async Task<ImmutableArray<TRow>> ReadAsync<TRow>(StoreQuery query, CancellationToken ct) where TRow : StoreRow
    {
        if (query.Limit is < 1 or > 500) throw new ArgumentOutOfRangeException(nameof(query), "Limit must be 1..500.");
        if (query.Order != StoreOrder.PrimaryKey || query.DueAt is not null || query.Before is not null)
            throw new NotSupportedException("Non-primary ordering and age/lease predicates are reserved for the worker implementation.");
        var table = Schema.Table(typeof(TRow));
        IQueryable<Dictionary<string, object>> rows = db.Set<Dictionary<string, object>>(table.Name).AsNoTracking();
        var filters = new (string Column, string? Value)[]
        {
            (table.Key, query.Id), ("workId", query.WorkId), ("targetId", query.TargetId),
            ("downloadId", query.DownloadId), ("userId", query.UserId), ("hash", query.Hash),
            ("normalizedQuery", query.NormalizedQuery), ("seasonId", query.SeasonId),
            ("requestId", query.RequestId), ("rootId", query.RootId), ("sourceId", query.SourceId),
        };
        foreach (var (column, value) in filters.Where(f => f.Value is not null))
        {
            if (!table.Columns.Any(c => c.Name == column)) throw new ArgumentException($"Unsupported filter {column} for {table.Name}.");
            rows = rows.Where(r => EF.Property<string>(r, column) == value);
        }
        if (query.Cursor is not null)
        {
            var cursor = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(query.Cursor));
            rows = rows.Where(r => string.Compare(EF.Property<string>(r, table.Key), cursor) > 0);
        }
        var result = await rows.OrderBy(r => EF.Property<string>(r, table.Key)).Take(query.Limit).ToListAsync(ct);
        var snapshots = result.Select(r => (TRow)table.ToRow(r)).ToImmutableArray();
        foreach (var setting in snapshots.OfType<SettingRow>()) SettingsCatalog.Validate(setting);
        return snapshots;
    }

    public async Task<CommitResult> CommitAsync(StoreCommit commit, CancellationToken ct)
    {
        if (commit.Owner != owner) throw new UnauthorizedAccessException("The caller cannot change its Store capability.");
        var library = commit.LibraryProposal as LibraryTransactionProposal;
        if (commit.LibraryProposal is not null && (owner != StoreOwner.Targets || library is null))
            throw new UnauthorizedAccessException("A Library-issued proposal is required.");
        if (library is FilingWriteProposal filing && !commit.Writes.Any(w => w.Row is TargetRow target &&
            target.Id == filing.TargetId && target.State is TargetState.Filing or TargetState.Done &&
            w.ExpectedVersion is not null))
            throw new ArgumentException("Filing requires its associated Targets state CAS.");
        if (library is PlacementWriteProposal placement &&
            (!commit.Writes.Any(w => w.Row is DownloadRow download && download.Id == placement.DownloadId &&
                w.ExpectedVersion is null && w.ExpectedRow is null) ||
             placement.TargetIds.Any(id => !commit.Writes.Any(w => w.Row is TargetRow target && target.Id == id &&
                target.State is TargetState.Fetching or TargetState.Paused) ||
                !commit.Writes.Any(w => w.Row is DownloadTargetRow link && link.TargetId == id &&
                    link.DownloadId == placement.DownloadId && link.Role == AssociationRole.Current))))
            throw new ArgumentException("External placement requires its new Download and accepted Targets in the same commit.");
        if (library is not null)
            commit = commit with { Writes = commit.Writes.AddRange(library.Writes),
                Deletes = commit.Deletes.AddRange(library.Deletes) };
        if (string.IsNullOrWhiteSpace(commit.IdempotencyKey) || commit.IdempotencyKey.Length > 128)
            throw new ArgumentException("A bounded durable commit receipt is required.");
        var receipts = commit.Writes.Where(w => w.Row is AttemptRow { Kind: AttemptKind.LegacyEvent } receipt
            && receipt.Id.StartsWith("commit:", StringComparison.Ordinal)).ToArray();
        if (receipts.Length != 1 || receipts[0].ExpectedRow is not null || receipts[0].ExpectedVersion is not null)
            throw new NotSupportedException("A transaction must include its immutable Attempt command receipt.");
        var receipt = (AttemptRow)receipts[0].Row;
        if (!receipt.Id.EndsWith(":" + commit.IdempotencyKey, StringComparison.Ordinal))
            throw new ArgumentException("The receipt must bind the actor and idempotency key.");
        var digestPayload = new
        {
            commit.IdempotencyKey, owner,
            writes = commit.Writes.Select(w => new
            {
                type = w.Row.GetType().Name, row = SerializeRow(w.Row), w.ExpectedVersion,
                expectedRow = w.ExpectedRow is null ? (JsonElement?)null : SerializeRow(w.ExpectedRow),
            }),
            deletes = commit.Deletes.Select(d => new
            {
                d.Table, d.Id, d.ExpectedVersion,
                expectedRow = d.ExpectedRow is null ? (JsonElement?)null : SerializeRow(d.ExpectedRow),
            }),
        };
        var digestJson = library is PlacementWriteProposal reviewPlacement
            ? JsonSerializer.Serialize(new { commit = digestPayload, reviewPlacement.ReviewId, reviewPlacement.ReviewItemIds }, Schema.Json)
            : JsonSerializer.Serialize(digestPayload, Schema.Json);
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(digestJson)));
        var persistedReceipt = receipt with
        {
            LegacyContext = JsonSerializer.SerializeToElement(new { receipt.LegacyContext, owner, digest }, Schema.Json),
        };
        var identities = commit.Writes.Select(w => (Schema.Table(w.Row.GetType()).Name, w.Row.Id))
            .Concat(commit.Deletes.Select(d => (d.Table.ToString(), d.Id))).ToArray();
        if (identities.Distinct().Count() != identities.Length)
            throw new ArgumentException("A commit may change each row only once.");
        var conflicts = new List<string>();
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            var existing = await db.Set<Dictionary<string, object>>("Attempt")
                .AsNoTracking().SingleOrDefaultAsync(r => EF.Property<string>(r, "id") == receipt.Id, ct);
            if (existing is not null)
            {
                var row = (AttemptRow)Schema.Table("Attempt").ToRow(existing);
                var matches = row.LegacyContext is { } context && context.TryGetProperty("digest", out var storedDigest)
                    && storedDigest.GetString() == digest;
                return new(matches, !matches, matches ? [] : [receipt.Id]);
            }
            foreach (var write in commit.Writes)
                await StageAsync(Schema.Table(write.Row.GetType()), write.Row.Id,
                    write == receipts[0] ? persistedReceipt : write.Row, write.ExpectedVersion, write.ExpectedRow);
            foreach (var delete in commit.Deletes)
                await StageAsync(Schema.Table(delete.Table.ToString()), delete.Id, null, delete.ExpectedVersion, delete.ExpectedRow);
            if (conflicts.Count != 0)
            {
                db.ChangeTracker.Clear();
                return new(false, true, [.. conflicts]);
            }
            // Release filtered unique Current/Replacement slots inside this transaction
            // before EF orders promotions by primary key rather than logical role.
            foreach (var write in commit.Writes.Where(w => w.Row is DownloadTargetRow
                { Role: AssociationRole.Retired } && w.ExpectedRow is DownloadTargetRow
                { Role: AssociationRole.Current or AssociationRole.Replacement }))
            {
                var link = (DownloadTargetRow)write.Row;
                await db.Database.ExecuteSqlInterpolatedAsync(
                    $"UPDATE DownloadTarget SET role='retired' WHERE id={link.Id}", ct);
            }
            await db.SaveChangesAsync(ct);
            if (library is PlacementWriteProposal { ReviewId: { } reviewId } admitted)
            {
                var reviews = new ImportReviewRepository(db);
                foreach (var itemId in admitted.ReviewItemIds)
                    await reviews.DecideAsync(reviewId, itemId, "handed-over", ct);
            }
            await transaction.CommitAsync(ct);
            events?.Publish([.. commit.Writes.Select(w => w.Row)]);
            return new(true, false, []);
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 })
        {
            return new(false, true, [.. commit.Writes.Select(w => w.Row.Id).Concat(commit.Deletes.Select(d => d.Id))]);
        }
        finally { db.ChangeTracker.Clear(); }

        static JsonElement SerializeRow(StoreRow row) => JsonSerializer.SerializeToElement(row, row.GetType(), Schema.Json);

        async Task StageAsync(TableDefinition table, string id, StoreRow? replacement, long? version, StoreRow? expected)
        {
            var isReceipt = replacement?.Id == persistedReceipt.Id && table.Name == "Attempt";
            var libraryRow = library is not null && (library.Writes.Any(w => w.Row == replacement) ||
                replacement is null && library.Deletes.Any(d => d.Table.ToString() == table.Name && d.Id == id));
            if (!isReceipt && !libraryRow && !writable.Contains(table.Name)) throw new UnauthorizedAccessException($"{owner} cannot write {table.Name}.");
            if (replacement is SettingRow setting) SettingsCatalog.Validate(setting);
            var set = db.Set<Dictionary<string, object>>(table.Name);
            var current = await set.SingleOrDefaultAsync(r => EF.Property<string>(r, table.Key) == id, ct);
            if (table.Name == "DownloadFile" && !libraryRow)
            {
                var proposed = replacement is null ? null : table.ToEntity(replacement);
                var pathColumns = new[] { "partialPath", "finalPath", "physicalKey", "mediaFileId", "enginePath", "filed" };
                if (pathColumns.Any(column => !Equals(current?.GetValueOrDefault(column) ?? (column == "filed" ? false : null),
                    proposed?.GetValueOrDefault(column) ?? (column == "filed" ? false : null))))
                    throw new NotSupportedException("Library-owned bindings require a validated Library proposal capability.");
            }
            var versionColumn = table.Columns.SingleOrDefault(c => c.Name is "version" or "revision");
            if (current is null)
            {
                if (replacement is null || version is not null || expected is not null) { conflicts.Add(id); return; }
                set.Add(table.ToEntity(replacement));
                return;
            }
            if (versionColumn is not null)
            {
                if (version is null || Convert.ToInt64(current[versionColumn.Name]) != version
                    || replacement is not null && Convert.ToInt64(table.ToEntity(replacement)[versionColumn.Name]) != version + 1)
                { conflicts.Add(id); return; }
            }
            else if (expected is null || expected.GetType() != table.RowType
                || JsonSerializer.Serialize(table.ToRow(current), table.RowType, Schema.Json)
                    != JsonSerializer.Serialize(expected, table.RowType, Schema.Json))
            { conflicts.Add(id); return; }
            if (table.Name == "Attempt") throw new NotSupportedException("History mutation is reserved for explicit close/evidence/prune operations.");
            if (table.Name == "Download" && replacement is null)
            {
                // Download rows are removable; their optional history pointer is not the
                // historical identity. Preserve the release hash and immutable decision.
                var history = await db.Set<Dictionary<string, object>>("Attempt")
                    .Where(r => EF.Property<string>(r, "downloadId") == id).ToListAsync(ct);
                foreach (var attempt in history) attempt["downloadId"] = null!;
            }
            if (replacement is null) set.Remove(current);
            else db.Entry(current).CurrentValues.SetValues(table.ToEntity(replacement));
        }
    }
}

internal sealed class MetadataStoreCapability(TorrentFlowDbContext db) : StoreCapability(db, StoreOwner.Metadata,
    ["Work", "WorkName", "WorkLink", "Season", "Episode", "MetadataCache"]);
internal sealed class FindStoreCapability(TorrentFlowDbContext db) : StoreCapability(db, StoreOwner.Find,
    ["Release", "ReleaseObservation", "SearchCache"]);
internal sealed class TargetsStoreCapability(TorrentFlowDbContext db, ITargetEvents events) : StoreCapability(db, StoreOwner.Targets,
    ["WorkPreference", "Target", "ScopeIntent", "RawIntent", "Request", "RequestItem", "AutoApproveRule",
     "Follow", "WatchItem", "UpgradeEvidence", "AutoRule", "Attempt", "Block", "Download", "DownloadTarget",
     "DownloadFile", "User", "Notification", "PushSubscription", "Setting"], events);

internal sealed class AccessStoreCapability(TorrentFlowDbContext db) : StoreCapability(db, StoreOwner.Targets,
    ["User", "Setting", "Attempt"]);
