using System.Collections.Immutable;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

public interface ILibraryPlacementProposalRepository
{
    Task<LibraryWriteProposal?> ProposeExternalPlacementAsync(ImmutableArray<DownloadFileRow> files,
        string? reviewId, ImmutableArray<string> reviewItemIds, CancellationToken ct);
}

public sealed partial class LibraryRepository : ILibraryPlacementProposalRepository
{
    public async Task<LibraryWriteProposal?> ProposeExternalPlacementAsync(ImmutableArray<DownloadFileRow> files,
        string? reviewId, ImmutableArray<string> reviewItemIds, CancellationToken ct)
    {
        if (files.IsDefaultOrEmpty || files.Select(f => f.DownloadId).Distinct().Count() != 1 ||
            files.Select(f => f.FileIndex).Distinct().Count() != files.Length ||
            files.Select(f => f.PhysicalKey).Distinct().Count() != files.Length ||
            files.Any(f => f.Filed || f.MediaFileId is not null || f.EnginePath is null ||
                !System.IO.Path.IsPathFullyQualified(f.EnginePath) || f.Selected &&
                (f.TargetId is null || f.PartialPath != f.EnginePath || f.FinalPath != f.EnginePath)))
            throw new ArgumentException("External bindings must reserve their exact original paths before admission.");
        var existing = await BindingsAsync(ct);
        if (files.Any(f => existing.Any(b => b.Id == f.Id || b.PhysicalKey == f.PhysicalKey))) return null;
        if (reviewId is not null)
        {
            var review = await new ImportReviewRepository(db).GetAsync(reviewId, ct);
            if (review is null || reviewItemIds.IsDefaultOrEmpty ||
                reviewItemIds.Distinct().Count() != reviewItemIds.Length ||
                reviewItemIds.Any(id => !review.Items.Any(i => i.Id == id &&
                    files.Any(f => f.Selected && f.EnginePath == i.Path))) ||
                files.Any(f => f.Selected && !review.Items.Any(i => reviewItemIds.Contains(i.Id) && i.Path == f.EnginePath)))
                throw new ArgumentException("The confirmed Import files no longer match this transfer. Review it again.");
        }
        return new PlacementWriteProposal(files[0].DownloadId,
            [.. files.Where(f => f.Selected).Select(f => f.TargetId!).Distinct()],
            [.. files.Select(f => new RowWrite(f, null, null))], reviewId, reviewItemIds);
    }

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
            var paths = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (label, path) in new[] { ("source", binding.PartialPath!), ("destination", binding.FinalPath!) })
            {
                var key = System.IO.Path.GetFullPath(path);
                if (OperatingSystem.IsWindows()) key = key.ToLowerInvariant();
                if (!paths.Add(key)) continue;
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
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }

        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 })
        { return false; }
        finally { db.ChangeTracker.Clear(); }
    }

    public async Task<LibraryWriteProposal?> ProposeFiledAsync(DownloadFileRow before, DownloadFileRow after,
        MediaFileRow media, CancellationToken ct)
    {
        if (before.Filed || !before.Selected || before.FinalPath != media.Path ||
            before.DownloadId != media.DownloadId || before.FileIndex != media.FileIndex ||
            before.ExpectedBytes != media.Bytes || after != before with
            { EnginePath = before.FinalPath, PartialPath = null, Selected = false, Filed = true, MediaFileId = media.Id })
            throw new ArgumentException("The filing result does not match its reserved file.");
        if (!(await BindingsAsync(ct)).Contains(before)) return null;
        var operation = (await FilingOperationsAsync(ct)).SingleOrDefault(o => o.Id == $"file:{before.Id}");
        if (operation is null || operation.State != FileOperationState.Pending ||
            operation.ExpectedDigest != media.ContentDigest) return null;
        var claims = await db.Set<Dictionary<string, object>>("FilePathClaim").AsNoTracking()
            .Where(r => EF.Property<string>(r, "operationId") == operation.Id).ToListAsync(ct);
        var prior = (await MediaAsync(null, ct)).SingleOrDefault(m => m.PhysicalKey == media.PhysicalKey);
        if (prior is not null)
        {
            if (prior.PhysicalKey != media.PhysicalKey || prior.ContentDigest != media.ContentDigest ||
                prior.WorkId != media.WorkId || prior.EpisodeId != media.EpisodeId)
                throw new IOException("The previous library file differs from this download. Review the existing file.");
            media = media with { Id = prior.Id, Version = prior.Version + 1 };
            after = after with { MediaFileId = prior.Id };
        }
        return new FilingWriteProposal(before.TargetId,
            [new(after, null, before), new(media, prior?.Version, null),
             new(operation with { State = FileOperationState.Done, MediaFileId = media.Id,
                 UpdatedAt = DateTimeOffset.UtcNow }, null, operation)],
            [.. claims.Select(r => new RowDelete(StoreTable.FilePathClaim, (string)r["id"], null,
                Schema.Table("FilePathClaim").ToRow(r)))]);
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

internal abstract class LibraryTransactionProposal(ImmutableArray<RowWrite> writes, ImmutableArray<RowDelete> deletes)
    : LibraryWriteProposal
{
    internal ImmutableArray<RowWrite> Writes { get; } = writes;
    internal ImmutableArray<RowDelete> Deletes { get; } = deletes;
}

internal sealed class FilingWriteProposal(string? targetId, ImmutableArray<RowWrite> writes, ImmutableArray<RowDelete> deletes)
    : LibraryTransactionProposal(writes, deletes)
{
    internal string? TargetId { get; } = targetId;
}

internal sealed class PlacementWriteProposal(string downloadId, ImmutableArray<string> targetIds, ImmutableArray<RowWrite> writes,
    string? reviewId, ImmutableArray<string> reviewItemIds)
    : LibraryTransactionProposal(writes, [])
{
    internal string DownloadId { get; } = downloadId;
    internal ImmutableArray<string> TargetIds { get; } = targetIds;
    internal string? ReviewId { get; } = reviewId;
    internal ImmutableArray<string> ReviewItemIds { get; } = reviewItemIds;
}
