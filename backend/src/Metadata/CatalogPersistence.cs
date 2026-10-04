using System.Collections.Immutable;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed partial class MetadataService
{
    private async Task<WorkSnapshot?> SnapshotAsync(string id, CancellationToken ct)
    {
        await using var db = await dbs.CreateDbContextAsync(ct);
        var work = await db.Works.AsNoTracking().SingleOrDefaultAsync(w => w.Id == id, ct)
            ?? await db.Works.AsNoTracking().SingleOrDefaultAsync(w => w.WorkKey == id, ct);
        if (work is null) return null;
        var seasons = await db.Seasons.AsNoTracking().Where(s => s.WorkId == work.Id)
            .OrderBy(s => s.Number).ThenBy(s => s.Id).ToListAsync(ct);
        var seasonIds = seasons.Select(s => s.Id).ToArray();
        var episodes = await db.Episodes.AsNoTracking().Where(e => seasonIds.Contains(e.SeasonId))
            .OrderBy(e => e.SeasonId).ThenBy(e => e.Id).ToListAsync(ct);
        var names = await db.WorkNames.AsNoTracking().Where(n => n.WorkId == work.Id)
            .OrderBy(n => n.Ordinal).ThenBy(n => n.Id).ToListAsync(ct);
        var links = await db.WorkLinks.AsNoTracking().Where(l => l.WorkId == work.Id).OrderBy(l => l.Id).ToListAsync(ct);
        return new(work, [.. names], [.. links], [.. seasons], [.. episodes]);
    }

    private async Task<List<WorkLinkRow>> LinksAsync(CancellationToken ct)
    {
        await using var db = await dbs.CreateDbContextAsync(ct);
        return await db.WorkLinks.AsNoTracking().OrderBy(l => l.Id).ToListAsync(ct);
    }

    private async Task<ImmutableArray<WorkSnapshot>> PersistListingsAsync(IEnumerable<WorkSnapshot> candidates,
        CancellationToken ct)
    {
        await commits.WaitAsync(ct);
        try
        {
            var links = (await LinksAsync(ct)).Where(l => l.Status == LinkStatus.Verified)
                .GroupBy(l => (l.Provider, l.ProviderKind, l.ExternalId))
                .ToDictionary(g => g.Key, g => g.Select(l => l.WorkId).Distinct().ToArray());
            var rows = new Dictionary<string, StoreRow>();
            var result = ImmutableArray.CreateBuilder<WorkSnapshot>();
            foreach (var proposed in candidates.DistinctBy(w => w.Work.WorkKey))
            {
                var primary = proposed.Links.FirstOrDefault(l => l.IsPrimary && l.Status == LinkStatus.Verified);
                var claimed = proposed.Links.Where(l => l.Status == LinkStatus.Verified)
                    .SelectMany(l => links.GetValueOrDefault((l.Provider, l.ProviderKind, l.ExternalId), []))
                    .Distinct().ToArray();
                var anchor = primary is null ? null :
                    links.GetValueOrDefault((primary.Provider, primary.ProviderKind, primary.ExternalId), []).FirstOrDefault();
                anchor ??= claimed.Length == 1 ? claimed[0] : null;
                if (anchor is not null)
                {
                    result.Add(proposed with { Work = proposed.Work with { Id = anchor } });
                    continue;
                }
                if (claimed.Length > 1) continue;
                foreach (var row in proposed.Links.Cast<StoreRow>()
                    .Concat(proposed.Names.Where(n => n.Label != NameLabel.Synonym)).Concat(proposed.Seasons)
                    .Concat(proposed.Episodes).Prepend(proposed.Work))
                    rows.TryAdd(row.Id, row);
                foreach (var link in proposed.Links.Where(l => l.Status == LinkStatus.Verified))
                    links.TryAdd((link.Provider, link.ProviderKind, link.ExternalId), [proposed.Work.Id]);
                result.Add(proposed);
            }
            if (rows.Count > 0)
            {
                await using var db = await dbs.CreateDbContextAsync(ct);
                db.AddRange(rows.Values);
                try { await db.SaveChangesAsync(ct); }
                catch (DbUpdateException ex) when (ProviderHttp.Conflict(ex))
                {
                    throw new IOException("Catalog listing changed while it was being saved.", ex);
                }
            }
            return result.ToImmutable();
        }
        finally { commits.Release(); }
    }

    private async Task<WorkSnapshot?> PersistAsync(WorkSnapshot proposed, CancellationToken ct,
        string? anchorWorkId = null)
    {
        await commits.WaitAsync(ct);
        try
        {
            await using var db = await dbs.CreateDbContextAsync(ct);
            var existingLinks = await LinksAsync(ct);
            var matchingWorkIds = existingLinks.Where(l => l.Status == LinkStatus.Verified &&
                proposed.Links.Any(p => p.Status == LinkStatus.Verified &&
                    SameId(l, new(p.Provider, p.ExternalId, p.ProviderKind))))
                .Select(l => l.WorkId).Distinct().ToArray();
            var directWorkIds = existingLinks.Where(l => l.Status == LinkStatus.Verified && l.SeasonId is null &&
                proposed.Links.Any(p => p.Status == LinkStatus.Verified && p.Source == "provider" &&
                    p.SeasonId is null && SameId(l, new(p.Provider, p.ExternalId, p.ProviderKind))))
                .Select(l => l.WorkId).Distinct().ToArray();
            var primary = proposed.Links.FirstOrDefault(l => l.IsPrimary && l.Status == LinkStatus.Verified);
            anchorWorkId ??= primary is null ? null : existingLinks.FirstOrDefault(l =>
                l.Status == LinkStatus.Verified && SameId(l,
                    new(primary.Provider, primary.ExternalId, primary.ProviderKind)))?.WorkId;
            var duplicates = new List<WorkSnapshot>();
            if (directWorkIds.Length > 1)
            {
                var snapshots = new List<WorkSnapshot>();
                foreach (var id in directWorkIds)
                    if (await SnapshotAsync(id, ct) is { } snapshot) snapshots.Add(snapshot);
                var retained = new List<WorkSnapshot>();
                foreach (var snapshot in snapshots)
                    if (await HasReferencesAsync(snapshot, ct)) retained.Add(snapshot);
                if (retained.Count > 1) return null;
                var owner = retained.SingleOrDefault() ?? snapshots.FirstOrDefault(s => s.Work.Id == anchorWorkId)
                    ?? snapshots.OrderBy(s => s.Work.CreatedAt).First();
                if (snapshots.Any(s => s.Work.Kind != owner.Work.Kind ||
                    s.Work.Year is { } year && owner.Work.Year is { } ownerYear && year != ownerYear))
                    return null;
                if (snapshots.SelectMany(s => s.Links).Where(l => l.Status == LinkStatus.Verified &&
                    l.SeasonId is null && l.Source != "fribb").GroupBy(l => (l.Provider, l.ProviderKind))
                    .Any(g => g.Select(l => l.ExternalId).Distinct().Count() > 1))
                    return null;
                anchorWorkId = owner.Work.Id;
                duplicates.AddRange(snapshots.Where(s => s.Work.Id != owner.Work.Id));
                existingLinks = [.. existingLinks.Where(l => duplicates.All(d => d.Work.Id != l.WorkId))];
            }
            else if (anchorWorkId is null && matchingWorkIds.Length > 1) return null;
            var previous = anchorWorkId is not null ? await SnapshotAsync(anchorWorkId, ct) :
                matchingWorkIds.Length == 1 ? await SnapshotAsync(matchingWorkIds[0], ct) : null;
            if (previous is null && matchingWorkIds.Length == 1)
                previous = await SnapshotAsync(matchingWorkIds[0], ct);
            if (previous is null)
            {
                db.AddRange(proposed.Links.Cast<StoreRow>().Concat(proposed.Names).Concat(proposed.Seasons)
                    .Concat(proposed.Episodes).Prepend(proposed.Work));
                try { await db.SaveChangesAsync(ct); }
                catch (DbUpdateException ex) when (ProviderHttp.Conflict(ex)) { return null; }
                return proposed;
            }
            if (proposed.Work.RefreshedAt is null && previous.Work.RefreshedAt is not null)
                return previous;
            var now = DateTimeOffset.UtcNow;
            var work = proposed.Work with
            {
                Id = previous.Work.Id, WorkKey = previous.Work.WorkKey, CreatedAt = previous.Work.CreatedAt,
                Version = previous.Work.Version + 1, UpdatedAt = now,
            };
            var linkMap = new Dictionary<string, string>();
            var links = new List<WorkLinkRow>();
            var oldPrimary = previous.Links.FirstOrDefault(l => l.IsPrimary);
            if (proposed.Links.Any(link => link.Status == LinkStatus.Verified &&
                proposed.Episodes.Any(e => e.Provider == link.Provider) &&
                existingLinks.Any(l => l.WorkId != work.Id && l.Status == LinkStatus.Verified &&
                    l.Provider == link.Provider && l.ProviderKind == link.ProviderKind &&
                    l.ExternalId == link.ExternalId)))
                return null;
            foreach (var link in proposed.Links)
            {
                var old = previous.Links.FirstOrDefault(l => l.Provider == link.Provider &&
                    l.ProviderKind == link.ProviderKind && l.ExternalId == link.ExternalId);
                var id = old?.Id ?? ProviderHttp.Id(work.Id + ":" + link.Provider + ":" + link.ProviderKind + ":" + link.ExternalId);
                linkMap[link.Id] = id;
                var claimedElsewhere = existingLinks.Any(l => l.WorkId != work.Id &&
                    l.Status == LinkStatus.Verified && l.Provider == link.Provider &&
                    l.ProviderKind == link.ProviderKind && l.ExternalId == link.ExternalId);
                links.Add(link with { Id = id, WorkId = work.Id, SeasonId = null,
                    Status = old?.Status == LinkStatus.Rejected ? LinkStatus.Rejected :
                        claimedElsewhere ? LinkStatus.Suggested : link.Status,
                    IsPrimary = oldPrimary is null ? link.IsPrimary : oldPrimary.Id == id,
                    CreatedAt = old?.CreatedAt ?? now });
            }
            var retired = previous.Links.Where(l => !links.Any(p => p.Id == l.Id) && l.Source == "fribb" &&
                l.Status != LinkStatus.Rejected && !l.IsPrimary && map.Version != "none" &&
                l.MappingVersion != map.Version).ToArray();
            foreach (var old in previous.Links.Where(l => !links.Any(p => p.Id == l.Id) &&
                !retired.Contains(l))) links.Add(old);
            foreach (var duplicate in duplicates)
                foreach (var old in duplicate.Links.Where(l => !links.Any(p => p.Provider == l.Provider &&
                    p.ProviderKind == l.ProviderKind && p.ExternalId == l.ExternalId)))
                    links.Add(old with { WorkId = work.Id, SeasonId = null, IsPrimary = false });
            var names = proposed.Names.Where(n => n.LinkId is null || links.Any(l => l.Id == linkMap[n.LinkId] &&
                l.Status == LinkStatus.Verified)).Select(n => n with
            {
                Id = ProviderHttp.Id(work.Id + ":" + n.NormalizedValue + ":" + n.Label + ":" +
                    (n.LinkId is null ? "" : linkMap[n.LinkId])),
                WorkId = work.Id, LinkId = n.LinkId is null ? null : linkMap[n.LinkId],
            }).ToList();
            foreach (var old in previous.Names.Where(n => n.LinkId is null &&
                !names.Any(p => p.NormalizedValue == n.NormalizedValue)))
                names.Add(old with { Label = NameLabel.Synonym, Authoritative = false, Ordinal = names.Count });
            var seasonMap = new Dictionary<string, string>();
            var seasons = proposed.Seasons.Select(s =>
            {
                var old = previous.Seasons.FirstOrDefault(p => p.Number == s.Number);
                var id = old?.Id ?? ProviderHttp.Id(work.Id + ":season:" + s.Number);
                seasonMap[s.Id] = id;
                return s with { Id = id, WorkId = work.Id, CreatedAt = old?.CreatedAt ?? s.CreatedAt,
                    Version = old is null ? 0 : old.Version + 1 };
            }).ToList();
            var identityMatches = proposed.Episodes.Where(e => e.ProviderEpisodeId is not null)
                .ToDictionary(e => e.Id, e => previous.Episodes.FirstOrDefault(p =>
                    p.Provider == e.Provider && p.ProviderEpisodeId == e.ProviderEpisodeId));
            var usedEpisodeIds = identityMatches.Values.OfType<EpisodeRow>().Select(e => e.Id).ToHashSet();
            var episodes = proposed.Episodes.Select(e =>
            {
                var seasonId = seasonMap[e.SeasonId];
                var old = identityMatches.GetValueOrDefault(e.Id)
                    ?? (work.Anime == true && e.AbsoluteNumber is { } absolute &&
                        previous.Episodes.Count(p => p.AbsoluteNumber == absolute) == 1
                        ? previous.Episodes.FirstOrDefault(p => p.AbsoluteNumber == absolute &&
                            CanRebind(p, e)) : null)
                    ?? previous.Episodes.FirstOrDefault(p => p.SeasonId == seasonId && p.Number == e.Number &&
                        CanRebind(p, e));
                if (old is not null) usedEpisodeIds.Add(old.Id);
                return e with { Id = old?.Id ?? ProviderHttp.Id(work.Id + ":episode:" + e.Provider + ":" +
                    (e.ProviderEpisodeId ?? seasonId + ":" + e.Number)), SeasonId = seasonId,
                    AirAt = e.AirAt ?? (old?.SeasonId == seasonId && old.Number == e.Number &&
                        old.AbsoluteNumber == e.AbsoluteNumber ? old.AirAt : null),
                    AirPrecision = e.AirAt is not null ? e.AirPrecision :
                        old?.SeasonId == seasonId && old.Number == e.Number &&
                        old.AbsoluteNumber == e.AbsoluteNumber ? old.AirPrecision : DatePrecision.Unknown,
                    CreatedAt = old?.CreatedAt ?? e.CreatedAt, Version = old is null ? 0 : old.Version + 1 };
            }).ToList();

            bool CanRebind(EpisodeRow old, EpisodeRow incoming) => !usedEpisodeIds.Contains(old.Id) &&
                (old.ProviderEpisodeId is null || old.Provider != incoming.Provider);
            var changedCoordinates = episodes.Any(e => previous.Episodes.FirstOrDefault(p => p.Id == e.Id) is { } old &&
                (old.SeasonId != e.SeasonId || old.Number != e.Number || old.AbsoluteNumber != e.AbsoluteNumber));
            if (changedCoordinates)
            {
                var states = await db.Targets.Where(t => t.WorkId == work.Id).Select(t => t.State).ToListAsync(ct);
                if (states.Any(s => s is TargetState.Finding or TargetState.Checking or TargetState.Planning
                    or TargetState.Fetching or TargetState.Filing))
                {
                    seasons = [.. previous.Seasons];
                    episodes = [.. previous.Episodes];
                    work = work with { NumberingVersion = previous.Work.NumberingVersion, RefreshedAt = null };
                }
            }
            var completeListing = proposed.Work.Kind == WorkKind.Series &&
                proposed.Work.RefreshedAt > now.AddMinutes(-1) &&
                proposed.Seasons.All(s => s.MappingStatus == MappingStatus.Confirmed);
            var missingEpisodes = previous.Episodes.Where(e => episodes.All(p => p.Id != e.Id)).ToArray();
            var retainedIds = new HashSet<string>();
            if (completeListing && missingEpisodes.Length > 0)
            {
                retainedIds.UnionWith(await db.MediaFiles.Where(f => f.WorkId == work.Id && f.EpisodeId != null)
                    .Select(f => f.EpisodeId!).ToListAsync(ct));
                retainedIds.UnionWith(await db.Targets.Where(t => t.WorkId == work.Id && t.EpisodeId != null)
                    .Select(t => t.EpisodeId!).ToListAsync(ct));
                retainedIds.UnionWith(await db.Follows.Where(f => f.WorkId == work.Id && f.FromEpisodeId != null)
                    .Select(f => f.FromEpisodeId!).ToListAsync(ct));
            }
            foreach (var old in missingEpisodes.Where(e => !completeListing || retainedIds.Contains(e.Id)))
                episodes.Add(completeListing ? old with { MappingStatus = MappingStatus.Unavailable,
                    Version = old.Version + 1, UpdatedAt = now } : old);
            foreach (var old in previous.Seasons.Where(s => seasons.All(p => p.Id != s.Id) &&
                (!completeListing || episodes.Any(e => e.SeasonId == s.Id) || links.Any(l => l.SeasonId == s.Id))))
                seasons.Add(old);
            for (var i = 0; i < links.Count; i++)
            {
                var original = proposed.Links.FirstOrDefault(l => linkMap.GetValueOrDefault(l.Id) == links[i].Id);
                if (original?.SeasonId is { } sid && seasonMap.TryGetValue(sid, out var mapped))
                    links[i] = links[i] with { SeasonId = mapped };
            }
            var deletedLinks = retired.Concat(duplicates.SelectMany(d => d.Links.Where(l => links.All(p => p.Id != l.Id))))
                .ToArray();
            var deletedEpisodes = previous.Episodes.Where(e => episodes.All(p => p.Id != e.Id))
                .Concat(duplicates.SelectMany(d => d.Episodes)).ToArray();
            var movingEpisodes = episodes.Where(e => previous.Episodes.FirstOrDefault(p => p.Id == e.Id) is { } old &&
                (old.SeasonId != e.SeasonId || old.Number != e.Number)).ToArray();
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            // EF cannot order its statements around the raw verified-link index or episode number swaps,
            // so release those unique values before saving.
            var vacated = deletedLinks.Where(l => l.Status == LinkStatus.Verified).Select(l => l.Id).ToArray();
            if (vacated.Length > 0)
                await db.WorkLinks.Where(l => vacated.Contains(l.Id))
                    .ExecuteUpdateAsync(s => s.SetProperty(l => l.Status, LinkStatus.Suggested), ct);
            var deletedEpisodeIds = deletedEpisodes.Select(e => e.Id).ToArray();
            if (deletedEpisodeIds.Length > 0)
                await db.Episodes.Where(e => deletedEpisodeIds.Contains(e.Id))
                    .ExecuteUpdateAsync(s => s.SetProperty(e => e.ProviderEpisodeId, (string?)null), ct);
            if (movingEpisodes.Length > 0)
            {
                var temporary = await db.Episodes.MaxAsync(e => (int?)e.Number, ct) ?? 0;
                foreach (var episode in movingEpisodes)
                {
                    temporary = checked(temporary + 1);
                    await db.Episodes.Where(e => e.Id == episode.Id)
                        .ExecuteUpdateAsync(s => s.SetProperty(e => e.Number, temporary), ct);
                }
            }
            Write(work, previous.Work);
            AddUnversioned(links, previous.Links);
            AddUnversioned(names, previous.Names);
            foreach (var season in seasons.Where(s => !previous.Seasons.Contains(s)))
                Write(season, previous.Seasons.FirstOrDefault(s => s.Id == season.Id));
            foreach (var episode in episodes.Where(e => !previous.Episodes.Contains(e)))
                Write(episode, previous.Episodes.FirstOrDefault(e => e.Id == episode.Id));
            foreach (var episode in movingEpisodes) db.Entry(episode).Property(e => e.Number).IsModified = true;
            db.RemoveRange(previous.Names.Where(n => names.All(p => p.Id != n.Id))
                .Concat(duplicates.SelectMany(d => d.Names)));
            db.RemoveRange(deletedLinks);
            db.RemoveRange(deletedEpisodes);
            db.RemoveRange(previous.Seasons.Where(s => seasons.All(p => p.Id != s.Id))
                .Concat(duplicates.SelectMany(d => d.Seasons)));
            db.RemoveRange(duplicates.Select(d => d.Work));
            try
            {
                await db.SaveChangesAsync(ct);
                await transaction.CommitAsync(ct);
            }
            catch (DbUpdateException ex) when (ProviderHttp.Conflict(ex)) { return null; }
            if (duplicates.Count > 0)
            {
                var changedIds = duplicates.Select(d => d.Work.Id).Append(work.Id).ToHashSet();
                foreach (var cached in partialAnswers.Where(p => p.Value.Result.Work is { } snapshot &&
                    changedIds.Contains(snapshot.Work.Id)))
                    partialAnswers.TryRemove(cached);
                foreach (var cached in resolvedQueries.Where(p => changedIds.Contains(p.Value.WorkId)))
                    resolvedQueries.TryRemove(cached);
            }
            return new(work, [.. names.OrderBy(n => n.Ordinal)], [.. links],
                [.. seasons.OrderBy(s => s.Number)], [.. episodes]);

            void Write<T>(T row, T? old) where T : StoreRow
            {
                if (old is null) db.Add(row);
                else db.Attach(row).OriginalValues.SetValues(old);
            }

            void AddUnversioned<T>(IEnumerable<T> rows, ImmutableArray<T> oldRows) where T : StoreRow
            {
                foreach (var row in rows)
                {
                    var old = oldRows.FirstOrDefault(p => p.Id == row.Id)
                        ?? duplicates.SelectMany(d => d.Links.Cast<StoreRow>()).OfType<T>()
                            .FirstOrDefault(p => p.Id == row.Id);
                    if (!Equals(row, old)) Write(row, old);
                }
            }
        }
        finally { commits.Release(); }
    }

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
