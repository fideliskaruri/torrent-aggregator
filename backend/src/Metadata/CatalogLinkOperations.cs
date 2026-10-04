using System.Collections.Immutable;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed partial class Catalog
{
    private async Task<bool> HasReferencesAsync(WorkSnapshot work, CancellationToken ct)
    {
        var id = work.Work.Id;
        await using var db = await dbs.CreateDbContextAsync(ct);
        return await db.MediaFiles.AnyAsync(r => r.WorkId == id, ct) ||
            await db.Targets.AnyAsync(r => r.WorkId == id, ct) ||
            await db.WatchItems.AnyAsync(r => r.WorkId == id, ct) ||
            await db.Follows.AnyAsync(r => r.WorkId == id, ct) ||
            await db.WorkPreferences.AnyAsync(r => r.WorkId == id, ct) ||
            await db.ScopeIntents.AnyAsync(r => r.WorkId == id, ct) ||
            await db.Requests.AnyAsync(r => r.WorkId == id, ct) ||
            await db.Attempts.AnyAsync(r => r.WorkId == id, ct) ||
            await db.WorkFolders.AnyAsync(r => r.WorkId == id, ct);
    }

    public async Task<MetadataResult> ChangeLinkAsync(LinkCommand command, CancellationToken cancellationToken)
    {
        await commits.WaitAsync(cancellationToken);
        try
        {
            var work = await SnapshotAsync(command.WorkId, cancellationToken);
            if (work is null) return Missing("not_found", "This title is no longer in the catalog.", true);
            if (work.Work.Version != command.ExpectedWorkVersion)
                return Missing("catalog_conflict", "This title changed. Refresh the page before changing its link.", false);
            var link = work.Links.FirstOrDefault(l => l.Id == command.LinkId);
            if (link is null) return Missing("not_found", "This catalog link no longer exists.", true);
            if (link.IsPrimary && command.Reject)
                return Missing("primary_link", "Choose another primary catalog link before removing this one.", false);
            var updated = link with { Status = command.Reject ? LinkStatus.Rejected : LinkStatus.Verified,
                UpdatedAt = DateTimeOffset.UtcNow };
            var row = work.Work with { Version = work.Work.Version + 1, UpdatedAt = DateTimeOffset.UtcNow,
                RefreshedAt = null };
            var removed = command.Reject ? work.Names.Where(n => n.LinkId == link.Id).ToArray() : [];
            await using var db = await dbs.CreateDbContextAsync(cancellationToken);
            db.Attach(row).OriginalValues.SetValues(work.Work);
            db.Attach(updated).OriginalValues.SetValues(link);
            if (command.Reject && link.Provider == "anilist")
            {
                var episodes = work.Episodes.Where(e => e.Provider == "anilist" &&
                    e.ProviderEpisodeId?.StartsWith(link.ExternalId + ":", StringComparison.Ordinal) == true).ToArray();
                foreach (var episode in episodes)
                    db.Attach(episode with { MappingStatus = MappingStatus.Unavailable, UpdatedAt = row.UpdatedAt,
                        Version = episode.Version + 1 }).OriginalValues.SetValues(episode);
                foreach (var season in work.Seasons.Where(s => episodes.Any(e => e.SeasonId == s.Id)))
                    db.Attach(season with { MappingStatus = MappingStatus.Unavailable, UpdatedAt = row.UpdatedAt,
                        Version = season.Version + 1 }).OriginalValues.SetValues(season);
            }
            db.RemoveRange(removed);
            try { await db.SaveChangesAsync(cancellationToken); }
            catch (DbUpdateException ex) when (ProviderHttp.Conflict(ex))
            {
                return Missing("catalog_conflict", "This link changed. Refresh the page and try again.", false);
            }
            partialAnswers.Clear();
            return new(await SnapshotAsync(work.Work.Id, cancellationToken), null, true, false);
        }
        finally { commits.Release(); }
    }

    public async Task RefreshAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var previous = ProviderHttp.Background.Value;
        ProviderHttp.Background.Value = true;
        try
        {
            await map.RefreshAsync(now, cancellationToken);
            await using var db = await dbs.CreateDbContextAsync(cancellationToken);
            var works = await db.Works.AsNoTracking().OrderBy(w => w.Id)
                .Select(w => new { w.Id, w.RefreshedAt }).ToListAsync(cancellationToken);
            foreach (var work in works.Where(w => w.RefreshedAt is null || now - w.RefreshedAt >= TimeSpan.FromDays(7)).Take(10))
                await GetWorkAsync(work.Id, true, cancellationToken);
            // Dates are stored as text, so expiry is compared in memory.
            var caches = await db.MetadataCaches.AsNoTracking()
                .Where(c => c.Kind != CacheKind.FribbMap && c.Kind != CacheKind.BrowseRail).OrderBy(c => c.Id)
                .Select(c => new { c.Id, c.Kind, c.ExpiresAt }).ToListAsync(cancellationToken);
            var expired = caches.Where(c => c.ExpiresAt < now.AddDays(c.Kind == CacheKind.TitleSearch ? -1 : -7))
                .Take(100).Select(c => c.Id).ToArray();
            if (expired.Length > 0)
                await db.MetadataCaches.Where(c => expired.Contains(c.Id)).ExecuteDeleteAsync(cancellationToken);
        }
        finally { ProviderHttp.Background.Value = previous; }
    }
}
