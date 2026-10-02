using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Data;

/// <summary>What <see cref="WorkLinks.WriteAsync"/> left: the work and its rows, and whether anything was saved.</summary>
public sealed record LinkWrite(Work Work, List<WorkLink> Links, bool Saved);

/// <summary>A claim that a work is <paramref name="ExternalId"/> at <paramref name="Provider"/>, and who says so.</summary>
public sealed record LinkClaim(string Provider, string ExternalId, string? MediaType, int? Season, string Source, double Confidence,
    bool Verified, WorkNames? Names = null);

/// <summary>
/// The one writer of a work's crosswalk (<see cref="WorkLink"/> rows) and of what it feeds: <see cref="Work.IdsJson"/>
/// (verified ids only) and the names linked records gave (<see cref="WorkName.Source"/>). Rows are recorded with
/// <see cref="Record"/>, then <see cref="Apply"/> rebuilds the ids and linked names from them, so the two never disagree.
/// </summary>
public static class WorkLinks
{
    public const string FromProvider = "provider";
    public const string Fribb = "fribb";
    public const string TitleSearch = "title-search";
    public const string Owner = "owner";

    /// <summary>The label a linked record's names carry, and its id in the title page's list.</summary>
    public static string Key(string provider, string externalId) => $"{provider}:{externalId}";

    public static Task<List<WorkLink>> LoadAsync(TorrentFlowDbContext db, Work work, CancellationToken ct) =>
        db.WorkLinks.Where(l => l.WorkId == work.Id).OrderBy(l => l.CreatedAt).ToListAsync(ct);

    /// <summary>One work's write lock and how many callers hold it or wait for it; removed when the last one leaves.</summary>
    private sealed class Gate
    {
        public readonly SemaphoreSlim Lock = new(1, 1);
        public int Users;
    }

    private static readonly Dictionary<string, Gate> Gates = new(StringComparer.OrdinalIgnoreCase);

    private static Gate Enter(string workKey)
    {
        lock (Gates)
        {
            if (!Gates.TryGetValue(workKey, out var gate)) Gates[workKey] = gate = new Gate();
            gate.Users++;
            return gate;
        }
    }

    // Users is counted under the dictionary's lock before waiting, so a gate is only removed (and disposed) when nobody
    // holds or waits on it; a caller arriving after that makes a fresh one.
    private static void Leave(string workKey, Gate gate, bool held)
    {
        if (held) gate.Lock.Release();
        lock (Gates)
        {
            if (--gate.Users > 0) return;
            Gates.Remove(workKey);
        }
        gate.Lock.Dispose();
    }

    /// <summary>
    /// The only way a work's links, ids and linked names are changed: one writer at a time per work (names refresh, title
    /// open, grab, backfill and unlink all queue here), on the work and rows as they are right now, rejected ones included,
    /// so an unlink saved a moment earlier always stands. <paramref name="write"/> changes the tracked work and rows and
    /// says whether to save. When another process saved the same row first, the unique index refuses ours: the work is
    /// read again and written once more.
    /// </summary>
    public static async Task<LinkWrite?> WriteAsync(IDbContextFactory<TorrentFlowDbContext> factory, string workKey,
        Func<TorrentFlowDbContext, Work, List<WorkLink>, bool> write, CancellationToken ct)
    {
        var gate = Enter(workKey);
        var held = false;
        try
        {
            await gate.Lock.WaitAsync(ct);
            held = true;
            for (var attempt = 1; ; attempt++)
            {
                await using var db = await factory.CreateDbContextAsync(ct);
                var work = await db.Works.FirstOrDefaultAsync(w => w.WorkKey == workKey, ct);
                if (work == null) return null;
                var links = await LoadAsync(db, work, ct);
                if (!write(db, work, links)) return new(work, links, false);
                try
                {
                    await db.SaveChangesAsync(ct);
                    return new(work, links, true);
                }
                catch (DbUpdateException) when (attempt == 1) { }
            }
        }
        finally { Leave(workKey, gate, held); }
    }

    /// <summary>Whether the claim is the work's own catalog identity (already its id; never a link).</summary>
    private static bool IsOwn(Work work, string provider, string externalId)
    {
        var own = WorkIds.From(work.Provider, work.ProviderId);
        return provider switch
        {
            "tmdb" => own.Tmdb?.ToString(System.Globalization.CultureInfo.InvariantCulture) == externalId,
            "anilist" => own.AniList?.ToString(System.Globalization.CultureInfo.InvariantCulture) == externalId,
            "mal" => own.Mal?.ToString(System.Globalization.CultureInfo.InvariantCulture) == externalId,
            "imdb" => string.Equals(own.Imdb, externalId, StringComparison.OrdinalIgnoreCase),
            _ => false
        };
    }

    /// <summary>One claim per id a record reports about itself (<paramref name="tmdbType"/>: movie or tv).</summary>
    public static IEnumerable<LinkClaim> Claims(WorkIds? ids, string? tmdbType, string source, double confidence = 1, bool verified = true)
    {
        static string S(int n) => n.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (ids?.Tmdb is { } tmdb) yield return new("tmdb", S(tmdb), tmdbType, null, source, confidence, verified);
        if (ids?.AniList is { } anilist) yield return new("anilist", S(anilist), null, null, source, confidence, verified);
        if (ids?.Mal is { } mal) yield return new("mal", S(mal), null, null, source, confidence, verified);
        if (ids?.Imdb is { Length: > 0 } imdb) yield return new("imdb", imdb, null, null, source, confidence, verified);
        if (ids?.Tvdb is { } tvdb) yield return new("tvdb", S(tvdb), null, null, source, confidence, verified);
    }

    /// <summary>
    /// Adds or updates a row per claim. A rejected row is never touched (the owner's unlink stands), a verified claim
    /// upgrades a suggestion, and a suggestion never downgrades a verified row.
    /// </summary>
    public static void Record(TorrentFlowDbContext db, Work work, List<WorkLink> links, IEnumerable<LinkClaim> claims, string? version, DateTime now)
    {
        foreach (var claim in claims)
        {
            if (string.IsNullOrWhiteSpace(claim.ExternalId) || IsOwn(work, claim.Provider, claim.ExternalId)) continue;
            var row = links.FirstOrDefault(l => l.Provider == claim.Provider && string.Equals(l.ExternalId, claim.ExternalId, StringComparison.OrdinalIgnoreCase));
            if (row == null)
            {
                row = new WorkLink
                {
                    Id = Ids.New(), WorkId = work.Id, Provider = claim.Provider, ExternalId = claim.ExternalId, MediaType = claim.MediaType,
                    Season = claim.Season, Source = claim.Source, MappingVersion = version, Confidence = claim.Confidence,
                    Verified = claim.Verified, NamesJson = claim.Names?.ToJson(), CreatedAt = now, UpdatedAt = now
                };
                db.WorkLinks.Add(row);
                links.Add(row);
                continue;
            }
            if (row.Rejected) continue;
            var changed = false;
            if (claim.Verified && !row.Verified || claim.Verified == row.Verified && claim.Confidence > row.Confidence)
            {
                row.Source = claim.Source;
                row.Verified = claim.Verified;
                row.Confidence = claim.Confidence;
                changed = true;
            }
            if (claim.MediaType != null && row.MediaType != claim.MediaType) { row.MediaType = claim.MediaType; changed = true; }
            if (claim.Season != null && row.Season != claim.Season) { row.Season = claim.Season; changed = true; }
            if (claim.Names?.ToJson() is { } names && names != row.NamesJson) { row.NamesJson = names; changed = true; }
            if (version != null && row.MappingVersion != version) { row.MappingVersion = version; changed = true; }
            if (changed) row.UpdatedAt = now;
        }
    }

    /// <summary>
    /// The link standing for <paramref name="provider"/> at work level: the only record there (several rows of one id
    /// count once), else the base or season-1 record when one series maps to several. Verified rows only, unless
    /// <paramref name="suggestions"/> and no verified row exists.
    /// </summary>
    public static WorkLink? Primary(IReadOnlyList<WorkLink> links, string provider, bool suggestions = false)
    {
        var active = links.Where(l => !l.Rejected && l.Provider == provider).ToList();
        var pool = active.Where(l => l.Verified).ToList();
        if (pool.Count == 0 && suggestions) pool = active;
        if (pool.Select(l => l.ExternalId).Distinct(StringComparer.OrdinalIgnoreCase).Count() == 1) return pool[0];
        var bases = pool.Where(l => l.Season is null or 1).DistinctBy(l => l.ExternalId, StringComparer.OrdinalIgnoreCase).ToList();
        return bases.Count == 1 ? bases[0] : null;
    }

    /// <summary>Whether this link's names are the work's: it stands for its provider at work level (see <see cref="Primary"/>).</summary>
    public static bool GivesNames(IReadOnlyList<WorkLink> links, WorkLink link) =>
        !link.Rejected && link.NamesJson != null && Primary(links, link.Provider, suggestions: true) is { } primary
        && string.Equals(primary.ExternalId, link.ExternalId, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Rebuilds <see cref="Work.IdsJson"/> from the work's own identity plus its verified links, and its linked names
    /// from the links that give names (each labelled with its link). A rejected link contributes nothing.
    /// </summary>
    public static void Apply(Work work, IReadOnlyList<WorkLink> links)
    {
        var own = WorkIds.From(work.Provider, work.ProviderId);
        static int? Number(WorkLink? link) => int.TryParse(link?.ExternalId, out var n) && n > 0 ? n : null;
        var ids = new WorkIds(own.Tmdb ?? Number(Primary(links, "tmdb")), own.AniList ?? Number(Primary(links, "anilist")),
            own.Mal ?? Number(Primary(links, "mal")), own.Imdb ?? Primary(links, "imdb")?.ExternalId, Number(Primary(links, "tvdb")));
        var names = work.ReadNames().WithoutLinked();
        foreach (var link in links.Where(l => GivesNames(links, l)))
            names = names.WithLinked(Key(link.Provider, link.ExternalId), WorkNames.TryRead(link.NamesJson)?.All ?? []);
        work.IdsJson = ids.ToJson() ?? "{}";
        work.NamesJson = names.ToJson();
    }
}
