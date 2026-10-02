using System.Globalization;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;

namespace TorrentFlow.Library.Features.Watchlist;

/// <summary>
/// A library row's catalog work. Rows saved before rows were linked on creation have none; an anime row's AniList id
/// finds its work on first use and links it, so the hunter and the next-episode check number it as its show does.
/// </summary>
public static class WatchlistWorks
{
    /// <summary>The AniList id an anime library row was added with, when it is one.</summary>
    public static string? AniListId(WatchListItem item) =>
        item.MediaType == "anime" && int.TryParse(item.ExternalId, NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0
            ? item.ExternalId : null;

    /// <summary>The row's work: the linked one, or the AniList work its id names (then linked). Null when none is known yet.</summary>
    public static async Task<Work?> LinkAsync(TorrentFlowDbContext db, WatchListItem item, CancellationToken ct)
    {
        if (item.WorkId is { } linked) return item.Work ?? await db.Works.AsNoTracking().FirstOrDefaultAsync(w => w.Id == linked, ct);
        if (AniListId(item) is not { } id) return null;
        var work = await db.Works.AsNoTracking().Where(w => w.Provider == "anilist" && w.ProviderId == id)
            .OrderBy(w => w.CreatedAt).FirstOrDefaultAsync(ct);
        if (work == null) return null;
        await db.WatchListItems.Where(x => x.Id == item.Id && x.UserId == LocalUser.Id && x.WorkId == null)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.WorkId, work.Id), ct);
        item.WorkId = work.Id;
        return work;
    }
}
