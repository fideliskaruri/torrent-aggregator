using System.Collections.Immutable;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed partial class Catalog
{
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
            // A sequel resolved on its own before it became a season of this work would block the season link forever.
            // Absorb it while nothing references it.
            var sequels = new List<WorkSnapshot>();
            foreach (var id in existingLinks.Where(l => l.Status == LinkStatus.Verified && l.IsPrimary &&
                    l.SeasonId is null && l.WorkId != anchorWorkId && !directWorkIds.Contains(l.WorkId) &&
                    proposed.Links.Any(p => p.Status == LinkStatus.Verified && p.SeasonId is not null &&
                        SameId(l, new(p.Provider, p.ExternalId, p.ProviderKind))))
                .Select(l => l.WorkId).Distinct().ToArray())
                if (await SnapshotAsync(id, ct) is { } sequel && sequel.Work.Kind == proposed.Work.Kind &&
                    !await HasReferencesAsync(sequel, ct)) sequels.Add(sequel);
            matchingWorkIds = [.. matchingWorkIds.Where(id => sequels.All(s => s.Work.Id != id))];
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
            duplicates.AddRange(sequels);
            existingLinks = [.. existingLinks.Where(l => sequels.All(s => s.Work.Id != l.WorkId))];
            var previous = anchorWorkId is not null ? await SnapshotAsync(anchorWorkId, ct) :
                matchingWorkIds.Length == 1 ? await SnapshotAsync(matchingWorkIds[0], ct) : null;
            if (previous is null && matchingWorkIds.Length == 1)
                previous = await SnapshotAsync(matchingWorkIds[0], ct);
            if (previous is null)
            {
                await using var insert = await db.Database.BeginTransactionAsync(ct);
                var absorbed = duplicates.SelectMany(d => d.Links).Select(l => l.Id).ToArray();
                if (absorbed.Length > 0)
                    await db.WorkLinks.Where(l => absorbed.Contains(l.Id))
                        .ExecuteUpdateAsync(s => s.SetProperty(l => l.Status, LinkStatus.Suggested), ct);
                db.RemoveRange(duplicates.SelectMany(d => d.Names.Cast<StoreRow>().Concat(d.Links)
                    .Concat(d.Episodes).Concat(d.Seasons)).Concat(duplicates.Select(d => d.Work)));
                db.AddRange(proposed.Links.Cast<StoreRow>().Concat(proposed.Names).Concat(proposed.Seasons)
                    .Concat(proposed.Episodes).Prepend(proposed.Work));
                try
                {
                    await db.SaveChangesAsync(ct);
                    await insert.CommitAsync(ct);
                }
                catch (DbUpdateException ex) when (ProviderHttp.Conflict(ex)) { return null; }
                Forget(duplicates.Select(d => d.Work.Id).Append(proposed.Work.Id).ToHashSet());
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
                if (states.Any(s => s is TargetState.Searching or TargetState.Fetching or TargetState.Filing))
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
            if (duplicates.Count > 0) Forget(duplicates.Select(d => d.Work.Id).Append(work.Id).ToHashSet());
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

    private void Forget(HashSet<string> changedIds)
    {
        foreach (var cached in partialAnswers.Where(p => p.Value.Result.Work is { } snapshot &&
            changedIds.Contains(snapshot.Work.Id)))
            partialAnswers.TryRemove(cached);
        foreach (var cached in resolvedQueries.Where(p => changedIds.Contains(p.Value.WorkId)))
            resolvedQueries.TryRemove(cached);
    }

}
