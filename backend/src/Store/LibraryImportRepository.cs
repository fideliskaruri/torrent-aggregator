using System.Collections.Immutable;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

public sealed partial class LibraryRepository : ILibraryImportRepository
{
    public async Task<ImmutableArray<FileOperationRow>> ImportOperationsAsync(CancellationToken ct) =>
        [.. (await ReadAsync<FileOperationRow>(null, ct)).Where(o => o.Id.StartsWith("import:", StringComparison.Ordinal))];

    public async Task<FileOperationRow?> ImportOperationAsync(string id, CancellationToken ct) =>
        (await ReadAsync<FileOperationRow>(null, ct)).SingleOrDefault(o => o.Id == id);

    public async Task<bool> ClaimImportAsync(FileOperationRow operation, ImmutableArray<string> paths, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            db.Set<Dictionary<string, object>>("FileOperation").Add(Schema.Table(typeof(FileOperationRow)).ToEntity(operation));
            foreach (var path in paths.Distinct())
                db.Set<Dictionary<string, object>>("FilePathClaim").Add(Schema.Table(typeof(FilePathClaimRow))
                    .ToEntity(new FilePathClaimRow(Guid.NewGuid().ToString("N"), operation.Id, path, operation.CreatedAt)));
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 })
        { return false; }
        finally { db.ChangeTracker.Clear(); }
    }

    public async Task SaveImportOperationAsync(FileOperationRow operation, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        await UpdateOperationAsync(operation, ct);
        if (operation.State == FileOperationState.Done)
        {
            var claims = await db.Set<Dictionary<string, object>>("FilePathClaim")
                .Where(r => EF.Property<string>(r, "operationId") == operation.Id).ToListAsync(ct);
            db.RemoveRange(claims);
        }
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        db.ChangeTracker.Clear();
    }

    private async Task UpdateOperationAsync(FileOperationRow operation, CancellationToken ct)
    {
        var entity = await db.Set<Dictionary<string, object>>("FileOperation")
            .SingleAsync(r => EF.Property<string>(r, "id") == operation.Id, ct);
        db.Entry(entity).CurrentValues.SetValues(Schema.Table(typeof(FileOperationRow)).ToEntity(operation));
    }

    public async Task<bool> CommitImportAsync(ImmutableArray<MediaFileRow> media, WorkFolderRow? folder,
        ImmutableArray<FileOperationRow> operations, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            foreach (var file in media)
                if (!await StageAsync(file, null, ct)) return false;
            if (folder is not null && !(await FoldersAsync(ct)).Any(f => f.WorkId == folder.WorkId) &&
                !await StageAsync(folder, null, ct)) return false;
            foreach (var operation in operations) await UpdateOperationAsync(operation, ct);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 })
        { return false; }
        finally { db.ChangeTracker.Clear(); }
    }
}
