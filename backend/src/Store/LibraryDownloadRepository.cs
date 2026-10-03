using System.Collections.Immutable;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

public sealed partial class LibraryRepository
{
    public Task<ImmutableArray<FileOperationRow>> FilingOperationsAsync(CancellationToken ct) =>
        ReadAsync<FileOperationRow>(null, ct);

    public async Task<bool> BeginFilingAsync(DownloadFileRow binding, string digest, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            var id = $"file:{binding.Id}";
            var existing = (await FilingOperationsAsync(ct)).SingleOrDefault(o => o.Id == id);
            if (existing is not null) return existing.ExpectedDigest == digest;
            var now = DateTimeOffset.UtcNow;
            var operation = new FileOperationRow(id, FileOperationKind.Rename, binding.TargetId, binding.DownloadId,
                null, binding.PartialPath, binding.FinalPath, binding.ExpectedBytes, digest,
                FileOperationState.Pending, false, 0, null, null, now, now, null, null, null, null);
            if (!await StageAsync(operation, null, ct)) return false;
            foreach (var (label, path) in new[] { ("source", binding.PartialPath!), ("destination", binding.FinalPath!) })
            {
                var key = System.IO.Path.GetFullPath(path);
                if (OperatingSystem.IsWindows()) key = key.ToLowerInvariant();
                if (!await StageAsync(new FilePathClaimRow(id + ":" + label, id, key, now), null, ct)) return false;
            }
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 })
        { return false; }
        finally { db.ChangeTracker.Clear(); }
    }

    public async Task<bool> SavePlacementAsync(ImmutableArray<DownloadFileRow> files,
        ImmutableArray<WorkFolderRow> folders, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            foreach (var file in files)
                if (!await StageAsync(file, null, ct)) return false;
            foreach (var folder in folders)
                if (!(await FoldersAsync(ct)).Any(f => f.Id == folder.Id) &&
                    !await StageAsync(folder, null, ct)) return false;
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 })
        { return false; }
        finally { db.ChangeTracker.Clear(); }
    }

    public async Task<bool> CommitFiledAsync(DownloadFileRow before, DownloadFileRow after,
        MediaFileRow media, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            var entity = await db.Set<Dictionary<string, object>>("DownloadFile")
                .SingleOrDefaultAsync(r => EF.Property<string>(r, "id") == before.Id, ct);
            if (entity is null || Schema.Table("DownloadFile").ToRow(entity) != before) return false;
            if (!await StageAsync(media, null, ct)) return false;
            db.Entry(entity).CurrentValues.SetValues(Schema.Table("DownloadFile").ToEntity(after));
            var operationEntity = await db.Set<Dictionary<string, object>>("FileOperation")
                .SingleAsync(r => EF.Property<string>(r, "id") == $"file:{before.Id}", ct);
            var operation = (FileOperationRow)Schema.Table("FileOperation").ToRow(operationEntity);
            db.Entry(operationEntity).CurrentValues.SetValues(Schema.Table("FileOperation").ToEntity(operation with
            {
                State = FileOperationState.Done, MediaFileId = media.Id, UpdatedAt = DateTimeOffset.UtcNow,
            }));
            var claims = await db.Set<Dictionary<string, object>>("FilePathClaim")
                .Where(r => EF.Property<string>(r, "operationId") == operation.Id).ToListAsync(ct);
            db.Set<Dictionary<string, object>>("FilePathClaim").RemoveRange(claims);
            // Ownership and item completion commit together, including selected sidecars.
            var siblings = await db.Set<Dictionary<string, object>>("DownloadFile").AsNoTracking()
                .Where(r => EF.Property<string>(r, "targetId") == before.TargetId).ToListAsync(ct);
            if (siblings.All(r => (string)r["id"] == before.Id || (bool)r["filed"]))
            {
                var targetEntity = await db.Set<Dictionary<string, object>>("Target")
                    .SingleAsync(r => EF.Property<string>(r, "id") == before.TargetId, ct);
                var target = (TargetRow)Schema.Table("Target").ToRow(targetEntity);
                db.Entry(targetEntity).CurrentValues.SetValues(Schema.Table("Target").ToEntity(target with
                {
                    State = TargetState.Done, UpdatedAt = DateTimeOffset.UtcNow, Version = target.Version + 1,
                }));
            }
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 })
        { return false; }
        finally { db.ChangeTracker.Clear(); }
    }

    public async Task<bool> RemoveDownloadFilesAsync(string downloadId, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            var operations = await db.Set<Dictionary<string, object>>("FileOperation")
                .Where(r => EF.Property<string>(r, "downloadId") == downloadId).ToListAsync(ct);
            foreach (var operation in operations)
            {
                var id = (string)operation["id"];
                var claims = await db.Set<Dictionary<string, object>>("FilePathClaim")
                    .Where(r => EF.Property<string>(r, "operationId") == id).ToListAsync(ct);
                db.Set<Dictionary<string, object>>("FilePathClaim").RemoveRange(claims);
            }
            db.Set<Dictionary<string, object>>("FileOperation").RemoveRange(operations);
            await db.SaveChangesAsync(ct);
            var bindings = await db.Set<Dictionary<string, object>>("DownloadFile")
                .Where(r => EF.Property<string>(r, "downloadId") == downloadId).ToListAsync(ct);
            db.Set<Dictionary<string, object>>("DownloadFile").RemoveRange(bindings);
            await db.SaveChangesAsync(ct);
            var media = await db.Set<Dictionary<string, object>>("MediaFile")
                .Where(r => EF.Property<string>(r, "downloadId") == downloadId).ToListAsync(ct);
            db.Set<Dictionary<string, object>>("MediaFile").RemoveRange(media);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 })
        { return false; }
        finally { db.ChangeTracker.Clear(); }
    }
}
