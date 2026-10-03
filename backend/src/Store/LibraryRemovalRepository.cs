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
            var bindings = db.Set<Dictionary<string, object>>("DownloadFile");
            var inventory = db.Set<Dictionary<string, object>>("MediaFile");
            var bindingRows = new List<Dictionary<string, object>>();
            var mediaRows = new List<Dictionary<string, object>>();
            foreach (var file in files)
            {
                var row = await bindings.SingleOrDefaultAsync(r => EF.Property<string>(r, "id") == file.Id, ct);
                if (row is null || !Matches("DownloadFile", row, file)) return false;
                bindingRows.Add(row);
            }
            foreach (var file in media)
            {
                var row = await inventory.SingleOrDefaultAsync(r => EF.Property<string>(r, "id") == file.Id, ct);
                if (row is null || !Matches("MediaFile", row, file)) return false;
                mediaRows.Add(row);
            }
            var operations = await db.Set<Dictionary<string, object>>("FileOperation").ToListAsync(ct);
            foreach (var operation in operations.Where(o => files.Any(f => (string)o["id"] == $"file:{f.Id}") ||
                media.Any(m => Equals(o.GetValueOrDefault("mediaFileId"), m.Id))))
            {
                if (operation["state"].ToString() != "done") return false;
                var id = (string)operation["id"];
                var claims = await db.Set<Dictionary<string, object>>("FilePathClaim")
                    .Where(r => EF.Property<string>(r, "operationId") == id).ToListAsync(ct);
                db.Set<Dictionary<string, object>>("FilePathClaim").RemoveRange(claims);
                db.Set<Dictionary<string, object>>("FileOperation").Remove(operation);
            }
            await db.SaveChangesAsync(ct);
            foreach (var row in bindingRows)
            {
                var replacement = replacements.SingleOrDefault(f => f.Id == (string)row["id"]);
                if (replacement is null) bindings.Remove(row);
                else db.Entry(row).CurrentValues.SetValues(Schema.Table("DownloadFile").ToEntity(replacement));
            }
            await db.SaveChangesAsync(ct);
            inventory.RemoveRange(mediaRows);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        finally { db.ChangeTracker.Clear(); }

        static bool Matches(string table, Dictionary<string, object> row, StoreRow expected) =>
            JsonSerializer.Serialize(Schema.Table(table).ToRow(row), expected.GetType(), Schema.Json) ==
            JsonSerializer.Serialize(expected, expected.GetType(), Schema.Json);
    }
}
