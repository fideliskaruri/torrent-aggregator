using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;

namespace TorrentFlow.Library.Features.Titles;

/// <summary>
/// Where a work's downloads are filed, the evidence for <see cref="WorkKinds.AnimeVerdict"/> (one library per show): a
/// transfer of the work that is still in the library, or a wanted row whose file landed, under "Anime Series" or
/// "Anime Movies".
/// </summary>
public static class AnimeFiling
{
    /// <summary>The first such save or file path, or null when none of the work's downloads is filed in an anime library.</summary>
    public static async Task<string?> PathAsync(TorrentFlowDbContext db, string workId, string workKey, CancellationToken ct)
    {
        string series = $"%{MediaFolders.AnimeSeries}%", movies = $"%{MediaFolders.AnimeMovies}%";
        var saves = await db.EngineTorrents.AsNoTracking()
            .Where(t => t.WorkId == workId && t.Status != EngineTorrentStatus.Removed && t.SavePath != null &&
                (EF.Functions.Like(t.SavePath, series) || EF.Functions.Like(t.SavePath, movies)))
            .Select(t => t.SavePath!).Take(20).ToListAsync(ct);
        if (saves.FirstOrDefault(MediaFolders.InAnimeLibrary) is { } save) return save;
        var files = await db.AcquisitionTargets.AsNoTracking()
            .Where(t => (t.WorkId == workId || t.WorkKey == workKey) && t.Status != "failed" && t.FilePath != null &&
                (EF.Functions.Like(t.FilePath, series) || EF.Functions.Like(t.FilePath, movies)))
            .Select(t => t.FilePath!).Take(20).ToListAsync(ct);
        return files.FirstOrDefault(MediaFolders.InAnimeLibrary);
    }

    /// <summary>The note a work that stays anime this way leaves in the log.</summary>
    public static void LogKept(ILogger? logger, string workKey, string? provider, string path) =>
        logger?.LogInformation("{WorkKey} stays anime although its {Provider} record reads otherwise: its downloads are filed in {Path}, and a show keeps one library",
            workKey, provider, path);
}
