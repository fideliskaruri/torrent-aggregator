using System.Collections.Immutable;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

public sealed partial class LibraryRepository : ILibraryDownloadRepository
{
    private readonly TorrentFlowDbContext db;
    internal LibraryRepository(TorrentFlowDbContext db) => this.db = db;

    public async Task<ImmutableArray<StorageRootRow>> RootsAsync(CancellationToken ct) =>
        [.. await db.StorageRoots.AsNoTracking().OrderBy(row => row.Id).ToListAsync(ct)];

    public async Task<ImmutableArray<MediaFileRow>> MediaAsync(string? workId, CancellationToken ct) =>
        [.. await db.MediaFiles.AsNoTracking().Where(row => workId == null || row.WorkId == workId)
            .OrderBy(row => row.Id).ToListAsync(ct)];

    public async Task<ImmutableArray<WorkFolderRow>> FoldersAsync(CancellationToken ct) =>
        [.. await db.WorkFolders.AsNoTracking().OrderBy(row => row.Id).ToListAsync(ct)];

    public async Task<ImmutableArray<DownloadFileRow>> BindingsAsync(CancellationToken ct) =>
        [.. await db.DownloadFiles.AsNoTracking().OrderBy(row => row.Id).ToListAsync(ct)];

    public Task<DownloadRow?> DownloadAsync(string hash, CancellationToken ct) =>
        db.Downloads.AsNoTracking().SingleOrDefaultAsync(row => row.Hash == hash, ct);

    public async Task<ImmutableDictionary<string, long>> ReservationsAsync(CancellationToken ct)
    {
        var downloads = await db.Downloads.AsNoTracking().Where(row => row.RootId != null)
            .Select(row => new { row.Id, RootId = row.RootId! }).ToListAsync(ct);
        var files = await db.DownloadFiles.AsNoTracking().Where(row => row.Selected && !row.Filed).ToListAsync(ct);
        return downloads.GroupBy(d => d.RootId).ToImmutableDictionary(g => g.Key,
            g => files.Where(f => g.Any(d => d.Id == f.DownloadId)).Sum(f => f.ExpectedBytes));
    }

    public async Task<bool> SaveRootAsync(StorageRootRow root, long? expectedVersion, CancellationToken ct)
    {
        try
        {
            if (expectedVersion is null) db.StorageRoots.Add(root);
            else db.StorageRoots.Update(root).Property(row => row.Version).OriginalValue = expectedVersion.Value;
            await db.SaveChangesAsync(ct);
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
            if (await db.MediaFiles.AnyAsync(row => row.RootId == id, ct) ||
                await db.WorkFolders.AnyAsync(row => row.RootId == id, ct) ||
                await db.Downloads.AnyAsync(row => row.RootId == id, ct) ||
                await db.RawIntents.AnyAsync(row => row.RootId == id, ct)) return false;
            var entity = await db.StorageRoots.SingleOrDefaultAsync(row => row.Id == id, ct);
            if (entity is null || entity.Version != expectedVersion) return false;
            var rootPath = entity.Path;
            var operations = await db.FileOperations.AsNoTracking().Where(row =>
                row.State != FileOperationState.Done && row.State != FileOperationState.Superseded).ToListAsync(ct);
            bool Inside(string? path) => path is not null && (path.Equals(rootPath, StringComparison.OrdinalIgnoreCase) ||
                path.StartsWith(rootPath.TrimEnd('\\', '/') + System.IO.Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase));
            if (operations.Any(o => Inside(o.SourcePath) || Inside(o.DestinationPath))) return false;
            db.StorageRoots.Remove(entity);
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
            var work = await db.Works.AsNoTracking().SingleOrDefaultAsync(row => row.Id == file.WorkId, ct);
            if (work is null || work.Kind == WorkKind.Unknown ||
                (work.Kind == WorkKind.Film) != (file.EpisodeId is null)) return false;
            if (file.EpisodeId is not null)
            {
                var episode = await db.Episodes.AsNoTracking()
                    .SingleOrDefaultAsync(row => row.Id == file.EpisodeId, ct);
                if (episode is null) return false;
                if (!await db.Seasons.AnyAsync(row =>
                    row.Id == episode.SeasonId && row.WorkId == file.WorkId, ct)) return false;
            }
            if (file.Version == 1) db.MediaFiles.Add(file);
            else db.MediaFiles.Update(file).Property(row => row.Version).OriginalValue = file.Version - 1;
            if (folder is { Version: 1 }) db.WorkFolders.Add(folder);
            else if (folder is not null)
                db.WorkFolders.Update(folder).Property(row => row.Version).OriginalValue = folder.Version - 1;
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
        if (media.Any(file => file.RootId != root.Id)) return false;
        try
        {
            db.StorageRoots.Update(root).Property(row => row.Version).OriginalValue = expectedVersion;
            foreach (var file in media)
                db.MediaFiles.Update(file).Property(row => row.Version).OriginalValue = file.Version - 1;
            await db.SaveChangesAsync(ct);
            return true;
        }
        catch (DbUpdateConcurrencyException) { return false; }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 }) { return false; }
        finally { db.ChangeTracker.Clear(); }
    }

    public async Task<int> PruneMissingAsync(DateTimeOffset before, CancellationToken ct)
    {
        // FK restrictions protect history/operations still referring to an inventory row.
        var rows = await MediaAsync(null, ct);
        var roots = await RootsAsync(ct);
        var dropped = 0;
        foreach (var row in rows.Where(m => m.Status == FilePresence.Missing &&
                     m.MissingConfirmedAt is { } at && at <= before &&
                     (m.RootId is null || roots.Any(r => r.Id == m.RootId && r.Online && !r.ReviewRequired))))
        {
            if (rows.Any(m => m.ParentMediaFileId == row.Id)) continue;
            try
            {
                db.MediaFiles.Attach(row);
                db.MediaFiles.Remove(row);
                await db.SaveChangesAsync(ct);
                dropped++;
            }
            catch (DbUpdateConcurrencyException) { }
            catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 }) { }
            finally { db.ChangeTracker.Clear(); }
        }
        return dropped;
    }
}
