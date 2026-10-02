using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Links;

/// <summary>
/// Links a work to its records at other providers. Verified: what the work's own provider reports (recorded by the
/// names refresh) and the anime-lists map entries for the work's own ids. Unverified: a title search of TMDB (and of
/// AniList for anime) by the work's English then romaji name, kept only when exactly one strong match exists. A link
/// never merges catalog items; the single writer <see cref="WorkLinks"/> turns verified links into ids and the links
/// that stand for the work into labelled names. A work is linked once per map version.
/// </summary>
public sealed class WorkLinker(IDbContextFactory<TorrentFlowDbContext> factory, AnimeListsMap map, IMetadataResolver metadata, TmdbClient tmdb,
    AniListClient anilist, TimeProvider time, ILogger<WorkLinker> logger) : IWorkLinker
{
    private const double MapConfidence = 0.95;
    private const double SearchConfidence = 0.7;
    private const int MaxNameLookups = 8;

    public async Task LinkAsync(string workKey, CancellationToken ct)
    {
        await map.Loaded.WaitAsync(ct);
        var version = map.Version;
        Work? work;
        List<WorkLink> known;
        await using (var read = await factory.CreateDbContextAsync(ct))
        {
            work = await read.Works.AsNoTracking().FirstOrDefaultAsync(w => w.WorkKey == workKey, ct);
            if (work == null || work.LinksVersion == version) return;
            known = await read.WorkLinks.AsNoTracking().Where(l => l.WorkId == work.Id).ToListAsync(ct);
        }

        var own = WorkIds.From(work.Provider, work.ProviderId);
        var ownType = work.Format == WorkFormat.Movie || work.Format == null && work.MediaType == "movie" ? "movie" : "tv";
        // Only an anime work takes anime-lists entries through its TMDB or IMDb id, or an AniList suggestion: a Japanese
        // live-action film shares neither. Unknown (its provider could not be asked) links nothing now and tries later.
        if (await AnimeAsync(work, ownType, ct) is not { } anime) return;
        var mapClaims = FromMap(Entries(own, ownType, anime), WorkLinks.Fribb, MapConfidence, verified: true).ToList();
        var claims = new List<LinkClaim>(mapClaims);

        // A title search runs once per work, and only when the work has no TMDB or AniList record of its own or verified.
        // A search that failed (error, timeout, rate limit) leaves the work unlinked so the next open or backfill searches
        // again; only a search that answered, with or without a match, counts as done.
        if (work.LinksVersion == null)
        {
            var seeded = WorkLinks.Claims(WorkIds.FromJson(work.IdsJson), ownType, WorkLinks.FromProvider).ToList();
            var verified = known.Where(l => !l.Rejected && l.Verified).Select(l => l.Provider).Concat(seeded.Concat(claims).Select(c => c.Provider)).ToHashSet();
            if (own.Tmdb == null && !verified.Contains("tmdb") && own.AniList == null && !verified.Contains("anilist"))
            {
                if (await SuggestTmdbAsync(work, ownType, ct) is not { } search) return;
                claims.AddRange(search.Claims);
                anime |= search.Anime;
            }
            if (anime && own.AniList == null && !verified.Contains("anilist") && !claims.Any(c => c.Provider == "anilist"))
            {
                if (await SuggestAniListAsync(work, ownType, ct) is not { } suggested) return;
                claims.AddRange(suggested);
            }
        }
        claims = await WithNamesAsync(claims, ct);

        // The rows are read again under the work's write lock: an unlink saved while the lookups ran stands, and a map
        // version change retires the anime-lists rows its entries no longer claim (a rejected row stays as the owner's).
        var mapped = version == AnimeListsMap.NoMap ? null
            : mapClaims.Select(c => WorkLinks.Key(c.Provider, c.ExternalId)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var retired = new List<string>();
        var written = await WorkLinks.WriteAsync(factory, workKey, (db, current, links) =>
        {
            if (current.LinksVersion == version) return false;
            var all = current.LinksVersion == null
                ? WorkLinks.Claims(WorkIds.FromJson(current.IdsJson), ownType, WorkLinks.FromProvider).Concat(claims).ToList()
                : claims;
            if (mapped != null)
                foreach (var gone in links.Where(l => l.Source == WorkLinks.Fribb && !l.Rejected && !mapped.Contains(WorkLinks.Key(l.Provider, l.ExternalId))).ToList())
                {
                    db.WorkLinks.Remove(gone);
                    links.Remove(gone);
                    retired.Add(WorkLinks.Key(gone.Provider, gone.ExternalId));
                }
            WorkLinks.Record(db, current, links, all, mapped == null ? null : version, time.GetUtcNow().UtcDateTime);
            WorkLinks.Apply(current, links);
            current.LinksVersion = version;
            return true;
        }, ct);
        if (written is not { Saved: true }) return;
        logger.LogInformation("Linked {WorkKey} against map {Version}: {Links}; ids {Ids}{Retired}", workKey, version,
            string.Join(", ", written.Links.Select(l => $"{l.Provider}:{l.ExternalId}{(l.Season is { } s ? $" s{s}" : "")} ({l.Source}{(l.Verified ? ", verified" : "")}{(l.Rejected ? ", rejected" : "")})")),
            written.Work.IdsJson, retired.Count > 0 ? $"; retired {string.Join(", ", retired)}" : "");
    }

    /// <summary>
    /// Whether the work is anime by the one rule (<see cref="AnimeIdentity"/>): an anime source, or its own TMDB or
    /// Cinemeta record's genres. Null (unknown) when that record could not be read or was not found: linking then waits
    /// for a later open or backfill rather than deciding "not anime" and retiring the work's map rows.
    /// </summary>
    private async Task<bool?> AnimeAsync(Work work, string type, CancellationToken ct)
    {
        // The stored verdict (anime source, or the refresh owner's reading of the work's own record) is reused, not asked again.
        if (work.IsAnime() is { } known) return known;
        if (work.Provider == null || work.ProviderId == null || !IMetadataResolver.SupportsProvider(work.Provider)) return false;
        try
        {
            if (await metadata.GetByIdAsync(work.Provider, type, work.ProviderId, ct) is { } record) return AnimeIdentity.IsAnime(record);
            logger.LogInformation("Could not tell whether {WorkKey} is anime: {Provider} returned no record; linking is tried again later", work.WorkKey, work.Provider);
            return null;
        }
        catch (Exception error) when (!ct.IsCancellationRequested)
        {
            logger.LogInformation("Could not tell whether {WorkKey} is anime: {Error}; linking is tried again later", work.WorkKey, error.Message);
            return null;
        }
    }

    /// <summary>
    /// The map entries of the work's own ids: its AniList or MAL record, else (for an anime work only) every record of
    /// its TMDB id, else of its IMDb id.
    /// </summary>
    private IReadOnlyList<AnimeListEntry> Entries(WorkIds ids, string tmdbType, bool anime)
    {
        if (ids.AniList is { } a && map.ByAniList(a) is { } byAniList) return [byAniList];
        if (ids.Mal is { } m && map.ByMal(m) is { } byMal) return [byMal];
        if (!anime) return [];
        if (ids.Tmdb is { } t && map.ByTmdb(tmdbType, t) is { Count: > 0 } byTmdb) return byTmdb;
        if (ids.Imdb is { } i && map.ByImdb(i) is { Count: > 0 } byImdb) return byImdb;
        return [];
    }

    /// <summary>
    /// One claim per id in the entries. When one TMDB series maps to several entries, each AniList and MAL record keeps
    /// the TMDB season it is; ids every entry shares (the series' TMDB, TVDB, IMDb ids) carry no season.
    /// </summary>
    private static IEnumerable<LinkClaim> FromMap(IReadOnlyList<AnimeListEntry> entries, string source, double confidence, bool verified)
    {
        static string S(int n) => n.ToString(CultureInfo.InvariantCulture);
        foreach (var e in entries)
        {
            if (e.AniList is { } a) yield return new("anilist", S(a), null, e.TmdbSeason, source, confidence, verified);
            if (e.Mal is { } m) yield return new("mal", S(m), null, e.TmdbSeason, source, confidence, verified);
            if (e.AniDb is { } d) yield return new("anidb", S(d), null, e.TmdbSeason, source, confidence, verified);
            if (e.Tvdb is { } v) yield return new("tvdb", S(v), "tv", entries.Count == 1 ? e.TmdbSeason : null, source, confidence, verified);
            if (e.TmdbTv is { } tv) yield return new("tmdb", S(tv), "tv", entries.Count == 1 ? e.TmdbSeason : null, source, confidence, verified);
            foreach (var movie in e.TmdbMovies) yield return new("tmdb", S(movie), "movie", null, source, confidence, verified);
            foreach (var imdb in e.Imdb) yield return new("imdb", imdb, null, null, source, confidence, verified);
        }
    }

    /// <summary>The AniList records' names, fetched for each linked AniList record (per-season names stay on their link).</summary>
    private async Task<List<LinkClaim>> WithNamesAsync(List<LinkClaim> claims, CancellationToken ct)
    {
        var ids = claims.Where(c => c.Provider == "anilist" && c.Names == null).Select(c => c.ExternalId).Distinct().Take(MaxNameLookups).ToList();
        if (ids.Count == 0) return claims;
        var fetched = await Task.WhenAll(ids.Select(async id =>
        {
            try { return (id, record: await metadata.GetAniListByIdAsync(id, ct)); }
            catch (Exception error) when (!ct.IsCancellationRequested)
            {
                logger.LogInformation("Could not read the names of AniList {Id}: {Error}", id, error.Message);
                return (id, record: (MediaMetadata?)null);
            }
        }));
        var names = fetched.Where(f => f.record?.ExternalId == f.id).ToDictionary(f => f.id, f => WorkNames.Of(f.record!));
        return claims.Select(c => c.Provider == "anilist" && c.Names == null && names.TryGetValue(c.ExternalId, out var n) ? c with { Names = n } : c).ToList();
    }

    /// <summary>
    /// A TMDB search by the work's English, then romaji name: same media type, the same normalized title, the same year
    /// (or one year off for an animated Japanese film, whose festival and release dates differ). Kept only when exactly
    /// one record matches; an anime match brings the map's AniList record as a suggestion too.
    /// </summary>
    private async Task<(IEnumerable<LinkClaim> Claims, bool Anime)?> SuggestTmdbAsync(Work work, string type, CancellationToken ct)
    {
        if (work.Year == null) return ([], false);
        foreach (var name in SearchNames(work))
        {
            List<MediaMetadata> hits;
            try { hits = await tmdb.SearchByTypeAsync(type, name, 10, ct); }
            catch (Exception error) when (!ct.IsCancellationRequested)
            {
                logger.LogInformation("TMDB search for {WorkKey} failed: {Error}; linking is tried again later", work.WorkKey, error.Message);
                return null;
            }
            var strong = hits.Where(h => h.MediaType == type && SameName(name, WorkNames.Of(h)) && YearFits(work.Year, h.Year, type, AnimeIdentity.IsAnime(h)))
                .DistinctBy(h => h.ExternalId).ToList();
            if (strong.Count > 1) return ([], false);
            if (strong is not [var match] || !int.TryParse(match.ExternalId, out var id)) continue;
            var claims = new List<LinkClaim> { new("tmdb", match.ExternalId!, type, null, WorkLinks.TitleSearch, SearchConfidence, false, WorkNames.Of(match)) };
            if (AnimeIdentity.IsAnime(match))
                claims.AddRange(FromMap(map.ByTmdb(type, id), WorkLinks.TitleSearch, SearchConfidence - 0.05, verified: false)
                    .Where(c => c.Provider is "anilist" or "mal"));
            return (claims, AnimeIdentity.IsAnime(match));
        }
        return ([], false);
    }

    /// <summary>An AniList search by the same names and rules (film format for a film); exactly one strong match.</summary>
    private async Task<IEnumerable<LinkClaim>?> SuggestAniListAsync(Work work, string type, CancellationToken ct)
    {
        if (work.Year == null) return [];
        foreach (var name in SearchNames(work))
        {
            List<AniListWork> hits;
            try { hits = await anilist.SearchWorksAsync(name, 8, ct); }
            catch (Exception error) when (!ct.IsCancellationRequested)
            {
                logger.LogInformation("AniList search for {WorkKey} failed: {Error}; linking is tried again later", work.WorkKey, error.Message);
                return null;
            }
            var strong = hits.Where(h => (h.Format == "MOVIE") == (type == "movie") && SameName(name, WorkNames.Of(h.Metadata))
                    && YearFits(work.Year, h.Metadata.Year, type, anime: true))
                .DistinctBy(h => h.Metadata.ExternalId).ToList();
            if (strong.Count > 1) return [];
            if (strong is not [var match] || match.Metadata.ExternalId is not { } id) continue;
            var claims = new List<LinkClaim> { new("anilist", id, null, null, WorkLinks.TitleSearch, SearchConfidence, false, WorkNames.Of(match.Metadata)) };
            if (match.Metadata.Ids?.Mal is { } mal) claims.Add(new("mal", mal.ToString(CultureInfo.InvariantCulture), null, null, WorkLinks.TitleSearch, SearchConfidence, false));
            return claims;
        }
        return [];
    }

    private static IEnumerable<string> SearchNames(Work work)
    {
        var names = work.ReadNames().WithoutLinked();
        return names.SearchNames(isAnime: true).Take(2);
    }

    private static bool SameName(string name, WorkNames candidate)
    {
        var wanted = WorkNames.Normalize(name);
        return wanted.Length > 0 && candidate.All.Any(n => n.Kind != WorkNameKind.Native && WorkNames.Normalize(n.Text) == wanted);
    }

    private static bool YearFits(int? wanted, int? found, string type, bool anime) =>
        wanted != null && found != null && (wanted == found || anime && type == "movie" && Math.Abs(wanted.Value - found.Value) == 1);

    public async Task<IReadOnlyList<WorkLinkView>?> ListAsync(string workKey, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var work = await db.Works.AsNoTracking().FirstOrDefaultAsync(w => w.WorkKey == workKey, ct);
        if (work == null) return null;
        var links = await db.WorkLinks.AsNoTracking().Where(l => l.WorkId == work.Id).ToListAsync(ct);
        return links
            .OrderBy(l => l.Rejected).ThenByDescending(l => l.Verified).ThenBy(l => Array.IndexOf(Order, l.Provider)).ThenBy(l => l.Season ?? 0).ThenBy(l => l.ExternalId)
            .Select(l => new WorkLinkView(l.Provider, l.ExternalId, l.MediaType, l.Season, l.Source, l.Confidence, l.Verified, l.Rejected,
                WorkLinks.GivesNames(links, l), WorkNames.TryRead(l.NamesJson)?.All.Select(n => n.Text).ToList() ?? [], Url(l)))
            .ToList();
    }

    private static readonly string[] Order = ["anilist", "tmdb", "mal", "imdb", "tvdb", "anidb"];

    private static string? Url(WorkLink l) => l.Provider switch
    {
        "anilist" => $"https://anilist.co/anime/{l.ExternalId}",
        "tmdb" => $"https://www.themoviedb.org/{(l.MediaType == "movie" ? "movie" : "tv")}/{l.ExternalId}",
        "mal" => $"https://myanimelist.net/anime/{l.ExternalId}",
        "imdb" => $"https://www.imdb.com/title/{l.ExternalId}/",
        "anidb" => $"https://anidb.net/anime/{l.ExternalId}",
        "tvdb" => $"https://thetvdb.com/dereferrer/series/{l.ExternalId}",
        _ => null
    };

    public async Task<bool> UnlinkAsync(string workKey, string provider, string externalId, CancellationToken ct)
    {
        var found = false;
        var written = await WorkLinks.WriteAsync(factory, workKey, (_, work, links) =>
        {
            var row = links.FirstOrDefault(l => l.Provider == provider && string.Equals(l.ExternalId, externalId, StringComparison.OrdinalIgnoreCase));
            found = row != null;
            if (row == null || row.Rejected) return false;
            row.Rejected = true;
            row.UpdatedAt = time.GetUtcNow().UtcDateTime;
            WorkLinks.Apply(work, links);
            return true;
        }, ct);
        if (written is { Saved: true })
            logger.LogInformation("Owner unlinked {Provider}:{ExternalId} from {WorkKey}; ids now {Ids}", provider, externalId, workKey, written.Work.IdsJson);
        return found;
    }
}

/// <summary>
/// Links every existing work once, in the background and throttled, after the map's cached copy is read; again for a
/// work only when the map version changes. A restart with everything linked does nothing.
/// </summary>
public sealed class WorkLinkBackfill(IDbContextFactory<TorrentFlowDbContext> factory, AnimeListsMap map, IWorkLinker linker, TimeProvider time,
    ILogger<WorkLinkBackfill> logger) : BackgroundService
{
    private static readonly TimeSpan Pause = TimeSpan.FromMilliseconds(1500);
    private static readonly TimeSpan PerWork = TimeSpan.FromSeconds(15);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Linking is background work: its AniList requests spend only the gate's background share.
        using var priority = ProviderPriority.Background();
        try
        {
            await map.Loaded.WaitAsync(stoppingToken);
            await Task.Delay(TimeSpan.FromSeconds(10), time, stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
            {
                await PassAsync(stoppingToken);
                await Task.Delay(TimeSpan.FromHours(1), time, stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }

    private async Task PassAsync(CancellationToken ct)
    {
        var version = map.Version;
        List<string> keys;
        await using (var db = await factory.CreateDbContextAsync(ct))
            keys = await db.Works.AsNoTracking().Where(w => w.LinksVersion == null || w.LinksVersion != version)
                .OrderBy(w => w.CreatedAt).Select(w => w.WorkKey).ToListAsync(ct);
        if (keys.Count == 0)
        {
            logger.LogInformation("Every work is already linked against map {Version}; nothing to backfill", version);
            return;
        }
        logger.LogInformation("Linking {Count} works against map {Version}", keys.Count, version);
        foreach (var key in keys)
        {
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(PerWork);
            try { await linker.LinkAsync(key, budget.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { logger.LogInformation("Linking {WorkKey} ran out of time; it is tried again later", key); }
            catch (Exception error) when (!ct.IsCancellationRequested) { logger.LogWarning(error, "Linking {WorkKey} failed", key); }
            await Task.Delay(Pause, time, ct);
        }
        logger.LogInformation("Finished linking works against map {Version}", version);
    }
}
