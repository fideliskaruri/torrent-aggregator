using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Api.Catalog;

internal sealed record CardActionRequest(string WatchListItemId, string Title, string MediaType, int Season, int Episode);
internal sealed record CatalogCardAction(string Kind, string Label, bool Disabled, string? Reason, string? Href,
    CardActionRequest? Request);

internal static class CardAction
{
    internal static async Task<IReadOnlyDictionary<string, CatalogCardAction>> ResolveAsync(
        TorrentFlowDbContext db, IEnumerable<WorkSnapshot> source, string actorId, bool canDownload,
        CancellationToken ct)
    {
        var works = source.DistinctBy(w => w.Work.Id).ToArray();
        var ids = works.Select(w => w.Work.Id).ToArray();
        if (ids.Length == 0) return new Dictionary<string, CatalogCardAction>();

        var files = await db.MediaFiles.AsNoTracking()
            .Where(f => ids.Contains(f.WorkId) && f.Role == FileRole.Video && f.Status == FilePresence.Present)
            .ToListAsync(ct);
        var targets = await db.Targets.AsNoTracking().Where(t => ids.Contains(t.WorkId)).ToListAsync(ct);
        var watchItems = await db.WatchItems.AsNoTracking()
            .Where(i => i.UserId == actorId && ids.Contains(i.WorkId) &&
                i.Status != WatchStatus.Completed && i.Status != WatchStatus.Dropped)
            .ToListAsync(ct);

        var filesByWork = files.GroupBy(f => f.WorkId).ToDictionary(g => g.Key, g => g.ToArray());
        var targetsByWork = targets.GroupBy(t => t.WorkId).ToDictionary(g => g.Key, g => g.ToArray());
        var watchesByWork = watchItems.Where(i => i.UserId == actorId &&
                i.Status is not (WatchStatus.Completed or WatchStatus.Dropped))
            .GroupBy(i => i.WorkId).ToDictionary(g => g.Key, g => g.First());
        var now = DateTimeOffset.UtcNow;
        return works.ToDictionary(w => w.Work.Id, w =>
        {
            var title = CatalogProjection.Title(w).Trim();
            var titleHref = CatalogProjection.Href(w);
            var ownFiles = filesByWork.GetValueOrDefault(w.Work.Id) ?? [];
            var ownTargets = targetsByWork.GetValueOrDefault(w.Work.Id) ?? [];
            var watch = watchesByWork.GetValueOrDefault(w.Work.Id);
            var activeTargets = ownTargets.Where(t => t.State is not (TargetState.Done or TargetState.Removed)).ToArray();
            EpisodeRow? next = null;
            if (CatalogProjection.Series(w) && watch is not null)
            {
                var seasonNumbers = w.Seasons.Where(s => s.Number > 0).ToDictionary(s => s.Id, s => s.Number);
                next = w.Episodes
                    .Where(e => e.AirAt is { } air && air <= now &&
                        e.MappingStatus != MappingStatus.Unavailable &&
                        seasonNumbers.ContainsKey(e.SeasonId) &&
                        !ownFiles.Any(f => f.EpisodeId == e.Id))
                    .OrderBy(e => seasonNumbers[e.SeasonId])
                    .ThenBy(e => e.Number)
                    .FirstOrDefault();
            }

            var fetchingFilm = !CatalogProjection.Series(w) && ownTargets.Any(t =>
                t.EpisodeId is null && t.State is TargetState.Fetching or TargetState.Filing);
            var fetchingNext = next is not null && ownTargets.Any(t =>
                t.EpisodeId == next.Id && t.State is TargetState.Fetching or TargetState.Filing);
            if (fetchingFilm || fetchingNext)
                return new CatalogCardAction("downloading", "Downloading", true,
                    fetchingNext ? "This episode is downloading." : "This film is downloading.", null, null);

            var owned = !CatalogProjection.Series(w)
                ? ownFiles.Any(f => f.EpisodeId is null)
                : ownFiles.Length > 0 && activeTargets.Length == 0;
            if (owned)
                return canDownload
                    ? new CatalogCardAction("local", "In your library", false, null, titleHref, null)
                    : new CatalogCardAction("request", "Request", false, null, titleHref, null);

            if (next is not null)
            {
                if (!canDownload)
                    return new CatalogCardAction("request", "Request", false, null, titleHref, null);
                var season = w.Seasons.First(s => s.Id == next.SeasonId).Number;
                return new CatalogCardAction("get", $"Get S{season:00}E{next.Number:00}", false, null, null,
                    new CardActionRequest(watch!.Id, title, CatalogProjection.TitleType(w), season, next.Number));
            }

            if (title.Length == 0)
                return new CatalogCardAction("blocked", "Unavailable", true,
                    "This entry has no title to look up.", null, null);

            return new CatalogCardAction("search", "Find it", false, null,
                SearchHref(title, CatalogProjection.TitleType(w)), null);
        });
    }

    private static string? SearchHref(string title, string? mediaType)
    {
        if (string.IsNullOrWhiteSpace(title)) return null;
        var category = mediaType?.Trim().ToLowerInvariant() switch
        {
            "anime" => "anime",
            "movie" or "movies" => "movies",
            "tv" => "tv",
            _ => null,
        };
        var href = "/search?q=" + Uri.EscapeDataString(title);
        return category is null ? href : href + "&category=" + Uri.EscapeDataString(category);
    }
}
