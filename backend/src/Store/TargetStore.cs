using System.Collections.Immutable;
using System.Linq.Expressions;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

public sealed class TargetStore
{
    private readonly TorrentFlowDbContext db;
    private readonly ITargetEvents events;

    internal TargetStore(TorrentFlowDbContext db, ITargetEvents events)
    {
        this.db = db;
        this.events = events;
    }

    public async Task<T[]> ListAsync<T>(Expression<Func<T, bool>>? where, CancellationToken ct) where T : class
    {
        IQueryable<T> rows = db.Set<T>().AsNoTracking();
        if (where is not null) rows = rows.Where(where);
        var result = await rows.ToArrayAsync(ct);
        foreach (var setting in result.OfType<SettingRow>()) SettingsCatalog.Validate(setting);
        return result;
    }

    public async Task<bool> SaveAsync(IEnumerable<RowWrite> writes, IEnumerable<RowDelete> deletes, CancellationToken ct)
    {
        var writeRows = writes.ToArray();
        var deleteRows = deletes.ToArray();
        var identities = writeRows.Select(w => (w.Row.GetType(), w.Row.Id))
            .Concat(deleteRows.Select(d => (EntityType(d.Table), d.Id))).ToArray();
        if (identities.Distinct().Count() != identities.Length)
            throw new ArgumentException("A save may change each row only once.");

        IDbContextTransaction? transaction = null;
        try
        {
            transaction = await db.Database.BeginTransactionAsync(ct);
            foreach (var write in writeRows)
                if (!await StageAsync(write.Row, write.ExpectedVersion, write.ExpectedRow, ct)) return false;
            foreach (var delete in deleteRows)
                if (!await StageAsync(delete.Table, delete.Id, null, delete.ExpectedVersion, delete.ExpectedRow, ct)) return false;

            foreach (var delete in deleteRows.Where(d => d.Table == StoreTable.Episode))
                await db.Database.ExecuteSqlInterpolatedAsync(
                    $"UPDATE Episode SET providerEpisodeId=NULL WHERE id={delete.Id}", ct);

            foreach (var write in writeRows.Where(w => w.Row is DownloadTargetRow
                { Role: AssociationRole.Retired } && w.ExpectedRow is DownloadTargetRow
                { Role: AssociationRole.Current or AssociationRole.Replacement }))
            {
                var link = (DownloadTargetRow)write.Row;
                await db.Database.ExecuteSqlInterpolatedAsync(
                    $"UPDATE DownloadTarget SET role='retired' WHERE id={link.Id}", ct);
            }

            var movingEpisodes = writeRows.Where(w => w.Row is EpisodeRow && w.ExpectedVersion is not null)
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
            await transaction.CommitAsync(ct);
            events.Publish([.. writeRows.Select(w => w.Row)]);
            return true;
        }
        catch (DbUpdateConcurrencyException)
        {
            return false;
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException
            { SqliteExtendedErrorCode: 1555 or 2067 })
        {
            return false;
        }
        finally
        {
            db.ChangeTracker.Clear();
            if (transaction is not null) await transaction.DisposeAsync();
        }
    }

    private async Task<bool> StageAsync(StoreRow row, long? expectedVersion, StoreRow? expectedRow, CancellationToken ct)
    {
        var current = await db.FindAsync(row.GetType(), [row.Id], ct) as StoreRow;
        if (row is SettingRow setting) SettingsCatalog.Validate(setting);
        if (current is null)
        {
            if (expectedVersion is not null || expectedRow is not null) return false;
            db.Add(row);
            return true;
        }

        var currentEntry = db.Entry(current);
        var version = VersionProperty(currentEntry);
        if (version is not null)
        {
            if (expectedVersion is null) return false;
            currentEntry.Property(version).OriginalValue = expectedVersion;
        }
        else if (expectedRow is not null && !Equals(current, expectedRow)) return false;

        if (current is AttemptRow)
            throw new NotSupportedException("Attempt history can only be inserted or changed by explicit history operations.");
        currentEntry.CurrentValues.SetValues(row);
        return true;
    }

    private async Task<bool> StageAsync(StoreTable table, string id, StoreRow? replacement,
        long? expectedVersion, StoreRow? expectedRow, CancellationToken ct)
    {
        var type = replacement?.GetType() ?? EntityType(table);
        var current = await db.FindAsync(type, [id], ct) as StoreRow;
        if (current is null || replacement is not null) return false;
        var entry = db.Entry(current);
        var version = VersionProperty(entry);
        if (version is not null)
        {
            if (expectedVersion is null) return false;
            entry.Property(version).OriginalValue = expectedVersion;
        }
        else if (expectedRow is not null && !Equals(current, expectedRow)) return false;
        if (current is AttemptRow)
            throw new NotSupportedException("Attempt history can only be inserted or changed by explicit history operations.");
        if (current is DownloadRow)
        {
            var history = await db.Attempts.Where(attempt => attempt.DownloadId == id).ToListAsync(ct);
            foreach (var attempt in history)
                db.Entry(attempt).CurrentValues.SetValues(attempt with { DownloadId = null });
        }
        db.Remove(current);
        return true;
    }

    private static string? VersionProperty(Microsoft.EntityFrameworkCore.ChangeTracking.EntityEntry entry) =>
        entry.Metadata.FindProperty("Version") is not null ? "Version" :
        entry.Metadata.FindProperty("Revision") is not null ? "Revision" : null;

    private Type EntityType(StoreTable table) => db.Model.GetEntityTypes()
        .Single(entity => entity.GetTableName() == table.ToString()).ClrType;
}
