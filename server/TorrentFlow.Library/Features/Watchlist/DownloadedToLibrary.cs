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
/// Each finished download is taken into account once (<see cref="EngineTorrent.LibraryCheckedAt"/>). At start every
/// finished download not yet taken into account is caught up, which adds those that finished before this existed and
/// resumes a catch-up a crash or stop cut short.
/// </summary>
public sealed class DownloadedToLibrary(ITorrentEngine engine, IDbContextFactory<TorrentFlowDbContext> factory,
    TimeProvider time, ILogger<DownloadedToLibrary> logger) : BackgroundService
{
    private const int Batch = 200;
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
        try { await CatchUpAsync(stoppingToken); }
        catch (Exception error) when (!stoppingToken.IsCancellationRequested)
        {
            logger.LogWarning(error, "Could not add downloads that finished earlier to the library; trying again at the next start");
        }
        await foreach (var hash in finished.Reader.ReadAllAsync(stoppingToken))
        {
            try { await AddAsync(hash, stoppingToken); }
            catch (Exception error) when (!stoppingToken.IsCancellationRequested)
            {
                logger.LogWarning(error, "Could not add the finished download {Hash} to the library", hash);
            }
        }
    }

    /// <summary>Every finished download not yet taken into account, in batches; each batch is saved with its marks.</summary>
    public async Task<Outcome> CatchUpAsync(CancellationToken ct)
    {
        var total = new Outcome(0, 0, 0, 0);
        while (true)
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            var rows = await Finished(db).Where(t => t.LibraryCheckedAt == null).OrderBy(t => t.CreatedAt).Take(Batch).ToListAsync(ct);
            if (rows.Count == 0) break;
            total += await TakeIntoAccountAsync(db, rows, ct);
            if (rows.Count < Batch) break;
        }
        if (total.Checked > 0)
            logger.LogInformation("Took {Checked} finished downloads into account for the library: added {Added}, {Already} already there, {Gone} with their files gone",
                total.Checked, total.Added, total.Already, total.Gone);
        return total;
    }

    /// <summary>A download that just finished, whether or not it was taken into account before (a re-check finishes again).</summary>
    public async Task AddAsync(string hash, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var key = hash.Trim().ToLowerInvariant();
        var rows = await Finished(db).Where(t => t.Hash == key).ToListAsync(ct);
        if (rows.Count > 0) await TakeIntoAccountAsync(db, rows, ct);
    }

    // Finished = promoted into the library, the one done-ness predicate: a download still in staging, held or rejected
    // is not in the Library yet (docs/english-gates-plan.md section 1).
    private static IQueryable<EngineTorrent> Finished(TorrentFlowDbContext db) =>
        db.EngineTorrents.Where(t => t.UserId == LocalUser.Id
            && t.Status != EngineTorrentStatus.Error && t.Status != EngineTorrentStatus.Removed).Where(EngineTorrent.Downloaded);

    public readonly record struct Outcome(int Checked, int Added, int Already, int Gone)
    {
        public static Outcome operator +(Outcome a, Outcome b) =>
            new(a.Checked + b.Checked, a.Added + b.Added, a.Already + b.Already, a.Gone + b.Gone);
    }

    /// <summary>
    /// Adds the titles of <paramref name="rows"/> (tracked) in one pass: their works and the Library are read once, and
    /// the new items and the marks are saved together, so a failure leaves every row to be tried again.
    /// </summary>
    private async Task<Outcome> TakeIntoAccountAsync(TorrentFlowDbContext db, List<EngineTorrent> rows, CancellationToken ct)
    {
        var unlinked = rows.Where(r => r.WorkId == null).Select(r => r.Hash.ToLowerInvariant()).ToList();
        var fromTargets = unlinked.Count == 0 ? [] : (await db.AcquisitionTargets.AsNoTracking()
                .Where(t => t.UserId == LocalUser.Id && t.InfoHash != null && t.WorkId != null && unlinked.Contains(t.InfoHash.ToLower()))
                .Select(t => new { Hash = t.InfoHash!.ToLower(), t.WorkId }).ToListAsync(ct))
            .GroupBy(t => t.Hash).ToDictionary(g => g.Key, g => g.First().WorkId!);
        string? WorkOf(EngineTorrent r) => r.WorkId ?? fromTargets.GetValueOrDefault(r.Hash.ToLowerInvariant());
        var workIds = rows.Select(WorkOf).OfType<string>().Distinct().ToList();
        var works = await db.Works.AsNoTracking().Where(w => workIds.Contains(w.Id)).ToDictionaryAsync(w => w.Id, ct);
        var items = await db.WatchListItems.AsNoTracking().Where(x => x.UserId == LocalUser.Id)
            .Select(x => new Held(x.WorkId, x.Title, x.MediaType, x.ExternalId, x.Provider)).ToListAsync(ct);
        var now = time.GetUtcNow().UtcDateTime;
        int added = 0, already = 0, gone = 0;
        foreach (var row in rows)
        {
            row.LibraryCheckedAt = now;
            if (WorkOf(row) is not { } workId || !works.TryGetValue(workId, out var work) || work.MediaType is not ("movie" or "tv" or "anime")) continue;
            if (!OnDisk(row)) { gone++; continue; }
            var externalId = work.ProviderId ?? $"work:{work.WorkKey}";
            // The catalog the id belongs to, as the watchlist records it (an id alone can clash across catalogs).
            var provider = work.ProviderId != null ? work.Provider ?? "" : "";
            if (items.Any(x => x.WorkId == work.Id || x.MediaType == work.MediaType && x.ExternalId == externalId && (x.Provider == provider || x.Provider == "") ||
                    ReleaseSelection.MatchesWork(work.WorkKey, x.Title))) { already++; continue; }
            db.WatchListItems.Add(new WatchListItem { Id = Ids.New(), UserId = LocalUser.Id, WorkId = work.Id, Title = work.CanonicalTitle,
                MediaType = work.MediaType, ExternalId = externalId, Provider = provider, PosterUrl = work.PosterUrl, Status = work.MediaType == "movie" ? "completed" : "watching",
                Monitored = false, MonitorMode = HuntCursor.OngoingMode, LatestReleaseMagnet = $"magnet:?xt=urn:btih:{row.Hash.ToLowerInvariant()}",
                LatestReleaseAt = now, LastChecked = now, CreatedAt = now, UpdatedAt = now });
            items.Add(new Held(work.Id, work.CanonicalTitle, work.MediaType, externalId, provider));
            added++;
        }
        await db.SaveChangesAsync(ct);
        return new Outcome(rows.Count, added, already, gone);
    }

    private sealed record Held(string? WorkId, string Title, string MediaType, string ExternalId, string Provider);

    // The engine's record of where each file landed decides (a release's folder is not always kept); a row that
    // records none falls back to its name under its save folder.
    private static bool OnDisk(EngineTorrent row)
    {
        if (VerifiedFiles.StillOnDisk(row.VerifiedFilesJson) is { } recorded) return recorded;
        if (string.IsNullOrWhiteSpace(row.SavePath)) return false;
        try
        {
            var full = Path.Combine(row.SavePath, row.Name);
            return File.Exists(full) || Directory.Exists(full) && Directory.EnumerateFileSystemEntries(full).Any();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException) { return false; }
    }
}
