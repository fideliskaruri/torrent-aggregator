using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Scheduling;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Grabs;

namespace TorrentFlow.Library.Features.Watchlist;

/// <summary>
/// A finished download puts its title in the Library, so a Ready film or show is never missing there (OPS-409). It is
/// added the way "Add to library" adds it, but not tracked: a film as completed, a show as watching with tracking off,
/// and with the finished release recorded so the card says it was sent rather than "no release yet".
/// A title already in the Library is left exactly as the owner set it, and one he removes stays removed until another
/// download of it finishes.
/// </summary>
public sealed class DownloadedToLibrary(ITorrentEngine engine, IDbContextFactory<TorrentFlowDbContext> factory, TimeProvider time,
    ILogger<DownloadedToLibrary> logger) : BackgroundService
{
    private readonly Channel<string> finished = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true });

    public override Task StartAsync(CancellationToken cancellationToken)
    {
        engine.TorrentCompleted += Completed;
        return base.StartAsync(cancellationToken);
    }

    public override Task StopAsync(CancellationToken cancellationToken)
    {
        engine.TorrentCompleted -= Completed;
        return base.StopAsync(cancellationToken);
    }

    private void Completed(object? sender, EngineTorrentCompletedEventArgs e) => finished.Writer.TryWrite(e.Hash);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var hash in finished.Reader.ReadAllAsync(stoppingToken))
        {
            try { await AddAsync(hash, stoppingToken); }
            catch (Exception error) when (!stoppingToken.IsCancellationRequested)
            {
                logger.LogWarning(error, "Could not add the finished download {Hash} to the library", hash);
            }
        }
    }

    public async Task AddAsync(string hash, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var key = hash.Trim().ToLowerInvariant();
        var workId = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.Hash == key && t.WorkId != null)
                .Select(t => t.WorkId).FirstOrDefaultAsync(ct)
            ?? await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.InfoHash != null && t.InfoHash.ToLower() == key)
                .Select(t => t.WorkId).FirstOrDefaultAsync(ct);
        var work = workId == null ? null : await db.Works.AsNoTracking().FirstOrDefaultAsync(w => w.Id == workId, ct);
        if (work == null || work.MediaType is not ("movie" or "tv" or "anime")) return;
        var items = await db.WatchListItems.AsNoTracking().Where(x => x.UserId == LocalUser.Id)
            .Select(x => new { x.WorkId, x.Title, x.MediaType, x.ExternalId }).ToListAsync(ct);
        var externalId = work.ProviderId ?? $"work:{work.WorkKey}";
        if (items.Any(x => x.WorkId == work.Id || x.MediaType == work.MediaType && x.ExternalId == externalId ||
                ReleaseSelection.MatchesWork(work.WorkKey, x.Title))) return;
        var now = time.GetUtcNow().UtcDateTime;
        db.WatchListItems.Add(new WatchListItem { Id = Ids.New(), UserId = LocalUser.Id, WorkId = work.Id, Title = work.CanonicalTitle,
            MediaType = work.MediaType, ExternalId = externalId, PosterUrl = work.PosterUrl, Status = work.MediaType == "movie" ? "completed" : "watching",
            Monitored = false, MonitorMode = HuntCursor.OngoingMode, LatestReleaseMagnet = $"magnet:?xt=urn:btih:{key}", LatestReleaseAt = now,
            LastChecked = now, CreatedAt = now, UpdatedAt = now });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException) { /* Added meanwhile by the owner: his item stands. */ }
    }
}
