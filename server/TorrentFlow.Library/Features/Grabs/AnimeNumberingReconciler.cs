using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Engine;
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
/// under their new numbers. Each coordinate is mapped through its absolute episode and merged into the new key, all in
/// one transaction with the numbering applied (<see cref="Work.NumberingJson"/>), so it runs again only when the shape
/// changes. A provisional numbering (AniList cut the walk short) is never applied, and nothing moves while a grab of the
/// work is in flight (<see cref="WorkGrabGate"/>). Finished episodes filed under the old numbers (a sequel entry's own
/// folder, the wrong season) are then moved to the show's season folder once the client has let go of them.
/// </summary>
public sealed class AnimeNumberingReconciler(IDbContextFactory<TorrentFlowDbContext> factory, ISeasonShapeLookup shapes,
    TimeProvider time, ILogger<AnimeNumberingReconciler> logger, ITorrentEngine? engine = null) : BackgroundService
{
    private static readonly TimeSpan StartDelay = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan Every = TimeSpan.FromHours(1);
    /// <summary>A work already brought to its shape is looked at again only this often (its franchise may have grown).</summary>
    private static readonly TimeSpan Recheck = TimeSpan.FromHours(12);
    /// <summary>The background pass spaces its AniList lookups so it never competes with pages and grabs for the rate limit.</summary>
    private static readonly TimeSpan Pace = TimeSpan.FromSeconds(3);
    /// <summary>At most this many works are looked at per pass; the rest wait for the next one (an hour later).</summary>
    private const int PerPass = 12;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly DateTime started = time.GetUtcNow().UtcDateTime;
    private readonly ConcurrentDictionary<string, DateTime> checkedAt = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> movedKeys = new(StringComparer.Ordinal);
    /// <summary>Works whose finished files could not move yet (still seeding): the next pass tries them again.</summary>
    private readonly ConcurrentDictionary<string, byte> filesPending = new(StringComparer.Ordinal);
    /// <summary>Works whose rows need renumbering that a grab in flight put off: nothing may be searched with their old numbers.</summary>
    private readonly ConcurrentDictionary<string, byte> waiting = new(StringComparer.Ordinal);

    /// <summary>One run of episodes numbered in a row: absolute <see cref="Start"/> is <see cref="Season"/> episode <see cref="Episode"/>.</summary>
    private sealed record Segment(int Start, int Season, int Episode, int Count);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(StartDelay, time, stoppingToken); }
        catch (OperationCanceledException) { return; }
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await ReconcileDueAsync(stoppingToken); }
            catch (Exception error) when (!stoppingToken.IsCancellationRequested) { logger.LogWarning(error, "Anime numbering check failed"); }
            try { await Task.Delay(Every, time, stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    /// <summary>The key a wanted row moved to when its work was renumbered (followed to its latest), or null.</summary>
    public string? MovedKey(string key)
    {
        string? found = null;
        for (var hops = 0; hops < 8 && movedKeys.TryGetValue(found ?? key, out var next); hops++) found = next;
        return found;
    }

    /// <summary>
    /// True while the work's stored rows still carry numbers its show no longer uses because a grab in flight put the
    /// renumbering off (<see cref="ReconcileAsync"/>): a wanted run or a hunt of the work waits instead of searching them.
    /// </summary>
    public bool Waiting(string workKey) => waiting.ContainsKey(workKey);

    /// <summary>
    /// The background pass: AniList works with wanted or library rows that were never brought to a shape, still have
    /// files waiting to move, or were last looked at more than <see cref="Recheck"/> ago (since this process started),
    /// in that order, at most <see cref="PerPass"/> of them, one every <see cref="Pace"/>. Grabs and the hunter renumber
    /// the work they are about to use themselves, so this pass is never waited on.
    /// </summary>
    public async Task ReconcileDueAsync(CancellationToken ct)
    {
        List<(string Key, bool Applied)> works;
        await using (var db = await factory.CreateDbContextAsync(ct))
            works = (await db.Works.AsNoTracking().Where(w => w.Provider == "anilist" && w.ProviderId != null &&
                    (w.AcquisitionTargets.Any() || w.WatchListItems.Any()))
                .Select(w => new { w.WorkKey, Applied = w.NumberingJson != null }).ToListAsync(ct))
                .Select(w => (w.WorkKey, w.Applied)).ToList();
        var now = time.GetUtcNow().UtcDateTime;
        var due = works.Where(w => !w.Applied || filesPending.ContainsKey(w.Key) ||
                now - checkedAt.GetValueOrDefault(w.Key, started) >= Recheck)
            .OrderBy(w => w.Applied).ThenBy(w => filesPending.ContainsKey(w.Key) ? 0 : 1)
            .ThenBy(w => checkedAt.GetValueOrDefault(w.Key, started)).Take(PerPass).Select(w => w.Key).ToList();
        foreach (var key in due)
        {
            try { await ReconcileAsync(key, ct); }
            catch (Exception error) when (!ct.IsCancellationRequested) { logger.LogWarning(error, "Anime numbering of {WorkKey} failed", key); }
            // Round robin: a work AniList did not answer for goes behind the others instead of being asked first again.
            checkedAt[key] = time.GetUtcNow().UtcDateTime;
            await Task.Delay(Pace, time, ct);
        }
    }

    /// <summary>
    /// Renumbers one work's rows when its season shape changed since they were last brought to it, then moves its
    /// misfiled finished episodes. True when any row moved. Skipped (false) while a grab of the work is in flight.
    /// </summary>
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
            checkedAt[workKey] = time.GetUtcNow().UtcDateTime;
            var segments = Segments(numbering.Episodes.OrderBy(e => e.Absolute).Select(e => (e.Absolute, e.Season, e.Episode)));
            var applied = JsonSerializer.Serialize(segments);
            var sequel = numbering.ShowTitle != null;
            if (work.NumberingJson == applied) waiting.TryRemove(workKey, out _);
            if (work.NumberingJson == applied && !sequel && !filesPending.ContainsKey(workKey)) return false;
            using var hold = WorkGrabGate.TryRenumber(work.Id);
            if (hold == null)
            {
                if (work.NumberingJson != applied)
                {
                    waiting[workKey] = 0;
                    logger.LogInformation("Numbering of {WorkKey} waits for its grab in flight", workKey);
                }
                return false;
            }
            var moved = work.NumberingJson == applied ? 0 : await RenumberAsync(db, work, numbering, applied, ct);
            waiting.TryRemove(workKey, out _);
            if (engine != null)
            {
                try { await RelocateFilesAsync(work, numbering, ct); }
                catch (Exception error) when (!ct.IsCancellationRequested) { logger.LogWarning(error, "Moving the finished episodes of {WorkKey} failed", workKey); }
            }
            return moved > 0;
        }
        finally { gate.Release(); }
    }

    /// <summary>Every stored coordinate, the merge of collisions and the applied numbering, in one transaction.</summary>
    private async Task<int> RenumberAsync(TorrentFlowDbContext db, Work work, AnimeNumbering numbering, string applied, CancellationToken ct)
    {
        var now = numbering.Episodes.GroupBy(e => e.Absolute).ToDictionary(g => g.Key, g => (g.First().Season, g.First().Episode));
        var before = Previous(work.NumberingJson, numbering.Episodes);
        (int Season, int Episode)? Map(int season, int episode) =>
            before.TryGetValue((season, episode), out var absolute) && now.TryGetValue(absolute, out var current) && current != (season, episode)
                ? current : null;
        var keys = new Dictionary<string, string>(StringComparer.Ordinal);
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var moved = await MoveTargetsAsync(db, work, Map, keys, ct);
        moved += await MoveCursorsAsync(db, work, Map, ct);
        moved += await MoveQueueKeysAsync(db, work, Map, ct);
        moved += await MoveReleasesAsync(db, work, Map, ct);
        work.NumberingJson = applied;
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        foreach (var (from, to) in keys) movedKeys[from] = to;
        if (moved > 0) logger.LogInformation("Renumbered {Count} stored episodes of {WorkKey} to its show's seasons", moved, work.WorkKey);
        return moved;
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

    /// <summary>How far a row got: a finished transfer beats a live one, a live one a found release, that a plain wish.</summary>
    private static int Rank(AcquisitionTarget t) => t.Status switch
    {
        "downloaded" => 5, "downloading" => 4, "queued" when t.InfoHash != null => 3, "queued" => 2, _ => t.InfoHash != null ? 1 : 0
    };

    /// <summary>
    /// Moves each target to its episode's new key. Two rows landing on one key merge: the one furthest along keeps the
    /// key; a row with no transfer of its own folds into it (its run, click and misses kept); a row with a different
    /// transfer keeps that transfer linked under a key of its own, every field as it was.
    /// </summary>
    private static async Task<int> MoveTargetsAsync(TorrentFlowDbContext db, Work work, Func<int, int, (int Season, int Episode)?> map,
        Dictionary<string, string> keys, CancellationToken ct)
    {
        var rows = await db.AcquisitionTargets.Where(t => t.UserId == LocalUser.Id && t.Scope == "episode" && t.Season != null &&
            t.Episode != null && (t.WorkKey == work.WorkKey || t.WorkId == work.Id)).ToListAsync(ct);
        var final = rows.ToDictionary(t => t, t => map(t.Season!.Value, t.Episode!.Value));
        if (final.Values.All(v => v is null)) return 0;
        var moved = 0;
        var settled = new Dictionary<AcquisitionTarget, string>();
        var original = rows.ToDictionary(t => t, t => t.TargetKey);
        foreach (var group in rows.GroupBy(t => final[t] ?? (t.Season!.Value, t.Episode!.Value)))
        {
            var (season, episode) = group.Key;
            var ordered = group.OrderByDescending(Rank).ThenBy(t => final[t] is null ? 0 : 1).ThenByDescending(t => t.UpdatedAt).ToList();
            var keep = ordered[0];
            settled[keep] = WantedQueue.TargetKey(keep.WorkKey, keep.Scope, season, episode);
            foreach (var other in ordered.Skip(1))
            {
                if (other.InfoHash != null && !string.Equals(other.InfoHash, keep.InfoHash, StringComparison.OrdinalIgnoreCase))
                {
                    settled[other] = $"{WantedQueue.TargetKey(other.WorkKey, other.Scope, season, episode)}:dup:{other.Id}";
                    continue;
                }
                keep.RunId ??= other.RunId;
                keep.ClickedAt ??= other.ClickedAt;
                keep.PreferredResolution ??= other.PreferredResolution;
                keep.RealMisses = Math.Max(keep.RealMisses, other.RealMisses);
                if (keep.InfoHash != null && other.InfoHash != null)
                {
                    keep.FileIndex ??= other.FileIndex;
                    keep.FilePath ??= other.FilePath;
                }
                keys[original[other]] = settled[keep];
                db.AcquisitionTargets.Remove(other);
                moved++;
            }
        }
        // Two phases: every moved row first steps aside, so a swap of two keys never trips the unique key.
        foreach (var (row, key) in settled.Where(s => s.Key.TargetKey != s.Value))
        {
            row.Season = final[row]?.Season ?? row.Season;
            row.Episode = final[row]?.Episode ?? row.Episode;
            row.TargetKey = $"{key}:renumber:{row.Id}";
            moved++;
        }
        await db.SaveChangesAsync(ct);
        foreach (var (row, key) in settled.Where(s => s.Key.TargetKey.EndsWith($":renumber:{s.Key.Id}", StringComparison.Ordinal)))
        {
            row.TargetKey = key;
            keys[original[row]] = key;
        }
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

    private const string SeasonScope = "season:";
    private const string NotMoved = "Not moved to ";

    /// <summary>
    /// A tried or blocked release's scope as numbered now: an episode's queue key, or a season pack's <c>season:N</c>
    /// (the season its first episode is in now). Null when it did not move.
    /// </summary>
    private static string? Rescope(string scope, Func<int, int, (int Season, int Episode)?> map)
    {
        if (QueueKeys.Parse(scope) is { } key) return map(key.Season, key.Episode) is { } to ? QueueKeys.For(to.Season, to.Episode) : null;
        if (scope.StartsWith(SeasonScope, StringComparison.Ordinal) && int.TryParse(scope[SeasonScope.Length..], out var season) &&
            map(season, 1) is { } first && first.Season != season)
            return $"{SeasonScope}{first.Season}";
        return null;
    }

    /// <summary>Releases tried or blocked for one episode or season keep naming it; two records of one release merge.</summary>
    private static async Task<int> MoveReleasesAsync(TorrentFlowDbContext db, Work work, Func<int, int, (int Season, int Episode)?> map, CancellationToken ct)
    {
        var moved = 0;
        var attempts = await db.ReleaseAttempts.Where(r => r.UserId == LocalUser.Id && r.WorkKey == work.WorkKey).ToListAsync(ct);
        var kept = attempts.Where(r => Rescope(r.Scope, map) is null).ToDictionary(r => (r.Scope, r.Hash));
        foreach (var attempt in attempts)
        {
            if (Rescope(attempt.Scope, map) is not { } scope) continue;
            db.ReleaseAttempts.Remove(attempt);
            if (kept.TryGetValue((scope, attempt.Hash), out var existing))
            {
                if (attempt.TriedAt > existing.TriedAt) existing.TriedAt = attempt.TriedAt;
            }
            else
            {
                var added = new ReleaseAttempt { UserId = attempt.UserId, WorkKey = attempt.WorkKey, Scope = scope, Hash = attempt.Hash, TriedAt = attempt.TriedAt };
                db.ReleaseAttempts.Add(added);
                kept[(scope, attempt.Hash)] = added;
            }
            moved++;
        }
        // A block is keyed by its release alone, so it only takes its new scope.
        var blocks = await db.ReleaseBlocks.Where(b => b.UserId == LocalUser.Id && b.WorkKey == work.WorkKey).ToListAsync(ct);
        foreach (var block in blocks)
            if (Rescope(block.Scope, map) is { } scope)
            {
                block.Scope = scope;
                moved++;
            }
        return moved;
    }

    /// <summary>
    /// Finished episodes filed where the show no longer files them (a sequel entry's own folder, or the season they had
    /// before renumbering) move to <c>&lt;show&gt;\Season NN</c>. Only transfers the client has let go of move; one
    /// still seeding is tried again on a later pass. A clash is never overwritten and is reported on the row.
    /// </summary>
    private async Task RelocateFilesAsync(Work work, AnimeNumbering numbering, CancellationToken ct)
    {
        var show = numbering.ShowTitle ?? work.CanonicalTitle;
        var showFolder = MediaFolders.Name(show);
        await using var db = await factory.CreateDbContextAsync(ct);
        var rows = await db.AcquisitionTargets.Where(t => t.UserId == LocalUser.Id && t.Scope == "episode" && t.Status == "downloaded" &&
            t.InfoHash != null && t.Season != null && (t.WorkKey == work.WorkKey || t.WorkId == work.Id)).ToListAsync(ct);
        var hashes = rows.Select(t => t.InfoHash!).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var saved = await db.EngineTorrents.AsNoTracking().Where(e => e.UserId == LocalUser.Id && hashes.Contains(e.Hash))
            .ToDictionaryAsync(e => e.Hash, e => e.SavePath, StringComparer.OrdinalIgnoreCase, ct);
        var pending = false;
        foreach (var group in rows.GroupBy(t => (Hash: t.InfoHash!.ToLowerInvariant(), Season: t.Season!.Value)))
        {
            if (saved.GetValueOrDefault(group.Key.Hash) is not { Length: > 0 } savePath) continue;
            var expected = Path.Combine(showFolder, MediaFolders.Season(group.Key.Season));
            if (Path.TrimEndingDirectorySeparator(savePath).EndsWith(Path.DirectorySeparatorChar + expected, StringComparison.OrdinalIgnoreCase)) continue;
            // The show's own rows move only out of a season folder that is not theirs (renumbered); a sequel entry's always join the show.
            if (numbering.ShowTitle == null && string.Equals(Path.GetFileName(Path.TrimEndingDirectorySeparator(savePath)),
                    MediaFolders.Season(group.Key.Season), StringComparison.OrdinalIgnoreCase)) continue;
            var outcome = await engine!.RelocateAsync(group.Key.Hash, new(show, numbering.ShowYear ?? work.Year, true, false, group.Key.Season), ct);
            if (outcome.Moved && outcome is { From: { } from, To: { } to })
            {
                foreach (var row in group)
                {
                    if (row.FilePath is { } file && Path.GetFullPath(file).StartsWith(from + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        row.FilePath = Path.Combine(to, Path.GetRelativePath(from, Path.GetFullPath(file)));
                    // Only an earlier "Not moved" note goes; any other reason on the row stays.
                    if (row.Error?.StartsWith(NotMoved, StringComparison.Ordinal) == true) row.Error = null;
                    row.UpdatedAt = time.GetUtcNow().UtcDateTime;
                }
                logger.LogInformation("Moved {Show} season {Season} episodes {Episodes} from {From} to {To}", show, group.Key.Season,
                    string.Join(",", group.Select(t => t.Episode)), from, to);
            }
            else if (outcome.Problem == EngineRelocation.NotParked) pending = true;
            else if (outcome.Problem == EngineRelocation.Clash)
            {
                foreach (var row in group)
                    row.Error = $"{NotMoved}{outcome.To}: {Path.GetFileName(outcome.Detail)} is already there.";
                logger.LogWarning("Not moving {Hash} to {To}: {File} is already there", group.Key.Hash, outcome.To, outcome.Detail);
            }
            else if (outcome.Problem is { } problem)
                logger.LogInformation("Not moving {Hash} of {WorkKey} to {Show} season {Season}: {Problem} {Detail}", group.Key.Hash, work.WorkKey,
                    show, group.Key.Season, problem, outcome.Detail);
        }
        await db.SaveChangesAsync(ct);
        if (pending) filesPending[work.WorkKey] = 0;
        else filesPending.TryRemove(work.WorkKey, out _);
    }
}
