using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>
/// Brings an anime work's stored episode numbers to its current season shape, once per change. Before seasons followed
/// the AniList sequel chain, a first season's page used the show listing's numbers (TMDB's Frieren S1E29-38) and a
/// sequel entry's page its own Season 1; rows saved then (wanted targets, the library cursor, transfer queue keys,
/// tried and blocked releases) would stay on numbers no page shows, never be found, and collide with the same episodes
/// under their new numbers. Each coordinate is mapped through its absolute episode and merged into the new key. The
/// numbering applied is kept on the work (<see cref="Work.NumberingJson"/>), so it runs again only when the shape
/// changes. A provisional numbering (AniList cut the walk short) is never applied.
/// </summary>
public sealed class AnimeNumberingReconciler(IDbContextFactory<TorrentFlowDbContext> factory, ISeasonShapeLookup shapes,
    TimeProvider time, ILogger<AnimeNumberingReconciler> logger) : BackgroundService
{
    private static readonly TimeSpan StartDelay = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan Every = TimeSpan.FromHours(1);
    private readonly SemaphoreSlim gate = new(1, 1);

    /// <summary>One run of episodes numbered in a row: absolute <see cref="Start"/> is <see cref="Season"/> episode <see cref="Episode"/>.</summary>
    private sealed record Segment(int Start, int Season, int Episode, int Count);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(StartDelay, time, stoppingToken); }
        catch (OperationCanceledException) { return; }
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await ReconcileAllAsync(null, stoppingToken); }
            catch (Exception error) when (!stoppingToken.IsCancellationRequested) { logger.LogWarning(error, "Anime numbering check failed"); }
            try { await Task.Delay(Every, time, stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    /// <summary>Every AniList work with wanted rows or a library row (or only <paramref name="workIds"/>).</summary>
    public async Task ReconcileAllAsync(IReadOnlyCollection<string>? workIds, CancellationToken ct)
    {
        List<string> keys;
        await using (var db = await factory.CreateDbContextAsync(ct))
        {
            var query = db.Works.AsNoTracking().Where(w => w.Provider == "anilist" && w.ProviderId != null &&
                (w.AcquisitionTargets.Any() || w.WatchListItems.Any()));
            if (workIds != null) query = query.Where(w => workIds.Contains(w.Id));
            keys = await query.Select(w => w.WorkKey).ToListAsync(ct);
        }
        foreach (var key in keys)
        {
            try { await ReconcileAsync(key, ct); }
            catch (Exception error) when (!ct.IsCancellationRequested) { logger.LogWarning(error, "Anime numbering of {WorkKey} failed", key); }
        }
    }

    /// <summary>Renumbers one work's rows when its season shape changed since they were last brought to it. True when anything moved.</summary>
    public async Task<bool> ReconcileAsync(string workKey, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            var work = await db.Works.FirstOrDefaultAsync(w => w.WorkKey == workKey, ct);
            if (work is not { Provider: "anilist", ProviderId: not null }) return false;
            var numbering = await shapes.GetNumberingAsync(new(work.WorkKey, work.CanonicalTitle, work.Year, work.MediaType, work.Provider,
                work.ProviderId, 1), ct);
            if (numbering is not { Provisional: false, Episodes.Count: > 0 }) return false;
            var segments = Segments(numbering.Episodes.OrderBy(e => e.Absolute).Select(e => (e.Absolute, e.Season, e.Episode)));
            var applied = JsonSerializer.Serialize(segments);
            if (work.NumberingJson == applied) return false;
            var now = numbering.Episodes.GroupBy(e => e.Absolute).ToDictionary(g => g.Key, g => (g.First().Season, g.First().Episode));
            var before = Previous(work.NumberingJson, numbering.Episodes);
            (int Season, int Episode)? Map(int season, int episode) =>
                before.TryGetValue((season, episode), out var absolute) && now.TryGetValue(absolute, out var current) && current != (season, episode)
                    ? current : null;
            var moved = await MoveTargetsAsync(db, work, Map, ct);
            moved += await MoveCursorsAsync(db, work, Map, ct);
            moved += await MoveQueueKeysAsync(db, work, Map, ct);
            moved += await MoveReleasesAsync(db, work, Map, ct);
            work.NumberingJson = applied;
            await db.SaveChangesAsync(ct);
            if (moved > 0) logger.LogInformation("Renumbered {Count} stored episodes of {WorkKey} to its show's seasons", moved, workKey);
            return moved > 0;
        }
        finally { gate.Release(); }
    }

    private static List<Segment> Segments(IEnumerable<(int Absolute, int Season, int Episode)> episodes)
    {
        var segments = new List<Segment>();
        foreach (var (absolute, season, episode) in episodes)
        {
            if (segments.Count > 0 && segments[^1] is var last && last.Season == season && last.Start + last.Count == absolute &&
                last.Episode + last.Count == episode)
                segments[^1] = last with { Count = last.Count + 1 };
            else segments.Add(new(absolute, season, episode, 1));
        }
        return segments;
    }

    /// <summary>
    /// The numbering rows were saved under: the one last applied, or (never applied) the pre-chain page's numbers plus
    /// the show listing's lumped numbering (season 1, absolute episode) where those name nothing else.
    /// </summary>
    private static Dictionary<(int Season, int Episode), int> Previous(string? stored, IReadOnlyList<NumberedEpisode> episodes)
    {
        var map = new Dictionary<(int, int), int>();
        if (stored is not null)
        {
            try
            {
                foreach (var s in JsonSerializer.Deserialize<List<Segment>>(stored) ?? [])
                    for (var i = 0; i < s.Count; i++) map.TryAdd((s.Season, s.Episode + i), s.Start + i);
                return map;
            }
            catch (JsonException) { map.Clear(); }
        }
        foreach (var e in episodes) map.TryAdd((e.LegacySeason, e.LegacyEpisode), e.Absolute);
        foreach (var e in episodes) map.TryAdd((1, e.Absolute), e.Absolute);
        return map;
    }

    private static int Rank(AcquisitionTarget t) => t.Status switch
    {
        "downloaded" => 5, "downloading" => 4, "queued" when t.InfoHash != null => 3, "queued" => 2, _ => 1
    };

    private async Task<int> MoveTargetsAsync(TorrentFlowDbContext db, Work work, Func<int, int, (int Season, int Episode)?> map, CancellationToken ct)
    {
        var rows = await db.AcquisitionTargets.Where(t => t.UserId == LocalUser.Id && t.Scope == "episode" && t.Season != null &&
            t.Episode != null && (t.WorkKey == work.WorkKey || t.WorkId == work.Id)).ToListAsync(ct);
        var final = rows.ToDictionary(t => t, t => map(t.Season!.Value, t.Episode!.Value));
        if (final.Values.All(v => v is null)) return 0;
        var moved = 0;
        // Two phases: every moved row first steps aside, so a swap of two keys never trips the unique key.
        foreach (var group in rows.GroupBy(t => final[t] ?? (t.Season!.Value, t.Episode!.Value)))
        {
            var keep = group.OrderByDescending(Rank).ThenBy(t => final[t] is null ? 0 : 1).ThenByDescending(t => t.UpdatedAt).First();
            foreach (var other in group.Where(t => t != keep))
            {
                keep.RunId ??= other.RunId;
                keep.ClickedAt ??= other.ClickedAt;
                db.AcquisitionTargets.Remove(other);
                moved++;
            }
            if (final[keep] is { } to)
            {
                keep.Season = to.Season;
                keep.Episode = to.Episode;
                keep.TargetKey = $"{WantedQueue.TargetKey(keep.WorkKey, keep.Scope, to.Season, to.Episode)}:renumber:{keep.Id}";
                moved++;
            }
        }
        await db.SaveChangesAsync(ct);
        foreach (var row in rows.Where(t => db.Entry(t).State != EntityState.Detached && t.TargetKey.Contains(":renumber:", StringComparison.Ordinal)))
            row.TargetKey = WantedQueue.TargetKey(row.WorkKey, row.Scope, row.Season, row.Episode);
        await db.SaveChangesAsync(ct);
        return moved;
    }

    private static async Task<int> MoveCursorsAsync(TorrentFlowDbContext db, Work work, Func<int, int, (int Season, int Episode)?> map, CancellationToken ct)
    {
        var items = await db.WatchListItems.Where(x => x.UserId == LocalUser.Id && x.WorkId == work.Id).ToListAsync(ct);
        var moved = 0;
        foreach (var item in items)
        {
            var changed = false;
            if (item is { CursorSeason: { } cs, CursorEpisode: { } ce } && map(cs, ce) is { } cursor)
            {
                (item.CursorSeason, item.CursorEpisode) = cursor;
                item.NextEpisodeHint = new EpisodeCursor(cursor.Season, cursor.Episode).Query(item.Title);
                changed = true;
            }
            if (item is { FromSeason: { } fs } && map(fs, item.FromEpisode ?? 1) is { } from)
            {
                (item.FromSeason, item.FromEpisode) = from;
                changed = true;
            }
            if (EpisodeCursor.Parse(item.LastEpisode) is { } last && map(last.Season, last.Episode) is { } lastNow)
            {
                item.LastEpisode = new EpisodeCursor(lastNow.Season, lastNow.Episode).Label;
                changed = true;
            }
            if (item.CursorSeason is null && EpisodeCursor.Parse(item.NextEpisodeHint) is { } hint && map(hint.Season, hint.Episode) is { } hinted)
            {
                item.NextEpisodeHint = new EpisodeCursor(hinted.Season, hinted.Episode).Query(item.Title);
                changed = true;
            }
            if (changed) moved++;
        }
        return moved;
    }

    private static async Task<int> MoveQueueKeysAsync(TorrentFlowDbContext db, Work work, Func<int, int, (int Season, int Episode)?> map, CancellationToken ct)
    {
        var torrents = await db.EngineTorrents.Where(t => t.UserId == LocalUser.Id && t.WorkId == work.Id && t.QueueKey != null).ToListAsync(ct);
        var moved = 0;
        foreach (var torrent in torrents)
            if (QueueKeys.Parse(torrent.QueueKey) is { } key && map(key.Season, key.Episode) is { } to)
            {
                torrent.QueueKey = QueueKeys.For(to.Season, to.Episode);
                moved++;
            }
        return moved;
    }

    /// <summary>Releases tried or blocked for one episode keep naming that episode.</summary>
    private static async Task<int> MoveReleasesAsync(TorrentFlowDbContext db, Work work, Func<int, int, (int Season, int Episode)?> map, CancellationToken ct)
    {
        var moved = 0;
        var attempts = await db.ReleaseAttempts.Where(r => r.UserId == LocalUser.Id && r.WorkKey == work.WorkKey).ToListAsync(ct);
        var have = attempts.Select(r => (r.Scope, r.Hash)).ToHashSet();
        foreach (var attempt in attempts)
        {
            if (QueueKeys.Parse(attempt.Scope) is not { } key || map(key.Season, key.Episode) is not { } to) continue;
            var scope = QueueKeys.For(to.Season, to.Episode);
            db.ReleaseAttempts.Remove(attempt);
            if (have.Add((scope, attempt.Hash)))
                db.ReleaseAttempts.Add(new() { UserId = attempt.UserId, WorkKey = attempt.WorkKey, Scope = scope, Hash = attempt.Hash, TriedAt = attempt.TriedAt });
            moved++;
        }
        var blocks = await db.ReleaseBlocks.Where(b => b.UserId == LocalUser.Id && b.WorkKey == work.WorkKey).ToListAsync(ct);
        foreach (var block in blocks)
            if (QueueKeys.Parse(block.Scope) is { } key && map(key.Season, key.Episode) is { } to)
            {
                block.Scope = QueueKeys.For(to.Season, to.Episode);
                moved++;
            }
        return moved;
    }
}
