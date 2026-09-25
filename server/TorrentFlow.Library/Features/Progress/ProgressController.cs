using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Grabs;

namespace TorrentFlow.Library.Features.Progress;

[ApiController, Route("api/progress"), ServiceFilter(typeof(LibraryExceptionFilter))]
public sealed class ProgressController(IDbContextFactory<TorrentFlowDbContext> factory, PlaybackNotifications notifications) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get([FromQuery] string? active, [FromQuery] string? infoHash, CancellationToken ct)
    {
        if (active != null && active is not ("0" or "1")) Fields.Fail("active must be one of 0, 1", "active");
        var hash = LibraryJson.Hash(infoHash);
        if (!string.IsNullOrEmpty(infoHash) && hash == null) Fields.Fail("infoHash is not a valid torrent info hash", "infoHash");
        await using var db = await factory.CreateDbContextAsync(ct);
        var rows = await db.PlaybackProgresses.AsNoTracking().Include(x => x.Work).Where(x => x.UserId == LocalUser.Id &&
            (active != "1" || x.CompletedAt == null) && (hash == null || x.InfoHash == hash)).OrderByDescending(x => x.UpdatedAt).Take(50).ToListAsync(ct);
        return Ok(new { entries = rows.Select(x => LibraryJson.Object(("id", x.Id), ("infoHash", x.InfoHash), ("filePath", x.FilePath),
            ("positionSec", x.PositionSec), ("durationSec", x.DurationSec), ("fraction", x.DurationSec > 0 ? Math.Min(x.PositionSec / x.DurationSec.Value, 1) : 0),
            ("completedAt", x.CompletedAt), ("workId", x.WorkId), ("workKey", x.Work?.WorkKey), ("title", x.Work?.CanonicalTitle ?? x.Title),
            ("season", x.Season), ("episode", x.Episode), ("posterUrl", x.PosterUrl), ("watchListItemId", x.WatchListItemId), ("updatedAt", x.UpdatedAt))) });
    }
    [HttpPost]
    public async Task<IActionResult> Post(CancellationToken ct)
    {
        var f = await Fields.Read(Request, ct);
        var raw = f.String("infoHash", true, 64);
        var path = f.String("filePath", true, 4096)!.Replace('\\', '/');
        if (path.Contains('\0') || path.StartsWith('/') || System.Text.RegularExpressions.Regex.IsMatch(path, @"^[A-Za-z]:/") || path.Split('/').Contains(".."))
            Fields.Fail("filePath must be a safe path inside the torrent", "filePath");
        var title = f.String("title", true)!;
        var position = f.Number("positionSec", true)!.Value;
        var duration = f.Number("durationSec", true, double.Epsilon)!.Value;
        var season = f.Int("season", 10000);
        var episode = f.Int("episode");
        var poster = f.String("posterUrl", max: 2048, nullable: true);
        var watchId = f.String("watchListItemId", max: 128, nullable: true);
        var hash = LibraryJson.Hash(raw);
        if (hash == null) Fields.Fail("infoHash is not a valid torrent info hash");
        if (position > duration) Fields.Fail("positionSec cannot exceed durationSec");
        await using var db = await factory.CreateDbContextAsync(ct);
        var workId = await db.EngineTorrents.Where(x => x.UserId == LocalUser.Id && x.Hash == hash).Select(x => x.WorkId).FirstOrDefaultAsync(ct)
            ?? await db.DownloadHistories.Where(x => x.UserId == LocalUser.Id && x.InfoHash == hash).OrderByDescending(x => x.CreatedAt).Select(x => x.WorkId).FirstOrDefaultAsync(ct);
        var work = workId == null ? null : await db.Works.FindAsync([workId], ct);
        title = work?.CanonicalTitle ?? ReleaseSelection.CleanTitle(title);
        if (string.IsNullOrWhiteSpace(title)) title = ReleaseSelection.CleanTitle(Path.GetFileName(path));
        var row = await db.PlaybackProgresses.FirstOrDefaultAsync(x => x.UserId == LocalUser.Id && x.InfoHash == hash && x.FilePath == path, ct);
        if (row == null)
        {
            row = new PlaybackProgress { Id = Ids.New(), UserId = LocalUser.Id, InfoHash = hash!, FilePath = path, Title = title, CreatedAt = DateTime.UtcNow };
            db.PlaybackProgresses.Add(row);
        }
        row.PositionSec = position; row.DurationSec = duration; row.Title = title; row.Season = season; row.Episode = episode;
        row.PosterUrl = poster; row.WatchListItemId = watchId; row.WorkId = workId; row.UpdatedAt = DateTime.UtcNow;
        if (position / duration >= .9) row.CompletedAt ??= DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        notifications.Publish(new(LocalUser.Id, hash!, title, season, episode, watchId, position, duration));
        return Ok(LibraryJson.Object(("ok", true), ("id", row.Id), ("completedAt", row.CompletedAt)));
    }
}
