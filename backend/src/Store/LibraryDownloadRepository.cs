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
        return new PlacementWriteProposal([.. files.Select(f => new RowWrite(f, null, null))], reviewId, reviewItemIds);
    }

    public async Task<ImmutableArray<FileOperationRow>> FilingOperationsAsync(CancellationToken ct) =>
        [.. await db.FileOperations.AsNoTracking().OrderBy(row => row.Id).ToListAsync(ct)];

    public async Task<bool> BeginFilingAsync(DownloadFileRow binding, string digest, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            var id = $"file:{binding.Id}";
            var existing = await db.FileOperations.AsNoTracking().SingleOrDefaultAsync(row => row.Id == id, ct);
            if (existing is not null) return existing.ExpectedDigest == digest;
            var now = DateTimeOffset.UtcNow;
            db.FileOperations.Add(new FileOperationRow { Id = id, Kind = FileOperationKind.Rename, TargetId = binding.TargetId, DownloadId = binding.DownloadId, MediaFileId = null, SourcePath = binding.PartialPath, DestinationPath = binding.FinalPath, ExpectedBytes = binding.ExpectedBytes, ExpectedDigest = digest, State = FileOperationState.Pending, DeleteSource = false, Attempts = 0, NextTryAt = null, LastError = null, CreatedAt = now, UpdatedAt = now, LeaseToken = null, LeaseUntil = null, ResumeStage = null, EnginePermitToken = null });
            var paths = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (label, path) in new[] { ("source", binding.PartialPath!), ("destination", binding.FinalPath!) })
            {
                var key = System.IO.Path.GetFullPath(path);
                if (OperatingSystem.IsWindows()) key = key.ToLowerInvariant();
                if (!paths.Add(key)) continue;
                db.FilePathClaims.Add(new FilePathClaimRow { Id = id + ":" + label, OperationId = id, PhysicalKey = key, CreatedAt = now });
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
            db.DownloadFiles.AddRange(files);
            foreach (var folder in folders)
                if (!await db.WorkFolders.AnyAsync(row => row.Id == folder.Id, ct)) db.WorkFolders.Add(folder);
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
            var entity = await db.DownloadFiles.SingleOrDefaultAsync(row => row.Id == before.Id, ct);
            if (entity is null || entity != before) return false;
            db.MediaFiles.Add(media);
            db.Entry(entity).CurrentValues.SetValues(after);
            var operation = await db.FileOperations.SingleAsync(row => row.Id == $"file:{before.Id}", ct);
            db.Entry(operation).CurrentValues.SetValues(operation with
            {
                State = FileOperationState.Done, MediaFileId = media.Id, UpdatedAt = DateTimeOffset.UtcNow,
            });
            var claims = await db.FilePathClaims.Where(row => row.OperationId == operation.Id).ToListAsync(ct);
            db.FilePathClaims.RemoveRange(claims);
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
        var current = await db.DownloadFiles.AsNoTracking().SingleOrDefaultAsync(row => row.Id == before.Id, ct);
        if (current != before) return null;
        var operation = await db.FileOperations.AsNoTracking()
            .SingleOrDefaultAsync(row => row.Id == $"file:{before.Id}", ct);
        if (operation is null || operation.State != FileOperationState.Pending ||
            operation.ExpectedDigest != media.ContentDigest) return null;
        var claims = await db.FilePathClaims.AsNoTracking()
            .Where(row => row.OperationId == operation.Id).ToListAsync(ct);
        var prior = await db.MediaFiles.AsNoTracking().SingleOrDefaultAsync(row => row.PhysicalKey == media.PhysicalKey, ct);
        if (prior is not null)
        {
            if (prior.ContentDigest != media.ContentDigest ||
                prior.WorkId != media.WorkId || prior.EpisodeId != media.EpisodeId)
                throw new IOException("The previous library file differs from this download. Review the existing file.");
            media = media with { Id = prior.Id, Version = prior.Version + 1 };
            after = after with { MediaFileId = prior.Id };
        }
        return new FilingWriteProposal(
            [new(after, null, before), new(media, prior?.Version, null),
             new(operation with { State = FileOperationState.Done, MediaFileId = media.Id,
                 UpdatedAt = DateTimeOffset.UtcNow }, null, operation)],
            [.. claims.Select(row => new RowDelete(StoreTable.FilePathClaim, row.Id, null, row))]);
    }

    public async Task<bool> RemoveDownloadFilesAsync(string downloadId, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            var operations = await db.FileOperations
                .Where(row => row.DownloadId == downloadId).ToListAsync(ct);
            foreach (var operation in operations)
            {
                var claims = await db.FilePathClaims
                    .Where(row => row.OperationId == operation.Id).ToListAsync(ct);
                db.FilePathClaims.RemoveRange(claims);
            }
            db.FileOperations.RemoveRange(operations);
            await db.SaveChangesAsync(ct);
            var bindings = await db.DownloadFiles.Where(row => row.DownloadId == downloadId).ToListAsync(ct);
            db.DownloadFiles.RemoveRange(bindings);
            await db.SaveChangesAsync(ct);
            var media = await db.MediaFiles.Where(row => row.DownloadId == downloadId).ToListAsync(ct);
            db.MediaFiles.RemoveRange(media);
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

internal sealed class FilingWriteProposal(ImmutableArray<RowWrite> writes, ImmutableArray<RowDelete> deletes)
    : LibraryTransactionProposal(writes, deletes);

internal sealed class PlacementWriteProposal(ImmutableArray<RowWrite> writes, string? reviewId,
    ImmutableArray<string> reviewItemIds)
    : LibraryTransactionProposal(writes, [])
{
    internal string? ReviewId { get; } = reviewId;
    internal ImmutableArray<string> ReviewItemIds { get; } = reviewItemIds;
}
