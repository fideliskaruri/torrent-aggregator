using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Data;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>
/// The one name an anime show's folder takes, for its own episodes and every later entry's alike: the show's own
/// catalog work when the library has it (its title and year, the ones its own downloads are filed under), else the name
/// the show's first AniList entry goes by, the one its work is created with. A sequel entry's page and the show's own
/// page then never split one show across two folders.
/// </summary>
public static class ShowFolders
{
    /// <param name="showId">The show's first AniList entry; null for a work that is its own show (its title is the folder).</param>
    public static async Task<(string Title, int? Year)> ResolveAsync(TorrentFlowDbContext db, string? showId, string title, int? year,
        CancellationToken ct)
    {
        if (showId is null) return (title, year);
        var work = await db.Works.AsNoTracking().Where(w => w.Provider == "anilist" && w.ProviderId == showId)
            .OrderBy(w => w.CreatedAt).Select(w => new { w.CanonicalTitle, w.Year }).FirstOrDefaultAsync(ct);
        return work is null || string.IsNullOrWhiteSpace(work.CanonicalTitle) ? (title, year) : (work.CanonicalTitle, work.Year ?? year);
    }

    /// <summary>A sequel entry's mapping with its show's folder name (<see cref="ResolveAsync"/>).</summary>
    public static async Task<AnimeEpisodeMapping> ApplyAsync(TorrentFlowDbContext db, AnimeEpisodeMapping mapping, CancellationToken ct)
    {
        if (mapping.ShowTitle is null) return mapping;
        var (title, year) = await ResolveAsync(db, mapping.ShowId, mapping.ShowTitle, mapping.ShowYear, ct);
        return mapping with { ShowTitle = title, ShowYear = year };
    }
}
