using System.Collections.Immutable;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

public sealed class LibraryRepository : ILibraryRepository
{
    private readonly TorrentFlowDbContext db;
    internal LibraryRepository(TorrentFlowDbContext db) => this.db = db;

    public Task<ImmutableArray<StorageRootRow>> RootsAsync(CancellationToken ct) => ReadAsync<StorageRootRow>(null, ct);
    public Task<ImmutableArray<MediaFileRow>> MediaAsync(string? workId, CancellationToken ct) => ReadAsync<MediaFileRow>(workId, ct);
    public Task<ImmutableArray<WorkFolderRow>> FoldersAsync(CancellationToken ct) => ReadAsync<WorkFolderRow>(null, ct);
    public Task<ImmutableArray<DownloadFileRow>> BindingsAsync(CancellationToken ct) => ReadAsync<DownloadFileRow>(null, ct);

    private async Task<ImmutableArray<T>> ReadAsync<T>(string? workId, CancellationToken ct) where T : StoreRow
    {
        var table = Schema.Table(typeof(T));
        var rows = db.Set<Dictionary<string, object>>(table.Name).AsNoTracking();
        if (workId is not null) rows = rows.Where(r => EF.Property<string>(r, "workId") == workId);
        return [.. (await rows.OrderBy(r => EF.Property<string>(r, table.Key)).ToListAsync(ct))
            .Select(r => (T)table.ToRow(r))];
    }

    public async Task<ImmutableDictionary<string, long>> ReservationsAsync(CancellationToken ct)
    {
        var downloads = await ReadAsync<DownloadRow>(null, ct);
        var files = await BindingsAsync(ct);
        return downloads.Where(d => d.RootId is not null)
            .GroupBy(d => d.RootId!).ToImmutableDictionary(g => g.Key,
                g => files.Where(f => g.Any(d => d.Id == f.DownloadId) && f.Selected && !f.Filed)
                    .Sum(f => f.ExpectedBytes));
    }

    public async Task<bool> SaveRootAsync(StorageRootRow root, long? expectedVersion, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            if (!await StageAsync(root, expectedVersion, ct)) return false;
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        catch (DbUpdateConcurrencyException) { return false; }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 }) { return false; }
        finally { db.ChangeTracker.Clear(); }
    }

    public async Task<bool> RemoveRootAsync(string id, long expectedVersion, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            foreach (var table in new[] { "MediaFile", "WorkFolder", "Download", "RawIntent" })
                if (await db.Set<Dictionary<string, object>>(table)
                    .AnyAsync(r => EF.Property<string>(r, "rootId") == id, ct)) return false;
            var entity = await db.Set<Dictionary<string, object>>("StorageRoot")
                .SingleOrDefaultAsync(r => EF.Property<string>(r, "id") == id, ct);
            if (entity is null || (long)entity["version"] != expectedVersion) return false;
            var rootPath = (string)entity["path"];
            var operations = await ReadAsync<FileOperationRow>(null, ct);
            bool Inside(string? path) => path is not null && (path.Equals(rootPath, StringComparison.OrdinalIgnoreCase) ||
                path.StartsWith(rootPath.TrimEnd('\\', '/') + System.IO.Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase));
            if (operations.Any(o => o.State is not FileOperationState.Done and not FileOperationState.Superseded &&
                (Inside(o.SourcePath) || Inside(o.DestinationPath)))) return false;
            db.Set<Dictionary<string, object>>("StorageRoot").Remove(entity);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        catch (DbUpdateConcurrencyException) { return false; }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 }) { return false; }
        finally { db.ChangeTracker.Clear(); }
    }

    public async Task<bool> RecordAsync(MediaFileRow file, WorkFolderRow? folder, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            var work = await db.Set<Dictionary<string, object>>("Work").AsNoTracking()
                .SingleOrDefaultAsync(r => EF.Property<string>(r, "id") == file.WorkId, ct);
            if (work is null || (string)work["kind"] == "unknown" ||
                ((string)work["kind"] == "film") != (file.EpisodeId is null)) return false;
            if (file.EpisodeId is not null)
            {
                var episode = await db.Set<Dictionary<string, object>>("Episode").AsNoTracking()
                    .SingleOrDefaultAsync(r => EF.Property<string>(r, "id") == file.EpisodeId, ct);
                if (episode is null) return false;
                var seasonId = (string)episode["seasonId"];
                if (!await db.Set<Dictionary<string, object>>("Season").AnyAsync(r =>
                    EF.Property<string>(r, "id") == seasonId && EF.Property<string>(r, "workId") == file.WorkId, ct)) return false;
            }
            if (!await StageAsync(file, file.Version == 1 ? null : file.Version - 1, ct)) return false;
            if (folder is not null && !await StageAsync(folder, folder.Version == 1 ? null : folder.Version - 1, ct))
                return false;
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        catch (DbUpdateConcurrencyException) { return false; }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 }) { return false; }
        finally { db.ChangeTracker.Clear(); }
    }

    public async Task<bool> SaveRootCheckAsync(StorageRootRow root, long expectedVersion,
        ImmutableArray<MediaFileRow> media, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            if (!await StageAsync(root, expectedVersion, ct)) return false;
            foreach (var file in media)
                if (file.RootId != root.Id || !await StageAsync(file, file.Version - 1, ct)) return false;
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        catch (DbUpdateConcurrencyException) { return false; }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 }) { return false; }
        finally { db.ChangeTracker.Clear(); }
    }

    private async Task<bool> StageAsync(StoreRow row, long? expectedVersion, CancellationToken ct)
    {
        var table = Schema.Table(row.GetType());
        var set = db.Set<Dictionary<string, object>>(table.Name);
        var entity = await set.SingleOrDefaultAsync(r => EF.Property<string>(r, table.Key) == row.Id, ct);
        if (entity is null)
        {
            if (expectedVersion is not null) return false;
            set.Add(table.ToEntity(row));
        }
        else
        {
            if (expectedVersion is null || (long)entity["version"] != expectedVersion) return false;
            db.Entry(entity).CurrentValues.SetValues(table.ToEntity(row));
        }
        return true;
    }

    public async Task<int> PruneMissingAsync(DateTimeOffset before, CancellationToken ct)
    {
        // FK restrictions protect history/operations still referring to an inventory row.
        var rows = await ReadAsync<MediaFileRow>(null, ct);
        var roots = await RootsAsync(ct);
        var dropped = 0;
        foreach (var row in rows.Where(m => m.Status == FilePresence.Missing &&
                     m.MissingConfirmedAt is { } at && at <= before &&
                     (m.RootId is null || roots.Any(r => r.Id == m.RootId && r.Online && !r.ReviewRequired))))
        {
            if (rows.Any(m => m.ParentMediaFileId == row.Id)) continue;
            try
            {
                var entity = Schema.Table(typeof(MediaFileRow)).ToEntity(row);
                db.Set<Dictionary<string, object>>("MediaFile").Attach(entity);
                db.Set<Dictionary<string, object>>("MediaFile").Remove(entity);
                await db.SaveChangesAsync(ct);
                dropped++;
            }
            catch (DbUpdateConcurrencyException) { }
            catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 }) { }
            finally { db.ChangeTracker.Clear(); }
        }
        return dropped;
    }

    public static async Task<LegacyLibrarySettings?> ReadLegacySettingsAsync(string databasePath, CancellationToken ct)
    {
        await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = databasePath, Mode = SqliteOpenMode.ReadOnly, Pooling = false,
        }.ToString());
        await connection.OpenAsync(ct);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT baseDownloadPath,pathRules,maxStorageBytes FROM ClientSettings ORDER BY createdAt LIMIT 1";
        await using var reader = await command.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct) || reader.IsDBNull(0) || string.IsNullOrWhiteSpace(reader.GetString(0))) return null;
        var rules = reader.IsDBNull(1) ? ImmutableDictionary<string, string>.Empty :
            System.Text.Json.JsonSerializer.Deserialize<ImmutableDictionary<string, string>>(reader.GetString(1))!;
        return new(reader.GetString(0), rules, reader.IsDBNull(2) ? null : reader.GetInt64(2));
    }
}
