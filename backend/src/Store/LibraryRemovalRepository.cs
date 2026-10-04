using System.Collections.Immutable;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

public sealed partial class LibraryRepository
{
    public async Task<bool> RemoveLibraryFilesAsync(ImmutableArray<DownloadFileRow> files,
        ImmutableArray<MediaFileRow> media, ImmutableArray<DownloadFileRow> replacements, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            foreach (var file in files)
            {
                var current = await db.DownloadFiles.SingleOrDefaultAsync(row => row.Id == file.Id, ct);
                if (current is null || current != file) return false;
                var replacement = replacements.SingleOrDefault(row => row.Id == file.Id);
                if (replacement is not null) db.Entry(current).CurrentValues.SetValues(replacement);
                else db.DownloadFiles.Remove(current);
            }
            // Version is a concurrency token, so a media row that changed or vanished fails the delete.
            db.MediaFiles.RemoveRange(media);
            var operationIds = files.Select(file => $"file:{file.Id}").ToArray();
            var mediaIds = media.Select(file => file.Id).ToArray();
            var operations = await db.FileOperations.Where(row => operationIds.Contains(row.Id) ||
                (row.MediaFileId != null && mediaIds.Contains(row.MediaFileId))).ToListAsync(ct);
            if (operations.Any(operation => operation.State != FileOperationState.Done)) return false;
            var claimed = operations.Select(operation => operation.Id).ToArray();
            db.FilePathClaims.RemoveRange(
                await db.FilePathClaims.Where(row => claimed.Contains(row.OperationId)).ToListAsync(ct));
            db.FileOperations.RemoveRange(operations);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        catch (DbUpdateConcurrencyException) { return false; }
        finally { db.ChangeTracker.Clear(); }
    }
}