using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Data;

/// <summary>
/// The one poster for a work, whatever page shows it: the work's stored art first, then the catalog's art for that
/// work, then whatever the caller looked up. A saved work with no art takes the first art found, and keeps it.
/// </summary>
public static class WorkPosters
{
    /// <summary>The poster for each work key that has one stored or catalogued (keys without art are absent).</summary>
    public static async Task<IReadOnlyDictionary<string, string>> LoadAsync(TorrentFlowDbContext db, IEnumerable<string?> workKeys,
        CancellationToken ct = default)
    {
        var keys = workKeys.Where(k => !string.IsNullOrWhiteSpace(k)).Select(k => k!).Distinct(StringComparer.Ordinal).ToList();
        var found = new Dictionary<string, string>(StringComparer.Ordinal);
        if (keys.Count == 0) return found;
        var works = await db.Works.AsNoTracking().Where(w => keys.Contains(w.WorkKey))
            .Select(w => new { w.WorkKey, w.PosterUrl }).ToListAsync(ct).ConfigureAwait(false);
        foreach (var w in works)
            if (!string.IsNullOrWhiteSpace(w.PosterUrl)) found[w.WorkKey] = w.PosterUrl;
        var missing = keys.Where(k => !found.ContainsKey(k)).ToList();
        if (missing.Count == 0) return found;
        var catalog = await FindCatalogAsync(db, missing, ct).ConfigureAwait(false);
        var fill = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, row) in catalog)
            if (!string.IsNullOrWhiteSpace(row.PosterUrl)) found[key] = fill[key] = row.PosterUrl!;
        if (works.Any(w => fill.ContainsKey(w.WorkKey))) await StoreAsync(db, fill, ct).ConfigureAwait(false);
        return found;
    }

    /// <summary>The poster for one work, or <paramref name="lookedUp"/> when nothing is stored or catalogued.</summary>
    public static async Task<string?> ResolveAsync(TorrentFlowDbContext db, string? workKey, string? lookedUp, CancellationToken ct = default)
    {
        var known = await LoadAsync(db, [workKey], ct).ConfigureAwait(false);
        if (workKey is not null && known.TryGetValue(workKey, out var poster)) return poster;
        if (!string.IsNullOrWhiteSpace(workKey) && !string.IsNullOrWhiteSpace(lookedUp))
            await StoreAsync(db, new Dictionary<string, string> { [workKey] = lookedUp }, ct).ConfigureAwait(false);
        return string.IsNullOrWhiteSpace(lookedUp) ? null : lookedUp;
    }

    /// <summary>
    /// The catalog row for each work: an exact identity key ("film:dune:2021"), else the newest row whose title and
    /// year the title route key ("dune-2021") names. Keys with no row are absent.
    /// </summary>
    public static async Task<IReadOnlyDictionary<string, CatalogEntry>> FindCatalogAsync(TorrentFlowDbContext db, IReadOnlyCollection<string> workKeys,
        CancellationToken ct = default)
    {
        var found = new Dictionary<string, CatalogEntry>(StringComparer.Ordinal);
        if (workKeys.Count == 0) return found;
        var exact = await db.CatalogEntries.AsNoTracking().Where(e => workKeys.Contains(e.WorkKey))
            .OrderBy(e => e.Source == "related").ThenBy(e => e.Rank).ToListAsync(ct).ConfigureAwait(false);
        foreach (var row in exact) found.TryAdd(row.WorkKey, row);
        var rest = workKeys.Where(k => !found.ContainsKey(k)).ToList();
        if (rest.Count == 0) return found;
        // Every row's name, newest first: a route key can name any charted work, not only recently refreshed ones.
        var names = await db.CatalogEntries.AsNoTracking().OrderByDescending(e => e.RefreshedAt)
            .Select(e => new { e.Id, e.Title, e.Year }).ToListAsync(ct).ConfigureAwait(false);
        var matched = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var key in rest)
            if (names.FirstOrDefault(e => Core.Text.WorkKeySlug.Matches(key, e.Title, e.Year)) is { } hit) matched[key] = hit.Id;
        if (matched.Count == 0) return found;
        var ids = matched.Values.Distinct().ToList();
        var rows = await db.CatalogEntries.AsNoTracking().Where(e => ids.Contains(e.Id)).ToDictionaryAsync(e => e.Id, ct).ConfigureAwait(false);
        foreach (var (key, id) in matched)
            if (rows.TryGetValue(id, out var row)) found[key] = row;
        return found;
    }

    /// <summary>Picks the work's poster from <see cref="LoadAsync"/> results, falling back to the caller's own art.</summary>
    public static string? Pick(IReadOnlyDictionary<string, string> known, string? workKey, string? fallback) =>
        workKey is not null && known.TryGetValue(workKey, out var poster) ? poster : string.IsNullOrWhiteSpace(fallback) ? null : fallback;

    /// <summary>The key a saved record's poster resolves under: its linked work, else its own title (and year).</summary>
    public static string? KeyFor(string? linkedWorkKey, string? title, int? year = null) =>
        !string.IsNullOrWhiteSpace(linkedWorkKey) ? linkedWorkKey
        : Core.Text.WorkKeySlug.WorkKeyFor(title, year) is { Length: > 0 } key ? key : null;

    /// <summary>Saves the resolved poster onto request rows whose own copy is missing or different.</summary>
    public static async Task StoreOnRequestsAsync(TorrentFlowDbContext db, IEnumerable<(string Id, string? Stored, string? Resolved)> rows, CancellationToken ct = default)
    {
        foreach (var (id, _, poster) in rows.Where(r => !string.IsNullOrWhiteSpace(r.Resolved) && r.Resolved != r.Stored))
            await db.MediaRequests.Where(r => r.Id == id)
                .ExecuteUpdateAsync(s => s.SetProperty(r => r.PosterUrl, poster).SetProperty(r => r.UpdatedAt, DateTime.UtcNow), ct)
                .ConfigureAwait(false);
    }

    /// <summary>Saves the resolved poster onto library rows whose own copy is missing or different.</summary>
    public static async Task StoreOnWatchlistAsync(TorrentFlowDbContext db, IEnumerable<(string Id, string? Stored, string? Resolved)> rows, CancellationToken ct = default)
    {
        foreach (var (id, _, poster) in rows.Where(r => !string.IsNullOrWhiteSpace(r.Resolved) && r.Resolved != r.Stored))
            await db.WatchListItems.Where(w => w.Id == id)
                .ExecuteUpdateAsync(s => s.SetProperty(w => w.PosterUrl, poster), ct)
                .ConfigureAwait(false);
    }

    /// <summary>Saves art onto works that have none yet. Works that already have art keep it.</summary>
    private static async Task StoreAsync(TorrentFlowDbContext db, IReadOnlyDictionary<string, string> art, CancellationToken ct)
    {
        // Set-based updates: the caller's tracked changes are not saved with them.
        foreach (var (key, poster) in art)
            await db.Works.Where(w => w.WorkKey == key && (w.PosterUrl == null || w.PosterUrl == ""))
                .ExecuteUpdateAsync(s => s.SetProperty(w => w.PosterUrl, poster).SetProperty(w => w.UpdatedAt, DateTime.UtcNow), ct)
                .ConfigureAwait(false);
    }
}
