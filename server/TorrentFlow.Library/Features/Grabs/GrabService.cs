using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Watchlist;
using TorrentFlow.Library.Features.Storage;

namespace TorrentFlow.Library.Features.Grabs;

public sealed record GrabInput(string Title, string MediaType, EpisodeCursor? Cursor = null,
    string? WatchListItemId = null, string? WorkId = null, int? PreferredResolution = null,
    string Retention = "keep", bool OverrideStorageCap = false, IReadOnlyList<string>? Aliases = null,
    bool Background = false, int? Year = null);

public sealed class GrabService(IDbContextFactory<TorrentFlowDbContext> factory, ITorrentSearchService search, ITorrentEngine engine)
{
    public async Task<GrabResult> Grab(GrabInput input, CancellationToken ct, Func<Task>? beforeSend = null)
    {
        var query = input.Cursor?.Query(input.Title) ?? input.Title;
        await using var db = await factory.CreateDbContextAsync(ct);
        var settings = await db.ClientSettings.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == LocalUser.Id, ct);
        if (settings == null) return new(false, "No torrent client configured") { Query = query };
        int? floor = input.Retention == "stream" ? null : input.PreferredResolution ?? settings.PreferredResolution ?? 1080;
        var names = (input.Aliases ?? []).Prepend(input.Title).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct(StringComparer.OrdinalIgnoreCase).Take(4).ToArray();
        var category = input.MediaType == "movie" ? "movies" : input.MediaType;
        var attempts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var searches = 0;
        var exactBeforeQuality = 0;
        string? lastError = null;
        var rungs = new List<object>();
        // Broaden the query, not the requested scope: packs never become exact episode candidates.
        var ladder = names.Select(n => (Query: input.Cursor?.Query(n) ?? n, Category: category))
            .Concat(input.Cursor == null ? [] : names.SelectMany(n => new[]
            {
                (Query: $"{n} {input.Cursor.Value.Season}x{input.Cursor.Value.Episode:00}", Category: category),
                (Query: $"{n} S{input.Cursor.Value.Season:00}", Category: category),
                (Query: $"{n} - {input.Cursor.Value.Episode:00}", Category: "anime")
            }))
            .Concat(input.MediaType is "anime" or "tv" ? names.Select(n => (Query: input.Cursor?.Query(n) ?? n, Category: "anime")) : [])
            .Distinct().Take(input.Background ? 1 : 16);
        foreach (var rung in ladder)
        {
            var response = await search.SearchAsync(new() { Query = rung.Query, Category = rung.Category, Limit = input.Background ? 15 : 40,
                TargetResolution = floor, Enrich = false, SkipCache = true, Background = input.Background,
                Filters = input.Background ? new() { HasMagnet = true, Season = input.Cursor?.Season, Episode = input.Cursor?.Episode } : new() { MinSeeders = 0 } }, ct);
            searches++;
            var eligible = response.Results.Where(x => ReleaseSelection.SameWork(x, input.Title, input.Aliases ?? [])).ToList();
            exactBeforeQuality += eligible.Count(x => input.Cursor == null || ReleaseSelection.ExactEpisode(x, input.Cursor.Value));
            var quality = eligible.Where(x => ReleaseSelection.MeetsFloor(x.Title, floor)).ToList();
            var candidates = quality.Where(x => input.Cursor == null ? !EpisodeCursor.IsSeries(x.Metadata?.MediaType) && EpisodeCursor.Parse(x.Title) == null &&
                    (input.Year == null || ReleaseSelection.Year(x.Title) == null || ReleaseSelection.Year(x.Title) == input.Year) :
                    ReleaseSelection.ExactEpisode(x, input.Cursor.Value))
                .Where(x => x.Magnet != null || x.TorrentUrl != null || x.InfoHash != null)
                .OrderByDescending(x => x.Seeders >= 3).ThenByDescending(x => ReleaseSelection.Resolution(x.Title) == floor).ThenByDescending(x => x.Score ?? x.Seeders).ToList();
            rungs.Add(new { kind = "exact", query = rung.Query, category = rung.Category, minSeeders = 0,
                fetched = response.Results.Count, workEligible = eligible.Count, qualityEligible = quality.Count, attempted = candidates.Count });
            foreach (var candidate in candidates)
            {
                var identity = LibraryJson.Hash(candidate.InfoHash) ?? LibraryJson.Hash(candidate.Magnet) ?? candidate.TorrentUrl ?? candidate.Id;
                if (!attempts.Add(identity)) continue;
                if (input.Background && input.WatchListItemId != null)
                {
                    var watch = await db.WatchListItems.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == LocalUser.Id && x.Id == input.WatchListItemId, ct);
                    if (watch != null)
                    {
                        if (watch.LatestReleaseMagnet == candidate.Magnet && candidate.Magnet != null ||
                            await db.EngineTorrents.AnyAsync(x => x.UserId == LocalUser.Id && x.Hash == identity && x.Status != "removed", ct))
                        {
                            if (input.Cursor != null) await Advance(db, watch.Id, input.Cursor.Value, candidate.Title, ct);
                            await LogSkip(db, input, query, "Already sent this release", ct);
                            return new(false, "Already sent this release") { Query = query, Skipped = true };
                        }
                        var since = watch.SeederWaitSince ?? DateTime.UtcNow;
                        if (candidate.Seeders < 3 && DateTime.UtcNow - since < TimeSpan.FromHours(6))
                        {
                            var hours = Math.Max(1, Math.Floor(6 - (DateTime.UtcNow - since).TotalHours + .5));
                            var message = $"Waiting for seeders ({candidate.Seeders} of 3) — grabbing anyway in ~{hours}h if no peers arrive";
                            await db.WatchListItems.Where(x => x.Id == watch.Id).ExecuteUpdateAsync(x => x.SetProperty(w => w.SeederWaitSince, since)
                                .SetProperty(w => w.LastChecked, DateTime.UtcNow), ct);
                            await LogSkip(db, input, query, message, ct);
                            return new(false, message) { Query = query, Skipped = true };
                        }
                    }
                }
                if (beforeSend != null) await beforeSend();
                EngineAddResult result;
                try
                {
                    result = await engine.AddAsync(new() { Magnet = candidate.Magnet, TorrentUrl = candidate.TorrentUrl,
                        InfoHash = candidate.InfoHash, Name = candidate.Title, Purpose = input.Retention,
                        QueueKey = input.Cursor?.QueueKey, WorkId = input.WorkId, ExpectedSizeBytes = candidate.SizeBytes,
                        OverrideStorageCap = input.OverrideStorageCap }, ct);
                }
                catch (Exception error) when (!ct.IsCancellationRequested) { result = new(false, error.Message); }
                var hash = LibraryJson.Hash(result.Hash) ?? LibraryJson.Hash(candidate.InfoHash) ?? LibraryJson.Hash(candidate.Magnet);
                var queued = result.Details?.Action == EngineAddDetails.Queued;
                await using var tx = await db.Database.BeginTransactionAsync(ct);
                var now = DateTime.UtcNow;
                db.GrabJobs.Add(new GrabJob { Id = Ids.New(), UserId = LocalUser.Id, Title = candidate.Title, Query = query,
                    Status = result.Ok ? "sent" : "failed", Message = result.Message, Magnet = candidate.Magnet, InfoHash = hash,
                    Source = candidate.Source, Kind = input.Background ? "library" : "ondemand", ExternalId = input.WatchListItemId, Retention = input.Retention,
                    CreatedAt = now, UpdatedAt = now });
                db.DownloadHistories.Add(new DownloadHistory { Id = Ids.New(), UserId = LocalUser.Id, Title = candidate.Title,
                    Status = result.Ok ? "sent" : "failed", Message = result.Message, Magnet = candidate.Magnet, TorrentUrl = candidate.TorrentUrl,
                    InfoHash = hash, Source = candidate.Source, WorkId = input.WorkId, Retention = input.Retention, Context = "ondemand",
                    ClientType = "builtin", SendKind = candidate.Magnet != null ? "magnet" : "torrent", CreatedAt = now });
                var advanced = false;
                if (result.Ok && input.WatchListItemId != null && input.Cursor != null)
                    advanced = await Advance(db, input.WatchListItemId, input.Cursor.Value, candidate.Title, ct);
                if (result.Ok && input.Background && input.WatchListItemId != null)
                    await db.WatchListItems.Where(x => x.Id == input.WatchListItemId).ExecuteUpdateAsync(x =>
                        x.SetProperty(w => w.LatestReleaseMagnet, candidate.Magnet).SetProperty(w => w.CursorMisses, 0)
                            .SetProperty(w => w.SeederWaitSince, (DateTime?)null), ct);
                await db.SaveChangesAsync(ct);
                await tx.CommitAsync(ct);
                if (!result.Ok)
                {
                    lastError = result.Message;
                    if (result.StorageLimit != null)
                        return new(false, result.Message) { Query = query, Storage = StorageFacts.Refusal(settings, result.StorageLimit,
                            result.Message, candidate.SizeBytes, await engine.QueuedReservedBytesAsync(ct)) };
                    continue;
                }
                var next = input.Cursor?.Next();
                return new(true, result.Message + (advanced && !input.Background ? $" · advanced past {input.Cursor?.Label}" : "")) { Query = query, Title = candidate.Title, Magnet = candidate.Magnet, InfoHash = hash,
                    Queued = queued, QueuePosition = result.Details?.QueuePosition, Advanced = advanced,
                    LastEpisode = advanced ? input.Cursor?.Label : null, CursorSeason = advanced ? next?.Season : null,
                    CursorEpisode = advanced ? next?.Episode : null, NextEpisodeHint = advanced ? next?.Query(input.Title) : null };
            }
        }
        var label = input.Cursor?.Label ?? input.Title;
        var qualityLabel = floor == null ? "" : $" at {floor}p or higher";
        var noRelease = $"Couldn't find a working release for {label}{qualityLabel} after {searches} distinct query shape{(searches == 1 ? "" : "s")}. Try again in a bit — another eligible release may show up.";
        if (lastError == null) await LogSkip(db, input, query, noRelease, ct);
        return new(false, lastError ?? noRelease) { Query = query, HuntMiss = lastError == null && exactBeforeQuality == 0, Skipped = lastError == null,
            NoReleaseFound = new { reason = lastError == null ? "no_release" : "send_failed", searches, triedSeasonPacks = false, manualSearchQuery = query, rungs } };
    }

    private static async Task LogSkip(TorrentFlowDbContext db, GrabInput input, string query, string message, CancellationToken ct)
    {
        db.GrabJobs.Add(new() { Id = Ids.New(), UserId = LocalUser.Id, Title = input.Title, Query = query, Status = "skipped",
            Message = message, Kind = input.Background ? "library" : "ondemand", ExternalId = input.WatchListItemId, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync(ct);
    }

    internal static async Task<bool> Advance(TorrentFlowDbContext db, string id, EpisodeCursor grabbed, string title, CancellationToken ct)
    {
        var item = await db.WatchListItems.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.UserId == LocalUser.Id, ct);
        if (item == null || EpisodeCursor.Resolve(item) != grabbed) return false;
        var next = grabbed.Next();
        var now = DateTime.UtcNow;
        var moved = await db.WatchListItems.Where(x => x.Id == id && x.CursorSeason == item.CursorSeason && x.CursorEpisode == item.CursorEpisode)
            .ExecuteUpdateAsync(x => x.SetProperty(w => w.CursorSeason, next.Season).SetProperty(w => w.CursorEpisode, next.Episode)
                .SetProperty(w => w.LastEpisode, grabbed.Label).SetProperty(w => w.NextEpisodeHint, next.Query(item.Title))
                .SetProperty(w => w.CursorMisses, 0).SetProperty(w => w.SeederWaitSince, (DateTime?)null)
                .SetProperty(w => w.LastChecked, now).SetProperty(w => w.UpdatedAt, now)
                .SetProperty(w => w.LatestReleaseTitle, title).SetProperty(w => w.LatestReleaseAt, now)
                .SetProperty(w => w.FromSeason, item.FromSeason ?? grabbed.Season).SetProperty(w => w.FromEpisode, item.FromSeason == null ? grabbed.Episode : item.FromEpisode), ct);
        return moved > 0;
    }
}
