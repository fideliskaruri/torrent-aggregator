using System.Collections.Immutable;
using System.Text.Json;
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
            var proposal = await RemovalAsync(files, media, replacements, ct);
            if (proposal is null) return false;
            foreach (var write in proposal.Writes)
            {
                var row = await db.FindAsync(write.Row.GetType(), [write.Row.Id], ct) as StoreRow
                    ?? throw new InvalidOperationException($"Missing {write.Row.GetType().Name} {write.Row.Id}.");
                db.Entry(row).CurrentValues.SetValues(write.Row);
            }
            foreach (var delete in proposal.Deletes)
            {
                var type = db.Model.GetEntityTypes().Single(entity => entity.GetTableName() == delete.Table.ToString()).ClrType;
                var row = await db.FindAsync(type, [delete.Id], ct) as StoreRow
                    ?? throw new InvalidOperationException($"Missing {delete.Table} {delete.Id}.");
                db.Remove(row);
            }
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        finally { db.ChangeTracker.Clear(); }
    }

    public async Task<LibraryWriteProposal?> ProposeRemovalAsync(ImmutableArray<DownloadFileRow> files,
        ImmutableArray<MediaFileRow> media, ImmutableArray<DownloadFileRow> replacements, CancellationToken ct)
    {
        try { return await RemovalAsync(files, media, replacements, ct); }
        finally { db.ChangeTracker.Clear(); }
    }

    private async Task<RemovalWriteProposal?> RemovalAsync(ImmutableArray<DownloadFileRow> files,
        ImmutableArray<MediaFileRow> media, ImmutableArray<DownloadFileRow> replacements, CancellationToken ct)
    {
        var writes = ImmutableArray.CreateBuilder<RowWrite>();
        var deletes = ImmutableArray.CreateBuilder<RowDelete>();
        foreach (var file in files.Cast<StoreRow>().Concat(media))
        {
            StoreRow? row = file switch
            {
                DownloadFileRow binding => await db.DownloadFiles.AsNoTracking()
                    .SingleOrDefaultAsync(value => value.Id == binding.Id, ct),
                MediaFileRow mediaFile => await db.MediaFiles.AsNoTracking()
                    .SingleOrDefaultAsync(value => value.Id == mediaFile.Id, ct),
                _ => null,
            };
            if (row is null || !Matches(row, file)) return null;
            var replacement = file is DownloadFileRow ? replacements.SingleOrDefault(f => f.Id == file.Id) : null;
            if (replacement is not null) writes.Add(new(replacement, null, file));
            else deletes.Add(new(Enum.Parse<StoreTable>(file.GetType().Name[..^3]), file.Id, null, file));
        }
        var operations = await db.FileOperations.AsNoTracking().ToListAsync(ct);
        foreach (var operation in operations.Where(o => files.Any(f => o.Id == $"file:{f.Id}") ||
            media.Any(m => o.MediaFileId == m.Id)))
        {
            if (operation.State != FileOperationState.Done) return null;
            var claims = await db.FilePathClaims.AsNoTracking()
                .Where(row => row.OperationId == operation.Id).ToListAsync(ct);
            deletes.AddRange(claims.Select(claim => new RowDelete(StoreTable.FilePathClaim, claim.Id, null, claim)));
            deletes.Add(new(StoreTable.FileOperation, operation.Id, null, operation));
        }
        return new(writes.ToImmutable(), deletes.ToImmutable());
    }

    private static bool Matches(StoreRow row, StoreRow expected) =>
        JsonSerializer.Serialize(row, row.GetType(), StoreJson.Options) ==
        JsonSerializer.Serialize(expected, expected.GetType(), StoreJson.Options);
}

internal sealed class RemovalWriteProposal(ImmutableArray<RowWrite> writes, ImmutableArray<RowDelete> deletes)
    : LibraryTransactionProposal(writes, deletes);
