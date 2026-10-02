using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Library.Features.Watchlist;

/// <summary>
/// Pins the first episode of a new-episodes-only series: the first one to air after the row's
/// <see cref="WatchListItem.NewEpisodesSince"/>, from metadata air dates, which is the next season premiere when
/// the show is between seasons. This is the one place a new-episodes-only cursor starts; the watchlist add and the
/// automation hunt both call it, and the timeline and wait reasons read the pinned cursor. Nothing here
/// falls back to S01E01.
/// </summary>
internal static class NewEpisodes
{
    /// <summary>The moment episodes count as new. Rows that predate the column keep the moment they were added.</summary>
    public static DateTime Since(WatchListItem item) => DateTime.SpecifyKind(item.NewEpisodesSince ?? item.CreatedAt, DateTimeKind.Utc);

    /// <summary>
    /// Pins the row's first new episode as its cursor when the row still waits for one. Returns the lookup: Found
    /// means <paramref name="item"/> now carries the cursor (in memory and in the database). A row that already has
    /// a cursor, or is not new-episodes-only, is left alone and reads as Found with its current cursor and no air time.
    /// </summary>
    public static async Task<NewEpisodeLookup> PinAsync(TorrentFlowDbContext db, IAirDateLookup airDates, WatchListItem item,
        TimeSpan budget, CancellationToken ct)
    {
        if (!EpisodeCursor.AwaitingFirstNewEpisode(item))
            return EpisodeCursor.Resolve(item) is { } current ? new(NewEpisodeStatus.Found, current.Season, current.Episode) : NewEpisodeLookup.Unknown;
        var found = await FindFirstAsync(airDates, item, budget, ct).ConfigureAwait(false);
        if (found.Status != NewEpisodeStatus.Found) return found;
        var cursor = new EpisodeCursor(found.Season, found.Episode);
        var hint = cursor.Query(item.Title);
        // A write in the show's numbers (IAirDateLookup), dated so the anime renumbering never reads it as the old numbering.
        var now = DateTime.UtcNow;
        var pinned = await db.WatchListItems.Where(x => x.Id == item.Id && x.CursorSeason == null && x.CursorEpisode == null)
            .ExecuteUpdateAsync(x => x.SetProperty(w => w.CursorSeason, cursor.Season).SetProperty(w => w.CursorEpisode, cursor.Episode)
                .SetProperty(w => w.NextEpisodeHint, hint).SetProperty(w => w.CursorMisses, 0).SetProperty(w => w.UpdatedAt, now), ct).ConfigureAwait(false);
        if (pinned == 0)
        {
            var stored = await db.WatchListItems.AsNoTracking().Where(x => x.Id == item.Id)
                .Select(x => new { x.CursorSeason, x.CursorEpisode, x.NextEpisodeHint, x.UpdatedAt }).FirstOrDefaultAsync(ct).ConfigureAwait(false);
            if (stored?.CursorSeason is not > 0 || stored.CursorEpisode is not > 0) return NewEpisodeLookup.Unknown;
            item.CursorSeason = stored.CursorSeason;
            item.CursorEpisode = stored.CursorEpisode;
            item.NextEpisodeHint = stored.NextEpisodeHint;
            item.UpdatedAt = stored.UpdatedAt;
            return NewEpisodeLookup.Found(stored.CursorSeason.Value, stored.CursorEpisode.Value, found.AirsAt!.Value);
        }
        item.CursorSeason = cursor.Season;
        item.CursorEpisode = cursor.Episode;
        item.NextEpisodeHint = hint;
        item.CursorMisses = 0;
        item.UpdatedAt = now;
        return found;
    }

    /// <summary>
    /// Asks metadata within <paramref name="budget"/>. A provider failure, a timeout or an answer that is not a dated
    /// episode reads as unknown, so the row waits and asks again instead of guessing an episode.
    /// </summary>
    public static async Task<NewEpisodeLookup> FindFirstAsync(IAirDateLookup airDates, WatchListItem item, TimeSpan budget, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(budget);
        try
        {
            var found = await airDates.GetFirstEpisodeAfterAsync(item.Title, item.MediaType, item.ExternalId, Since(item), deadline.Token)
                .WaitAsync(deadline.Token).ConfigureAwait(false);
            return found.Status switch
            {
                NewEpisodeStatus.Found when found is { Season: > 0, Episode: > 0, AirsAt: not null } => found,
                NewEpisodeStatus.NoneAnnounced => NewEpisodeLookup.NoneAnnounced,
                _ => NewEpisodeLookup.Unknown,
            };
        }
        catch (Exception) when (!ct.IsCancellationRequested)
        {
            return NewEpisodeLookup.Unknown;
        }
    }
}
