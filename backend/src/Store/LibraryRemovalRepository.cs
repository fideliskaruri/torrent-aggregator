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
                var table = Schema.Table(write.Row.GetType());
                var row = await db.Set<Dictionary<string, object>>(table.Name)
                    .SingleAsync(r => EF.Property<string>(r, table.Key) == write.Row.Id, ct);
                db.Entry(row).CurrentValues.SetValues(table.ToEntity(write.Row));
            }
            foreach (var delete in proposal.Deletes)
            {
                var table = Schema.Table(delete.Table.ToString());
                var row = await db.Set<Dictionary<string, object>>(table.Name)
                    .SingleAsync(r => EF.Property<string>(r, table.Key) == delete.Id, ct);
                db.Set<Dictionary<string, object>>(table.Name).Remove(row);
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
            var table = Schema.Table(file.GetType());
            var row = await db.Set<Dictionary<string, object>>(table.Name).AsNoTracking()
                .SingleOrDefaultAsync(r => EF.Property<string>(r, table.Key) == file.Id, ct);
            if (row is null || !Matches(table.Name, row, file)) return null;
            var replacement = file is DownloadFileRow ? replacements.SingleOrDefault(f => f.Id == file.Id) : null;
            if (replacement is not null) writes.Add(new(replacement, null, file));
            else deletes.Add(new(Enum.Parse<StoreTable>(table.Name), file.Id, null, file));
        }
        var operations = await db.Set<Dictionary<string, object>>("FileOperation").AsNoTracking().ToListAsync(ct);
        foreach (var row in operations.Where(o => files.Any(f => (string)o["id"] == $"file:{f.Id}") ||
            media.Any(m => Equals(o.GetValueOrDefault("mediaFileId"), m.Id))))
        {
            var operation = (FileOperationRow)Schema.Table("FileOperation").ToRow(row);
            if (operation.State != FileOperationState.Done) return null;
            var claims = await db.Set<Dictionary<string, object>>("FilePathClaim").AsNoTracking()
                .Where(r => EF.Property<string>(r, "operationId") == operation.Id).ToListAsync(ct);
            deletes.AddRange(claims.Select(c => (FilePathClaimRow)Schema.Table("FilePathClaim").ToRow(c))
                .Select(c => new RowDelete(StoreTable.FilePathClaim, c.Id, null, c)));
            deletes.Add(new(StoreTable.FileOperation, operation.Id, null, operation));
        }
        return new(writes.ToImmutable(), deletes.ToImmutable());
    }

    private static bool Matches(string table, Dictionary<string, object> row, StoreRow expected) =>
        JsonSerializer.Serialize(Schema.Table(table).ToRow(row), expected.GetType(), Schema.Json) ==
        JsonSerializer.Serialize(expected, expected.GetType(), Schema.Json);
}

internal sealed class RemovalWriteProposal(ImmutableArray<RowWrite> writes, ImmutableArray<RowDelete> deletes)
    : LibraryTransactionProposal(writes, deletes);
