using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Metadata;
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
/// under their new numbers. Only what was saved before this database began following the chain
/// (<see cref="ChainNumbering"/>) is read in that old numbering: a row written since (SPY x FAMILY Cour 2's Season 1
/// episode 13 clicked on its page) already numbers the show's seasons and is never translated again. Each coordinate is
/// mapped through the episode it names (its AniList entry and that entry's episode, or its absolute number) and merged
/// into the new key, all in one transaction with the numbering applied (<see cref="Work.NumberingJson"/>: the listing it
/// was laid over and its segments), so it runs again only when the shape changes. A work whose first rows are written
/// with nothing older is stamped as numbered that way from the start (<see cref="StampFreshAsync"/>). Never on a guess: a
/// numbering AniList or the show listing did not fully answer is never applied, a listing that came, went or changed
/// leaves the applied numbering as it is, and nothing is mapped where AniList and the listing disagree on which entry an
/// episode belongs to. The numbering is read with no lock held; the per-work gate (<see cref="WorkGrabGate"/>) is taken
/// only for the transaction and the file moves, and is never taken while a grab of the work is in flight. Finished
/// episodes filed under the old numbers (a sequel entry's own folder, the wrong season), the library hunter's included,
/// are then moved to the show's season folder once the client has let go of them, at most <see cref="MovesPerPass"/>
/// files a pass.
/// </summary>
public sealed class AnimeNumberingReconciler(IDbContextFactory<TorrentFlowDbContext> factory, ISeasonShapeLookup shapes,
    TimeProvider time, ILogger<AnimeNumberingReconciler> logger, ITorrentEngine? engine = null) : BackgroundService
{
    /// <summary>Past the first minute after start, which the AniList rate gate keeps for foreground requests (ProviderPriority).</summary>
    private static readonly TimeSpan StartDelay = TimeSpan.FromSeconds(75);
    private static readonly TimeSpan Every = TimeSpan.FromHours(1);
    /// <summary>A pass that left a show unconfirmed (AniList's background share spent, an outage) comes back this soon, then backs off to <see cref="Every"/>.</summary>
    private static readonly TimeSpan Soon = TimeSpan.FromMinutes(5);
    /// <summary>A work already brought to its shape is looked at again only this often (its franchise may have grown).</summary>
    private static readonly TimeSpan Recheck = TimeSpan.FromHours(12);
    /// <summary>The background pass spaces its AniList lookups so it never competes with pages and grabs for the rate limit.</summary>
    private static readonly TimeSpan Pace = TimeSpan.FromSeconds(3);
    /// <summary>At most this many works are looked at per pass; the rest wait for the next one (an hour later).</summary>
    private const int PerPass = 12;
    /// <summary>At most this many files move in one pass; the rest move in the next.</summary>
    public const int MovesPerPass = 50;
    private const int Format = 2;
    private readonly DateTime started = time.GetUtcNow().UtcDateTime;
    private readonly ConcurrentDictionary<string, DateTime> checkedAt = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> movedKeys = new(StringComparer.Ordinal);
    /// <summary>Works whose finished files could not move yet (still seeding, or past a pass's cap): the next pass tries them again.</summary>
    private readonly ConcurrentDictionary<string, byte> filesPending = new(StringComparer.Ordinal);
    /// <summary>Works whose rows need renumbering that a grab in flight put off: nothing may be searched with their old numbers.</summary>
    private readonly ConcurrentDictionary<string, byte> waiting = new(StringComparer.Ordinal);
    /// <summary>One apply of a work at a time (a wanted run and the background pass may reach the same work).</summary>
    private readonly ConcurrentDictionary<string, SemaphoreSlim> applying = new(StringComparer.Ordinal);
    /// <summary>Works already told about a listing that no longer matches their applied numbering (said once per process).</summary>
    private readonly ConcurrentDictionary<string, string> listingNoted = new(StringComparer.Ordinal);
    /// <summary>Works whose numbering was last seen unconfirmed (said once until it is confirmed again).</summary>
    private readonly ConcurrentDictionary<string, byte> unconfirmedNoted = new(StringComparer.Ordinal);

    /// <summary>
    /// One run of episodes numbered in a row: absolute <see cref="Start"/> is <see cref="Season"/> episode
    /// <see cref="Episode"/>, and AniList entry <see cref="Entry"/>'s episode <see cref="EntryEpisode"/> when one numbers it.
    /// </summary>
    private sealed record Segment(int Start, int Season, int Episode, int Count, string? Entry = null, int? EntryEpisode = null);

    /// <summary>What <see cref="Work.NumberingJson"/> holds: the listing the numbering was laid over and its segments.</summary>
    /// <param name="Fresh">Stamped when the work's first rows were written with nothing older (<see cref="StampFreshAsync"/>):
    /// every row already numbers the show's seasons, so its first numbering is recorded without mapping any of them.</param>
    private sealed record Applied(int Version, string Listing, List<Segment> Segments,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool Fresh = false)
    {
        private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

        public static string FreshJson { get; } = new Applied(Format, "", [], Fresh: true).ToJson();

        public string ToJson() => JsonSerializer.Serialize(this, Json);

        /// <summary>The applied numbering; null when none was (or only an earlier form, which is read as never applied).</summary>
        public static Applied? Read(string? json)
        {
            if (string.IsNullOrWhiteSpace(json) || !json.TrimStart().StartsWith('{')) return null;
            try { return JsonSerializer.Deserialize<Applied>(json, Json) is { Version: Format, Listing: not null, Segments: not null } read ? read : null; }
            catch (JsonException) { return null; }
        }
    }

    /// <summary>A pass's share of file moves (<see cref="MovesPerPass"/>).</summary>
    private sealed class MoveBudget(int left)
    {
        public int Left = left;
        public int Moved;
        public int Waiting;
    }

    /// <summary>What reconciling one work did.</summary>
    /// <param name="Unconfirmed">AniList or the show listing gave no confirmed numbering, so nothing was done; asked again soon.</param>
    private readonly record struct Outcome(bool Renumbered, bool Unconfirmed = false);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(StartDelay, time, stoppingToken); }
        catch (OperationCanceledException) { return; }
        var unconfirmedPasses = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            var again = false;
            try { again = await ReconcileDueAsync(stoppingToken); }
            catch (Exception error) when (!stoppingToken.IsCancellationRequested) { logger.LogWarning(error, "Anime numbering check failed"); }
            unconfirmedPasses = again ? unconfirmedPasses + 1 : 0;
            var wait = again ? TimeSpan.FromTicks(Math.Min(Every.Ticks, Soon.Ticks << Math.Min(unconfirmedPasses - 1, 4))) : Every;
            try { await Task.Delay(wait, time, stoppingToken); }
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
    /// in that order, at most <see cref="PerPass"/> of them, one every <see cref="Pace"/>, moving at most
    /// <see cref="MovesPerPass"/> files. Grabs and the hunter renumber the work they are about to use themselves, so this
    /// pass is never waited on. It ends with one summary line.
    /// </summary>
    /// <returns>True when a show's numbering was not confirmed (AniList's background share spent, an outage): the next pass comes sooner.</returns>
    public async Task<bool> ReconcileDueAsync(CancellationToken ct)
    {
        // Its AniList and listing lookups wait behind anything the owner pressed (ProviderPriority).
        using var priority = ProviderPriority.Background();
        List<(string Key, bool Applied)> works;
        await using (var db = await factory.CreateDbContextAsync(ct))
            works = (await db.Works.AsNoTracking().Where(w => w.Provider == "anilist" && w.ProviderId != null &&
                    (w.AcquisitionTargets.Any() || w.WatchListItems.Any() || db.EngineTorrents.Any(t => t.WorkId == w.Id)))
                .Select(w => new { w.WorkKey, Applied = w.NumberingJson != null }).ToListAsync(ct))
                .Select(w => (w.WorkKey, w.Applied)).ToList();
        var now = time.GetUtcNow().UtcDateTime;
        var due = works.Where(w => !w.Applied || filesPending.ContainsKey(w.Key) ||
                now - checkedAt.GetValueOrDefault(w.Key, started) >= Recheck)
            .OrderBy(w => w.Applied).ThenBy(w => filesPending.ContainsKey(w.Key) ? 0 : 1)
            .ThenBy(w => checkedAt.GetValueOrDefault(w.Key, started)).Take(PerPass).Select(w => w.Key).ToList();
        if (due.Count == 0) return false;
        var budget = new MoveBudget(MovesPerPass);
        var (renumbered, unconfirmed) = (0, 0);
        foreach (var key in due)
        {
            try
            {
                var outcome = await ReconcileAsync(key, budget, ct);
                if (outcome.Renumbered) renumbered++;
                if (outcome.Unconfirmed) unconfirmed++;
            }
            catch (Exception error) when (!ct.IsCancellationRequested) { logger.LogWarning(error, "Anime numbering of {WorkKey} failed", key); }
            // Round robin: a work AniList did not answer for goes behind the others instead of being asked first again.
            checkedAt[key] = time.GetUtcNow().UtcDateTime;
            await Task.Delay(Pace, time, ct);
        }
        logger.LogInformation("Anime numbering pass: {Works} shows checked, {Renumbered} renumbered, {Moved} files moved, {Waiting} waiting to move, " +
            "{Unconfirmed} not confirmed yet", due.Count, renumbered, budget.Moved, budget.Waiting, unconfirmed);
        return unconfirmed > 0;
    }

    /// <summary>
    /// Renumbers one work's rows when its confirmed season shape changed since they were last brought to it, then moves
    /// its misfiled finished episodes. True when any row moved. Skipped (false) while a grab of the work is in flight.
    /// </summary>
    public async Task<bool> ReconcileAsync(string workKey, CancellationToken ct)
    {
        var budget = new MoveBudget(MovesPerPass);
        var outcome = await ReconcileAsync(workKey, budget, ct);
        if (budget.Moved > 0 || budget.Waiting > 0)
            logger.LogInformation("Anime numbering of {WorkKey}: {Moved} files moved, {Waiting} waiting to move", workKey, budget.Moved, budget.Waiting);
        return outcome.Renumbered;
    }

    private async Task<Outcome> ReconcileAsync(string workKey, MoveBudget budget, CancellationToken ct)
    {
        Work? found;
        await using (var read = await factory.CreateDbContextAsync(ct))
            found = await read.Works.AsNoTracking().FirstOrDefaultAsync(w => w.WorkKey == workKey, ct);
        if (found is not { Provider: "anilist", ProviderId: not null }) return default;
        // Read with no lock held: AniList and the listing can be slow, and grabs of this work (and every other) go on meanwhile.
        var numbering = await shapes.GetNumberingAsync(new(found.WorkKey, found.CanonicalTitle, found.Year, found.MediaType, found.Provider,
            found.ProviderId, 1), ct);
        // Never on a guess: a walk AniList cut short or a listing that did not answer renumbers and moves nothing.
        if (numbering is not { Provisional: false, Episodes.Count: > 0 })
        {
            if (numbering is { Provisional: true } && unconfirmedNoted.TryAdd(workKey, 0))
                logger.LogInformation("Numbering of {WorkKey} is not confirmed (AniList or the show listing did not answer); nothing renumbered or moved",
                    workKey);
            return new(false, Unconfirmed: numbering is { Provisional: true });
        }
        unconfirmedNoted.TryRemove(workKey, out _);
        checkedAt[workKey] = time.GetUtcNow().UtcDateTime;
        var applied = new Applied(Format, numbering.Listing, Segments(numbering.Episodes));
        var json = applied.ToJson();
        var gate = applying.GetOrAdd(workKey, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            var work = await db.Works.FirstOrDefaultAsync(w => w.Id == found.Id, ct);
            if (work == null) return default;
            var stored = Applied.Read(work.NumberingJson);
            if (stored is { Fresh: false } && stored.Listing != applied.Listing)
            {
                // The listing came, went or changed: the rows keep the numbering they were brought to, and nothing moves.
                waiting.TryRemove(workKey, out _);
                if (listingNoted.TryGetValue(workKey, out var noted) && noted == applied.Listing) return default;
                listingNoted[workKey] = applied.Listing;
                logger.LogInformation("Numbering of {WorkKey} now reads listing {Listing} where its rows were numbered over {Stored}; keeping their numbers",
                    workKey, applied.Listing, stored.Listing);
                return default;
            }
            var renumber = work.NumberingJson != json;
            if (renumber && stored is { Fresh: true })
            {
                // Nothing older to translate: the numbering is only recorded, and never waits for a grab in flight.
                work.NumberingJson = json;
                await db.SaveChangesAsync(ct);
                renumber = false;
            }
            if (!renumber) waiting.TryRemove(workKey, out _);
            if (!renumber && numbering.ShowId == null && !filesPending.ContainsKey(workKey)) return default;
            using var hold = WorkGrabGate.TryRenumber(work.Id);
            if (hold == null)
            {
                if (renumber)
                {
                    waiting[workKey] = 0;
                    logger.LogInformation("Numbering of {WorkKey} waits for its grab in flight", workKey);
                }
                return default;
            }
            var moved = renumber ? await RenumberAsync(db, work, numbering, stored, json, ct) : 0;
            waiting.TryRemove(workKey, out _);
            if (engine != null)
            {
                try { await RelocateFilesAsync(work, numbering, budget, ct); }
                catch (Exception error) when (!ct.IsCancellationRequested) { logger.LogWarning(error, "Moving the finished episodes of {WorkKey} failed", workKey); }
            }
            return new(moved > 0);
        }
        finally { gate.Release(); }
    }

    /// <summary>Every stored coordinate, the merge of collisions and the applied numbering, in one transaction.</summary>
    private async Task<int> RenumberAsync(TorrentFlowDbContext db, Work work, AnimeNumbering numbering, Applied? stored, string applied,
        CancellationToken ct)
    {
        var map = Mapping(work, numbering, stored);
        var old = await OldAsync(db, stored, ct);
        var keys = new Dictionary<string, string>(StringComparer.Ordinal);
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var moved = await MoveTargetsAsync(db, work, map, old, keys, ct);
        moved += await MoveCursorsAsync(db, work, map, old, ct);
        moved += await MoveQueueKeysAsync(db, work, map, old, ct);
        moved += await MoveReleasesAsync(db, work, map, old, ct);
        work.NumberingJson = applied;
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        foreach (var (from, to) in keys) movedKeys[from] = to;
        if (moved > 0) logger.LogInformation("Renumbered {Count} stored episodes of {WorkKey} to its show's seasons", moved, work.WorkKey);
        return moved;
    }

    /// <summary>
    /// Whether something written at a given moment is in the numbering <see cref="Mapping"/> reads from: everything, once a
    /// numbering was applied (rows written since were brought to it); nothing for a work stamped fresh; and before any
    /// numbering was applied, only what was written before this database began following the chain
    /// (<see cref="ChainNumbering"/>), which is the old numbering. Anything written since already numbers the show's seasons.
    /// </summary>
    private static async Task<Func<DateTime, bool>> OldAsync(TorrentFlowDbContext db, Applied? stored, CancellationToken ct)
    {
        if (stored is not null) return stored.Fresh ? _ => false : _ => true;
        return await ChainNumbering.SinceAsync(db, ct) is { } since ? written => written < since : _ => false;
    }

    /// <summary>A library row's cursor was written in the old numbering when the row was created and last saved before the chain numbering.</summary>
    private static bool OldCursor(WatchListItem item, Func<DateTime, bool> old) => old(item.CreatedAt) && old(item.UpdatedAt);

    /// <summary>
    /// Marks an AniList work that has nothing saved from before the chain numbering (<see cref="ChainNumbering"/>) as numbered
    /// that way from the start, when its first rows are written: its first renumbering then reads none of them as old. A
    /// work already numbered, or with anything older (a wanted row, a library row, a transfer's queue key, a tried or
    /// blocked release), is left alone; the renumbering then translates only those older rows.
    /// </summary>
    public static async Task StampFreshAsync(TorrentFlowDbContext db, string workId, CancellationToken ct)
    {
        var work = await db.Works.AsNoTracking().Where(w => w.Id == workId && w.Provider == "anilist" && w.NumberingJson == null)
            .Select(w => new { w.Id, w.WorkKey }).FirstOrDefaultAsync(ct);
        if (work is null || await ChainNumbering.SinceAsync(db, ct) is not { } since) return;
        bool Older(DateTime written) => written < since;
        // Read and compared here, not in SQL: the stored text of a moment has more than one form.
        var targets = await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && (t.WorkKey == work.WorkKey || t.WorkId == work.Id))
            .Select(t => t.CreatedAt).ToListAsync(ct);
        var rows = await db.WatchListItems.AsNoTracking().Where(x => x.UserId == LocalUser.Id && x.WorkId == work.Id)
            .Select(x => new { x.CreatedAt, x.UpdatedAt }).ToListAsync(ct);
        var transfers = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkId == work.Id && t.QueueKey != null)
            .Select(t => t.CreatedAt).ToListAsync(ct);
        var tried = await db.ReleaseAttempts.AsNoTracking().Where(a => a.UserId == LocalUser.Id && a.WorkKey == work.WorkKey).Select(a => a.TriedAt).ToListAsync(ct);
        var blocked = await db.ReleaseBlocks.AsNoTracking().Where(b => b.UserId == LocalUser.Id && b.WorkKey == work.WorkKey).Select(b => b.CreatedAt).ToListAsync(ct);
        if (targets.Concat(transfers).Concat(tried).Concat(blocked).Any(Older) || rows.Any(r => Older(r.CreatedAt) && Older(r.UpdatedAt))) return;
        await db.Works.Where(w => w.Id == work.Id && w.NumberingJson == null).ExecuteUpdateAsync(s => s.SetProperty(w => w.NumberingJson, Applied.FreshJson), ct);
    }

    /// <summary>Which episode a coordinate names: its AniList entry and that entry's episode when one numbers it, else its absolute number.</summary>
    private static string Identity(string? entry, int? entryEpisode, int absolute) =>
        entry is not null && entryEpisode is { } episode ? $"{entry}:{episode.ToString(CultureInfo.InvariantCulture)}" : $"#{absolute.ToString(CultureInfo.InvariantCulture)}";

    /// <summary>
    /// The new coordinate of a coordinate rows were saved under, or null when it stays. Rows were saved under the
    /// numbering last applied, or (never applied) the pre-chain page's numbers, which only rows older than the chain
    /// numbering carry (<see cref="OldAsync"/>); either names an episode, which keeps its identity under the new numbering.
    /// A row saved as season 1 and an absolute number ("- 29", TMDB's lumped season) names that absolute episode only when
    /// it lies in a later entry past a season boundary the chain decided, never in the work's own entry. Nothing maps from
    /// or to an episode whose entry is uncertain, nor (for the absolute guess) past one.
    /// </summary>
    private static Func<int, int, (int Season, int Episode)?> Mapping(Work work, AnimeNumbering numbering, Applied? stored)
    {
        var uncertain = numbering.Uncertain ?? [];
        bool Unsure(int absolute) => uncertain.Any(u => u.Contains(absolute));
        var now = new Dictionary<string, (int Season, int Episode, int Absolute)>(StringComparer.Ordinal);
        foreach (var e in numbering.Episodes) now.TryAdd(Identity(e.Entry, e.EntryEpisode, e.Absolute), (e.Season, e.Episode, e.Absolute));
        var before = new Dictionary<(int Season, int Episode), (string Identity, int Absolute)>();
        if (stored is not null)
        {
            foreach (var s in stored.Segments)
                for (var i = 0; i < s.Count; i++)
                    before.TryAdd((s.Season, s.Episode + i), (Identity(s.Entry, s.EntryEpisode + i, s.Start + i), s.Start + i));
        }
        else
        {
            foreach (var e in numbering.Episodes) before.TryAdd((e.LegacySeason, e.LegacyEpisode), (Identity(e.Entry, e.EntryEpisode, e.Absolute), e.Absolute));
            var firstUnsure = uncertain.Select(u => u.From).DefaultIfEmpty(int.MaxValue).Min();
            foreach (var e in numbering.Episodes.Where(e => e.Entry is not null && e.Entry != work.ProviderId && e.Season > 1 && e.Absolute < firstUnsure))
                before.TryAdd((1, e.Absolute), (Identity(e.Entry, e.EntryEpisode, e.Absolute), e.Absolute));
        }
        return (season, episode) => before.TryGetValue((season, episode), out var was) && now.TryGetValue(was.Identity, out var current) &&
            (current.Season, current.Episode) != (season, episode) && !Unsure(was.Absolute) && !Unsure(current.Absolute)
                ? (current.Season, current.Episode) : null;
    }

    private static List<Segment> Segments(IEnumerable<NumberedEpisode> episodes)
    {
        var segments = new List<Segment>();
        foreach (var e in episodes.OrderBy(e => e.Absolute))
        {
            if (segments.Count > 0 && segments[^1] is var last && last.Season == e.Season && last.Start + last.Count == e.Absolute &&
                last.Episode + last.Count == e.Episode && last.Entry == e.Entry &&
                (last.Entry is null ? e.EntryEpisode is null : last.EntryEpisode + last.Count == e.EntryEpisode))
                segments[^1] = last with { Count = last.Count + 1 };
            else segments.Add(new(e.Absolute, e.Season, e.Episode, 1, e.Entry, e.EntryEpisode));
        }
        return segments;
    }

    /// <summary>How far a row got: a finished transfer beats a live one, a live one a found release, that a plain wish.</summary>
    private static int Rank(AcquisitionTarget t) => t.Status switch
    {
        "downloaded" => 5, "downloading" => 4, "queued" when t.InfoHash != null => 3, "queued" => 2, _ => t.InfoHash != null ? 1 : 0
    };

    /// <summary>
    /// Moves each target to its episode's new key. Two rows landing on one key merge: the one furthest along keeps the
    /// key; a row with no transfer of its own folds into it (its run, click and misses kept); a row with a different
    /// transfer keeps that transfer linked under a key of its own, every field as it was. A row's season and episode
    /// change only here, so when it was created says which numbering they are in (<paramref name="old"/>); a retry or a
    /// hold that touched it since says nothing about them.
    /// </summary>
    private static async Task<int> MoveTargetsAsync(TorrentFlowDbContext db, Work work, Func<int, int, (int Season, int Episode)?> map,
        Func<DateTime, bool> old, Dictionary<string, string> keys, CancellationToken ct)
    {
        var rows = await db.AcquisitionTargets.Where(t => t.UserId == LocalUser.Id && t.Scope == "episode" && t.Season != null &&
            t.Episode != null && (t.WorkKey == work.WorkKey || t.WorkId == work.Id)).ToListAsync(ct);
        var final = rows.ToDictionary(t => t, t => old(t.CreatedAt) ? map(t.Season!.Value, t.Episode!.Value) : null);
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

    private static async Task<int> MoveCursorsAsync(TorrentFlowDbContext db, Work work, Func<int, int, (int Season, int Episode)?> map,
        Func<DateTime, bool> old, CancellationToken ct)
    {
        var items = await db.WatchListItems.Where(x => x.UserId == LocalUser.Id && x.WorkId == work.Id).ToListAsync(ct);
        var moved = 0;
        foreach (var item in items.Where(item => OldCursor(item, old)))
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

    private static async Task<int> MoveQueueKeysAsync(TorrentFlowDbContext db, Work work, Func<int, int, (int Season, int Episode)?> map,
        Func<DateTime, bool> old, CancellationToken ct)
    {
        var torrents = await db.EngineTorrents.Where(t => t.UserId == LocalUser.Id && t.WorkId == work.Id && t.QueueKey != null).ToListAsync(ct);
        var moved = 0;
        foreach (var torrent in torrents.Where(t => old(t.CreatedAt)))
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
    private static async Task<int> MoveReleasesAsync(TorrentFlowDbContext db, Work work, Func<int, int, (int Season, int Episode)?> map,
        Func<DateTime, bool> old, CancellationToken ct)
    {
        var moved = 0;
        var attempts = await db.ReleaseAttempts.Where(r => r.UserId == LocalUser.Id && r.WorkKey == work.WorkKey).ToListAsync(ct);
        string? Moves(ReleaseAttempt attempt) => old(attempt.TriedAt) ? Rescope(attempt.Scope, map) : null;
        var kept = attempts.Where(r => Moves(r) is null).ToDictionary(r => (r.Scope, r.Hash));
        foreach (var attempt in attempts)
        {
            if (Moves(attempt) is not { } scope) continue;
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
        foreach (var block in blocks.Where(b => old(b.CreatedAt)))
            if (Rescope(block.Scope, map) is { } scope)
            {
                block.Scope = scope;
                moved++;
            }
        return moved;
    }

    /// <summary>
    /// Finished episodes filed where the show no longer files them (a sequel entry's own folder, or the season they had
    /// before renumbering) move to <c>&lt;show&gt;\Season NN</c>, the folder named the way the show's own downloads are
    /// (<see cref="ShowFolders"/>): the wanted rows' transfers and the library hunter's (a transfer of this work with an
    /// episode queue key). Only an episode the confirmed numbering places for certain moves, each transfer as a whole to
    /// one season. Only transfers the client has let go of move; one still seeding, or past the pass's cap, is tried
    /// again on a later pass. A clash is never overwritten and is reported on the row. One line is logged per move.
    /// </summary>
    private async Task RelocateFilesAsync(Work work, AnimeNumbering numbering, MoveBudget budget, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var (show, year) = await ShowFolders.ResolveAsync(db, numbering.ShowId, numbering.ShowTitle ?? work.CanonicalTitle,
            numbering.ShowId != null ? numbering.ShowYear : work.Year, ct);
        var showFolder = MediaFolders.Name(show);
        var uncertain = numbering.Uncertain ?? [];
        var placed = numbering.Episodes.Where(e => !uncertain.Any(u => u.Contains(e.Absolute))).Select(e => (e.Season, e.Episode)).ToHashSet();
        var rows = await db.AcquisitionTargets.Where(t => t.UserId == LocalUser.Id && t.Scope == "episode" && t.Status == "downloaded" &&
            t.InfoHash != null && t.Season != null && t.Episode != null && (t.WorkKey == work.WorkKey || t.WorkId == work.Id)).ToListAsync(ct);
        var linked = rows.Select(t => t.InfoHash!.ToLowerInvariant()).Distinct().ToArray();
        var torrents = await db.EngineTorrents.AsNoTracking().Where(e => e.UserId == LocalUser.Id && e.Status != EngineTorrentStatus.Removed &&
            (e.WorkId == work.Id || linked.Contains(e.Hash))).ToListAsync(ct);
        var pending = false;
        foreach (var torrent in torrents.DistinctBy(t => t.Hash.ToLowerInvariant()))
        {
            var mine = rows.Where(r => string.Equals(r.InfoHash, torrent.Hash, StringComparison.OrdinalIgnoreCase)).ToList();
            List<(int Season, int Episode)> coordinates = mine.Count > 0 ? mine.Select(r => (r.Season!.Value, r.Episode!.Value)).ToList()
                : QueueKeys.Parse(torrent.QueueKey) is { } key ? [(key.Season, key.Episode)] : [];
            if (coordinates.Count == 0 || coordinates.Select(c => c.Season).Distinct().Count() != 1 || !coordinates.All(placed.Contains)) continue;
            var season = coordinates[0].Season;
            if (torrent.SavePath is not { Length: > 0 } savePath) continue;
            var folder = Path.TrimEndingDirectorySeparator(savePath);
            if (folder.EndsWith(Path.DirectorySeparatorChar + Path.Combine(showFolder, MediaFolders.Season(season)), StringComparison.OrdinalIgnoreCase)) continue;
            // The show's own transfers move only out of a season folder that is not theirs (renumbered); a later entry's always join the show.
            if (numbering.ShowId == null && string.Equals(Path.GetFileName(folder), MediaFolders.Season(season), StringComparison.OrdinalIgnoreCase)) continue;
            var files = Math.Max(1, VerifiedFiles.Read(torrent.VerifiedFilesJson)?.Count ?? 0);
            var episodes = string.Join(",", coordinates.Select(c => c.Episode).Order());
            if (files > budget.Left)
            {
                pending = true;
                budget.Waiting += files;
                continue;
            }
            var outcome = await engine!.RelocateAsync(torrent.Hash, new(show, year, true, false, season), ct);
            if (outcome.Moved && outcome is { From: { } from, To: { } to })
            {
                budget.Left -= files;
                budget.Moved += files;
                foreach (var row in mine)
                {
                    if (row.FilePath is { } file && Path.GetFullPath(file).StartsWith(from + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        row.FilePath = Path.Combine(to, Path.GetRelativePath(from, Path.GetFullPath(file)));
                    // Only an earlier "Not moved" note goes; any other reason on the row stays.
                    if (row.Error?.StartsWith(NotMoved, StringComparison.Ordinal) == true) row.Error = null;
                    row.UpdatedAt = time.GetUtcNow().UtcDateTime;
                }
                logger.LogInformation("Moved {Show} season {Season} episodes {Episodes} ({Files} files) from {From} to {To}", show, season, episodes,
                    files, from, to);
            }
            else if (outcome.Problem == EngineRelocation.NotParked)
            {
                pending = true;
                budget.Waiting += files;
            }
            else if (outcome.Problem == EngineRelocation.Clash)
            {
                foreach (var row in mine)
                    row.Error = $"{NotMoved}{outcome.To}: {Path.GetFileName(outcome.Detail)} is already there.";
                logger.LogWarning("Not moving {Hash} to {To}: {File} is already there", torrent.Hash, outcome.To, outcome.Detail);
            }
            else if (outcome.Problem is { } problem)
                logger.LogInformation("Not moving {Hash} of {WorkKey} to {Show} season {Season}: {Problem} {Detail}", torrent.Hash, work.WorkKey,
                    show, season, problem, outcome.Detail);
        }
        await db.SaveChangesAsync(ct);
        if (pending) filesPending[work.WorkKey] = 0;
        else filesPending.TryRemove(work.WorkKey, out _);
    }
}
