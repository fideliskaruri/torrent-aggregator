using System.Collections.Immutable;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

public interface ILibraryPlacementProposalRepository
{
    Task<ImmutableArray<RowWrite>?> ProposeExternalPlacementAsync(ImmutableArray<DownloadFileRow> files,
        string? reviewId, ImmutableArray<string> reviewItemIds, CancellationToken ct);
}

public sealed partial class LibraryRepository : ILibraryPlacementProposalRepository
{
    public async Task<ImmutableArray<RowWrite>?> ProposeExternalPlacementAsync(ImmutableArray<DownloadFileRow> files,
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
        return [.. files.Select(f => new RowWrite(f, null, null))];
    }

    public async Task<bool> SavePlacementAsync(ImmutableArray<DownloadFileRow> files,
        ImmutableArray<WorkFolderRow> folders, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            db.DownloadFiles.AddRange(files);
            foreach (var folder in folders)
                if (!await db.WorkFolders.AnyAsync(row => row.WorkId == folder.WorkId && row.RootId == folder.RootId, ct))
                    db.WorkFolders.Add(folder);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 })
        { return false; }
        finally { db.ChangeTracker.Clear(); }
    }

    public async Task<bool> UpdateBindingsAsync(
        ImmutableArray<(DownloadFileRow Before, DownloadFileRow After)> files,
        ImmutableArray<WorkFolderRow> folders, CancellationToken ct)
    {
        if (files.IsDefaultOrEmpty || files.Select(f => f.Before.Id).Distinct().Count() != files.Length ||
            files.Any(f => f.Before.Id != f.After.Id || f.Before.DownloadId != f.After.DownloadId ||
                f.Before.FileIndex != f.After.FileIndex))
            throw new ArgumentException("A binding update must preserve each download file identity.");
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        try
        {
            foreach (var (before, after) in files)
            {
                var current = await db.DownloadFiles.SingleOrDefaultAsync(row => row.Id == before.Id, ct);
                if (current != before) return false;
                db.Entry(current).CurrentValues.SetValues(after);
            }
            foreach (var folder in folders)
                if (!await db.WorkFolders.AnyAsync(row => row.WorkId == folder.WorkId && row.RootId == folder.RootId, ct))
                    db.WorkFolders.Add(folder);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 })
        { return false; }
        finally { db.ChangeTracker.Clear(); }
    }

    public async Task<ImmutableArray<RowWrite>?> ProposeFiledAsync(
        ImmutableArray<(DownloadFileRow Before, DownloadFileRow After, MediaFileRow Media)> files,
        CancellationToken ct)
    {
        if (files.IsDefaultOrEmpty || files.Select(f => f.Before.Id).Distinct().Count() != files.Length)
            throw new ArgumentException("A filing batch must contain unique download file bindings.");
        var writes = ImmutableArray.CreateBuilder<RowWrite>();
        foreach (var (before, requestedAfter, requestedMedia) in files)
        {
            if (before.Filed || !before.Selected || before.FinalPath != requestedMedia.Path ||
                before.DownloadId != requestedMedia.DownloadId || before.FileIndex != requestedMedia.FileIndex ||
                before.ExpectedBytes != requestedMedia.Bytes || requestedAfter != before with
                { EnginePath = before.FinalPath, PartialPath = null, Selected = false, Filed = true,
                    MediaFileId = requestedMedia.Id })
                throw new ArgumentException("The filing result does not match its reserved file.");
            var current = await db.DownloadFiles.AsNoTracking().SingleOrDefaultAsync(row => row.Id == before.Id, ct);
            if (current != before) return null;
            var prior = await db.MediaFiles.AsNoTracking()
                .SingleOrDefaultAsync(row => row.PhysicalKey == requestedMedia.PhysicalKey, ct);
            var media = requestedMedia;
            var after = requestedAfter;
            if (prior is not null)
            {
                if (prior.ContentDigest != media.ContentDigest ||
                    prior.WorkId != media.WorkId || prior.EpisodeId != media.EpisodeId)
                    throw new IOException("The previous library file differs from this download. Review the existing file.");
                media = media with { Id = prior.Id, Version = prior.Version + 1 };
                after = after with { MediaFileId = prior.Id };
            }
            writes.Add(new(after, null, before));
            writes.Add(new(media, prior?.Version, null));
        }
        return writes.ToImmutable();
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
            await QueueDeletedJellyfinJobsAsync(media, ct);
            db.MediaFiles.RemoveRange(media);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return true;
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqliteException { SqliteErrorCode: 19 or 5 or 6 })
        { return false; }
        finally { db.ChangeTracker.Clear(); }
    }

    internal async Task QueueDeletedJellyfinJobsAsync(IReadOnlyCollection<MediaFileRow> media,
        CancellationToken ct)
    {
        if (media.Count == 0) return;
        var setting = await db.Settings.AsNoTracking().SingleOrDefaultAsync(row => row.Id == "jellyfin", ct);
        if (setting is null) return;
        var settings = SettingsCatalog.Read<JellyfinSettings>(setting);
        if (settings.ServerUrl is null || settings.Credential is null) return;

        var mediaIds = media.Select(file => file.Id).ToArray();
        var bindings = await db.DownloadFiles.AsNoTracking()
            .Where(file => file.MediaFileId != null && mediaIds.Contains(file.MediaFileId))
            .ToArrayAsync(ct);
        var replacementTargets = await db.Targets.AsNoTracking()
            .Where(target => target.ReplaceMediaFileId != null && mediaIds.Contains(target.ReplaceMediaFileId))
            .ToArrayAsync(ct);
        var now = DateTimeOffset.UtcNow;
        foreach (var group in media.GroupBy(file =>
        {
            var binding = bindings.FirstOrDefault(item => item.MediaFileId == file.Id);
            return binding?.TargetId ?? replacementTargets.FirstOrDefault(target => target.ReplaceMediaFileId == file.Id)?.Id;
        }))
        {
            var paths = group.Select(file => Path.GetDirectoryName(file.Path)).OfType<string>()
                .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            if (paths.Length == 0) continue;
            db.JellyfinJobs.Add(new JellyfinJobRow
            {
                Id = Guid.NewGuid().ToString("N"),
                Kind = "rescan",
                PayloadJson = JsonSerializer.SerializeToElement(new { paths, updateType = "Deleted" }),
                TargetId = group.Key,
                MediaFileId = null,
                Attempts = 0,
                NextAttemptAt = now,
                CreatedAt = now,
                LastError = null,
                State = "pending",
            });
        }
    }
}
