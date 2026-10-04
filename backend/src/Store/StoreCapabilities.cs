using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

internal sealed class StoreCapability(TorrentFlowDbContext db, ITargetEvents events) : IStore
{
    public async Task<ImmutableArray<TRow>> ReadAsync<TRow>(StoreQuery query, CancellationToken ct) where TRow : StoreRow
    {
        if (query.Limit is < 1 or > 500) throw new ArgumentOutOfRangeException(nameof(query), "Limit must be 1..500.");
        if (query.Order != StoreOrder.PrimaryKey || query.DueAt is not null || query.Before is not null)
            throw new NotSupportedException("Non-primary ordering and age/lease predicates are reserved for the worker implementation.");

        IQueryable<TRow> rows = db.Set<TRow>().AsNoTracking();
        var filters = new (string Column, string? Value)[]
        {
            (PrimaryKeyColumn<TRow>(), query.Id), ("workId", query.WorkId), ("targetId", query.TargetId),
            ("downloadId", query.DownloadId), ("userId", query.UserId), ("hash", query.Hash),
            ("normalizedQuery", query.NormalizedQuery), ("seasonId", query.SeasonId),
            ("requestId", query.RequestId), ("rootId", query.RootId), ("sourceId", query.SourceId),
        };
        foreach (var (column, value) in filters.Where(f => f.Value is not null))
        {
            var property = FindColumn<TRow>(column);
            if (property is null) throw new ArgumentException($"Unsupported filter {column} for {typeof(TRow).Name}.");
            rows = rows.Where(row => EF.Property<string>(row, property) == value);
        }
        if (query.Cursor is not null)
        {
            var cursor = Encoding.UTF8.GetString(Convert.FromBase64String(query.Cursor));
            rows = rows.Where(row => string.Compare(row.Id, cursor) > 0);
        }
        var result = await rows.OrderBy(row => row.Id).Take(query.Limit).ToListAsync(ct);
        foreach (var setting in result.OfType<SettingRow>()) SettingsCatalog.Validate(setting);
        return [.. result];
    }

    public async Task<CommitResult> CommitAsync(StoreCommit commit, CancellationToken ct)
    {
        if (commit.LibraryProposal is LibraryTransactionProposal proposal)
            commit = commit with { Writes = commit.Writes.AddRange(proposal.Writes), Deletes = commit.Deletes.AddRange(proposal.Deletes) };
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
            commit.IdempotencyKey, commit.Owner,
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
        var digestJson = commit.LibraryProposal is PlacementWriteProposal placement
            ? JsonSerializer.Serialize(new { commit = digestPayload, placement.ReviewId, placement.ReviewItemIds }, StoreJson.Options)
            : JsonSerializer.Serialize(digestPayload, StoreJson.Options);
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(digestJson)));
        var persistedReceipt = receipt with
        {
            LegacyContext = JsonSerializer.SerializeToElement(new { receipt.LegacyContext, owner = commit.Owner, digest }, StoreJson.Options),
        };
        var identities = commit.Writes.Select(w => (TableName(w.Row.GetType()), w.Row.Id))
            .Concat(commit.Deletes.Select(d => (d.Table.ToString(), d.Id))).ToArray();
        if (identities.Distinct().Count() != identities.Length)
            throw new ArgumentException("A commit may change each row only once.");
        var conflicts = new List<string>();
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            var existing = await db.Attempts.AsNoTracking().SingleOrDefaultAsync(row => row.Id == receipt.Id, ct);
            if (existing is not null)
            {
                var matches = existing.LegacyContext is { } context && context.TryGetProperty("digest", out var storedDigest)
                    && storedDigest.GetString() == digest;
                return new(matches, !matches, matches ? [] : [receipt.Id]);
            }
            foreach (var write in commit.Writes)
                await StageAsync(write.Row, write == receipts[0] ? persistedReceipt : write.Row, write.ExpectedVersion, write.ExpectedRow);
            foreach (var delete in commit.Deletes)
                await StageTableAsync(delete.Table.ToString(), delete.Id, null, delete.ExpectedVersion, delete.ExpectedRow);
            if (conflicts.Count != 0)
            {
                db.ChangeTracker.Clear();
                return new(false, true, [.. conflicts]);
            }

            if (commit.Owner == StoreOwner.Metadata)
            {
                foreach (var delete in commit.Deletes.Where(d => d.Table == StoreTable.WorkLink &&
                    d.ExpectedRow is WorkLinkRow { Status: LinkStatus.Verified }))
                    await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE WorkLink SET status='suggested' WHERE id={delete.Id}", ct);
                foreach (var delete in commit.Deletes.Where(d => d.Table == StoreTable.Episode))
                    await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE Episode SET providerEpisodeId=NULL WHERE id={delete.Id}", ct);
            }

            foreach (var write in commit.Writes.Where(w => w.Row is DownloadTargetRow
                { Role: AssociationRole.Retired } && w.ExpectedRow is DownloadTargetRow
                { Role: AssociationRole.Current or AssociationRole.Replacement }))
            {
                var link = (DownloadTargetRow)write.Row;
                await db.Database.ExecuteSqlInterpolatedAsync(
                    $"UPDATE DownloadTarget SET role='retired' WHERE id={link.Id}", ct);
            }

            var movingEpisodes = commit.Writes.Where(w => w.Row is EpisodeRow && w.ExpectedVersion is not null)
                .Select(w => (EpisodeRow)w.Row).Where(episode =>
                {
                    var entry = db.ChangeTracker.Entries<EpisodeRow>().Single(x => x.Entity.Id == episode.Id);
                    return entry.OriginalValues.GetValue<string>(nameof(EpisodeRow.SeasonId)) != episode.SeasonId ||
                        entry.OriginalValues.GetValue<int>(nameof(EpisodeRow.Number)) != episode.Number;
                }).ToArray();
            if (movingEpisodes.Length > 0)
            {
                using var command = db.Database.GetDbConnection().CreateCommand();
                command.Transaction = transaction.GetDbTransaction();
                command.CommandText = "SELECT COALESCE(MAX(number),0) FROM Episode";
                var temporaryNumber = Convert.ToInt32(await command.ExecuteScalarAsync(ct));
                foreach (var episode in movingEpisodes)
                {
                    temporaryNumber = checked(temporaryNumber + 1);
                    await db.Database.ExecuteSqlInterpolatedAsync(
                        $"UPDATE Episode SET number={temporaryNumber} WHERE id={episode.Id}", ct);
                }
            }
            await db.SaveChangesAsync(ct);
            if (commit.LibraryProposal is PlacementWriteProposal { ReviewId: { } reviewId } admitted)
            {
                var reviews = new ImportReviewRepository(db);
                foreach (var itemId in admitted.ReviewItemIds)
                    await reviews.DecideAsync(reviewId, itemId, "handed-over", ct);
            }
            await transaction.CommitAsync(ct);
            events.Publish([.. commit.Writes.Select(w => w.Row)]);
            return new(true, false, []);
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 })
        {
            return new(false, true, [.. commit.Writes.Select(w => w.Row.Id).Concat(commit.Deletes.Select(d => d.Id))]);
        }
        finally { db.ChangeTracker.Clear(); }

        static JsonElement SerializeRow(StoreRow row) => JsonSerializer.SerializeToElement(row, row.GetType(), StoreJson.Options);

        async Task StageAsync(StoreRow row, StoreRow? replacement, long? version, StoreRow? expected) =>
            await StageTableAsync(TableName(row.GetType()), row.Id, replacement, version, expected);

        async Task StageTableAsync(string table, string id, StoreRow? replacement, long? version, StoreRow? expected)
        {
            var type = replacement?.GetType() ?? EntityType(table);
            var current = await db.FindAsync(type, [id], ct) as StoreRow;
            if (replacement is SettingRow setting) SettingsCatalog.Validate(setting);
            if (current is null)
            {
                if (replacement is null || version is not null || expected is not null) { conflicts.Add(id); return; }
                db.Add(replacement);
                return;
            }
            var currentVersion = VersionOf(current);
            if (currentVersion is { } currentValue)
            {
                if (version is null || currentValue != version || replacement is not null && VersionOf(replacement) != version + 1)
                { conflicts.Add(id); return; }
            }
            else if (expected is null || expected.GetType() != current.GetType() ||
                JsonSerializer.Serialize(current, current.GetType(), StoreJson.Options) !=
                JsonSerializer.Serialize(expected, expected.GetType(), StoreJson.Options))
            { conflicts.Add(id); return; }
            if (current is AttemptRow) throw new NotSupportedException("History mutation is reserved for explicit close/evidence/prune operations.");
            if (current is DownloadRow && replacement is null)
            {
                var history = await db.Attempts.Where(row => row.DownloadId == id).ToListAsync(ct);
                foreach (var attempt in history)
                    db.Entry(attempt).CurrentValues.SetValues(attempt with { DownloadId = null });
            }
            if (replacement is null) db.Remove(current);
            else db.Entry(current).CurrentValues.SetValues(replacement);
        }
    }

    private string? FindColumn<TRow>(string column) where TRow : StoreRow
    {
        var entity = db.Model.FindEntityType(typeof(TRow))!;
        var table = Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table(entity.GetTableName()!, entity.GetSchema());
        return entity.GetProperties().SingleOrDefault(property => property.GetColumnName(table) == column)?.Name;
    }

    private string PrimaryKeyColumn<TRow>() where TRow : StoreRow
    {
        var entity = db.Model.FindEntityType(typeof(TRow))!;
        var key = entity.FindPrimaryKey()!.Properties.Single();
        var table = Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table(entity.GetTableName()!, entity.GetSchema());
        return key.GetColumnName(table)!;
    }

    private Type EntityType(string table) => db.Model.GetEntityTypes()
        .Single(entity => entity.GetTableName() == table).ClrType;

    private string TableName(Type type) => db.Model.FindEntityType(type)!.GetTableName()!;

    private static long? VersionOf(StoreRow row) => row switch
    {
        WorkRow value => value.Version,
        SeasonRow value => value.Version,
        EpisodeRow value => value.Version,
        WorkPreferenceRow value => value.Version,
        TargetRow value => value.Version,
        ScopeIntentRow value => value.Version,
        RawIntentRow value => value.Version,
        RequestRow value => value.Version,
        FollowRow value => value.Version,
        WatchItemRow value => value.Version,
        AutoRuleRow value => value.Version,
        DownloadRow value => value.Version,
        StorageRootRow value => value.Version,
        WorkFolderRow value => value.Version,
        MediaFileRow value => value.Version,
        SettingRow value => value.Revision,
        _ => null,
    };
}
