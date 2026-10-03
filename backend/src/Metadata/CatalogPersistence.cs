using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed partial class MetadataService
{
    private async Task<WorkSnapshot?> PersistAsync(WorkSnapshot proposed, CancellationToken ct, bool listing = false,
        string? anchorWorkId = null)
    {
        await commits.WaitAsync(ct);
        try
        {
            var existingLinks = await store.AllAsync<WorkLinkRow>(null, ct);
            var matchingWorkIds = existingLinks.Where(l => l.Status == LinkStatus.Verified &&
                proposed.Links.Any(p => p.Status == LinkStatus.Verified && l.Provider == p.Provider &&
                    l.ExternalId == p.ExternalId && l.ProviderKind == p.ProviderKind))
                .Select(l => l.WorkId).Distinct().ToArray();
            var primary = proposed.Links.FirstOrDefault(l => l.IsPrimary && l.Status == LinkStatus.Verified);
            anchorWorkId ??= primary is null ? null : existingLinks.FirstOrDefault(l =>
                l.Status == LinkStatus.Verified && SameId(l,
                    new(primary.Provider, primary.ExternalId, primary.ProviderKind)))?.WorkId;
            if (anchorWorkId is null && matchingWorkIds.Length > 1) return null;
            var previous = anchorWorkId is not null ? await store.SnapshotAsync(anchorWorkId, ct) :
                matchingWorkIds.Length == 1 ? await store.SnapshotAsync(matchingWorkIds[0], ct) : null;
            if (listing && previous is not null) return previous;
            if (previous is null)
            {
                var rows = proposed.Links.Cast<StoreRow>().Concat(proposed.Names).Concat(proposed.Seasons)
                    .Concat(proposed.Episodes).Prepend(proposed.Work);
                var inserted = await store.CommitAsync(rows.Select(r => new RowWrite(r, null, null)), null, ct);
                return inserted.Applied ? proposed : null;
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
            var episodes = proposed.Episodes.Select(e =>
            {
                var seasonId = seasonMap[e.SeasonId];
                var old = previous.Episodes.FirstOrDefault(p => e.ProviderEpisodeId is not null &&
                    p.Provider == e.Provider && p.ProviderEpisodeId == e.ProviderEpisodeId)
                    ?? (work.Anime == true && e.AbsoluteNumber is { } absolute &&
                        previous.Episodes.Count(p => p.AbsoluteNumber == absolute) == 1
                        ? previous.Episodes.FirstOrDefault(p => p.AbsoluteNumber == absolute) : null)
                    ?? previous.Episodes.FirstOrDefault(p => p.SeasonId == seasonId && p.Number == e.Number);
                return e with { Id = old?.Id ?? ProviderHttp.Id(work.Id + ":episode:" + e.Provider + ":" +
                    (e.ProviderEpisodeId ?? seasonId + ":" + e.Number)), SeasonId = seasonId,
                    AirAt = e.AirAt ?? (old?.SeasonId == seasonId && old.Number == e.Number &&
                        old.AbsoluteNumber == e.AbsoluteNumber ? old.AirAt : null),
                    AirPrecision = e.AirAt is not null ? e.AirPrecision :
                        old?.SeasonId == seasonId && old.Number == e.Number &&
                        old.AbsoluteNumber == e.AbsoluteNumber ? old.AirPrecision : DatePrecision.Unknown,
                    CreatedAt = old?.CreatedAt ?? e.CreatedAt, Version = old is null ? 0 : old.Version + 1 };
            }).ToList();
            var changedCoordinates = episodes.Any(e => previous.Episodes.FirstOrDefault(p => p.Id == e.Id) is { } old &&
                (old.SeasonId != e.SeasonId || old.Number != e.Number || old.AbsoluteNumber != e.AbsoluteNumber));
            if (changedCoordinates)
            {
                var targets = await store.AllAsync<TargetRow>(CatalogStore.Query(workId: work.Id), ct);
                if (targets.Any(t => t.State is TargetState.Finding or TargetState.Checking or TargetState.Planning
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
                foreach (var file in await store.AllAsync<MediaFileRow>(CatalogStore.Query(workId: work.Id), ct))
                    if (file.EpisodeId is { } id) retainedIds.Add(id);
                foreach (var target in await store.AllAsync<TargetRow>(CatalogStore.Query(workId: work.Id), ct))
                {
                    if (target.EpisodeId is { } id) retainedIds.Add(id);
                }
                foreach (var follow in await store.AllAsync<FollowRow>(CatalogStore.Query(workId: work.Id), ct))
                    if (follow.FromEpisodeId is { } id) retainedIds.Add(id);
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
            var writes = new List<RowWrite> { new(work, previous.Work.Version, null) };
            AddUnversioned(links, previous.Links);
            AddUnversioned(names, previous.Names);
            foreach (var season in seasons.Where(s => !previous.Seasons.Contains(s)))
                writes.Add(new(season, previous.Seasons.FirstOrDefault(s => s.Id == season.Id)?.Version, null));
            foreach (var episode in episodes.Where(e => !previous.Episodes.Contains(e)))
                writes.Add(new(episode, previous.Episodes.FirstOrDefault(e => e.Id == episode.Id)?.Version, null));
            var deletes = previous.Names.Where(n => names.All(p => p.Id != n.Id))
                .Select(n => new RowDelete(StoreTable.WorkName, n.Id, null, n))
                .Concat(retired.Select(l => new RowDelete(StoreTable.WorkLink, l.Id, null, l)))
                .Concat(previous.Episodes.Where(e => episodes.All(p => p.Id != e.Id))
                    .Select(e => new RowDelete(StoreTable.Episode, e.Id, e.Version, null)))
                .Concat(previous.Seasons.Where(s => seasons.All(p => p.Id != s.Id))
                    .Select(s => new RowDelete(StoreTable.Season, s.Id, s.Version, null)));
            var result = await store.CommitAsync(writes, deletes, ct);
            return result.Applied ? new(work, [.. names.OrderBy(n => n.Ordinal)], [.. links],
                [.. seasons.OrderBy(s => s.Number)], [.. episodes]) : null;

            void AddUnversioned<T>(IEnumerable<T> rows, ImmutableArray<T> oldRows) where T : StoreRow
            {
                foreach (var row in rows)
                {
                    var old = oldRows.FirstOrDefault(p => p.Id == row.Id);
                    if (!Equals(row, old)) writes.Add(new(row, null, old));
                }
            }
        }
        finally { commits.Release(); }
    }

    public async Task<MetadataResult> ChangeLinkAsync(LinkCommand command, CancellationToken cancellationToken)
    {
        await commits.WaitAsync(cancellationToken);
        try
        {
            var work = await store.SnapshotAsync(command.WorkId, cancellationToken);
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
            var writes = new List<RowWrite> { new(row, work.Work.Version, null), new(updated, null, link) };
            if (command.Reject && link.Provider == "anilist")
            {
                var episodes = work.Episodes.Where(e => e.Provider == "anilist" &&
                    e.ProviderEpisodeId?.StartsWith(link.ExternalId + ":", StringComparison.Ordinal) == true).ToArray();
                writes.AddRange(episodes.Select(e => new RowWrite(e with { MappingStatus = MappingStatus.Unavailable,
                    UpdatedAt = row.UpdatedAt, Version = e.Version + 1 }, e.Version, null)));
                writes.AddRange(work.Seasons.Where(s => episodes.Any(e => e.SeasonId == s.Id))
                    .Select(s => new RowWrite(s with { MappingStatus = MappingStatus.Unavailable,
                        UpdatedAt = row.UpdatedAt, Version = s.Version + 1 }, s.Version, null)));
            }
            var result = await store.CommitAsync(writes,
                removed.Select(n => new RowDelete(StoreTable.WorkName, n.Id, null, n)), cancellationToken);
            if (result.Applied) partialAnswers.Clear();
            return result.Applied ? new(await store.SnapshotAsync(work.Work.Id, cancellationToken), null, true, false) :
                Missing("catalog_conflict", "This link changed. Refresh the page and try again.", false);
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
            var rows = await store.AllAsync<WorkRow>(null, cancellationToken);
            foreach (var work in rows.Where(w => w.RefreshedAt is null || now - w.RefreshedAt >= TimeSpan.FromDays(7)).Take(10))
                await GetWorkAsync(work.Id, true, cancellationToken);
            var expired = (await store.AllAsync<MetadataCacheRow>(null, cancellationToken))
                .Where(c => c.Kind is not (CacheKind.FribbMap or CacheKind.BrowseRail) &&
                    c.ExpiresAt < now.AddDays(c.Kind == CacheKind.TitleSearch ? -1 : -7)).Take(100).ToArray();
            if (expired.Length > 0)
                await store.CommitAsync([], expired.Select(c => new RowDelete(StoreTable.MetadataCache, c.Id, null, c)),
                    cancellationToken);
        }
        finally { ProviderHttp.Background.Value = previous; }
    }
}
