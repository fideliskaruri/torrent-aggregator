using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Library.Features.Titles;

/// <summary>
/// Keeps a work's stored names and ids (<see cref="Work.NamesJson"/>, <see cref="Work.IdsJson"/>), format, original
/// language and anime verdict (<see cref="Work.Anime"/>) in step with its own provider. A provider record already in hand is saved as it is; an AniList or
/// TMDB work whose names never came from its provider (<see cref="Work.NamesRefreshedAt"/> unset) is looked up on the
/// next grab or title open, at most once a day per work.
/// </summary>
public sealed class WorkNamesRefresh(IDbContextFactory<TorrentFlowDbContext> factory, IMetadataResolver metadata, TimeProvider time,
    ILogger<WorkNamesRefresh>? logger = null, IProviderPacing? pacing = null)
{
    private static readonly TimeSpan Interval = TimeSpan.FromDays(1);
    /// <summary>How often a grab that cannot place its download without the verdict may skip the once-a-day limit, per work.</summary>
    private static readonly TimeSpan UrgentInterval = TimeSpan.FromMinutes(10);
    /// <summary>The one shared lookup's own budget; every caller waits for it within its own.</summary>
    private static readonly TimeSpan LookupBudget = TimeSpan.FromSeconds(10);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _tried = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _urgent = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Task<NamesRefresh>> _lookups = new(StringComparer.Ordinal);
    private readonly Lock _lookupsLock = new();

    /// <summary>
    /// Whether this work's names, ids, format and language were never taken from its own provider (AniList or TMDB; the
    /// others give nothing more than ingest stored), or its format or anime verdict is still unknown. Once taken, values
    /// the provider doesn't know (TMDB "xx", a country with no mapped language, no IMDb id) stay unknown rather than being fetched again.
    /// </summary>
    public static bool Stale(Work work) =>
        work.NamesRefreshedAt == null && work.Provider is "anilist" or "tmdb"
        || (work.Anime == null || work.Format == null) && work.Provider != null && work.ProviderId != null && IMetadataResolver.SupportsProvider(work.Provider);

    /// <summary>Claims this work's once-a-day lookup; only one caller wins a slot, however many race for it.</summary>
    private static bool Claim(ConcurrentDictionary<string, DateTimeOffset> tried, TimeSpan interval, string workId, DateTimeOffset now)
    {
        while (true)
        {
            if (tried.TryAdd(workId, now)) return true;
            if (!tried.TryGetValue(workId, out var last)) continue;
            if (now - last < interval) return false;
            if (tried.TryUpdate(workId, now, last)) return true;
        }
    }

    /// <summary>
    /// Saves <paramref name="fresh"/> when it is this work's own provider record; with <paramref name="fetch"/>, looks a
    /// stale work up first. However many callers ask at once (every episode of a season grab), one lookup goes out per
    /// work and the rest wait for it. It is throttled to once a day per work; <paramref name="unthrottled"/> (a grab that
    /// cannot place its download without the verdict) may also start one once every ten minutes. Never throws for a
    /// provider failure: the stored names stay as they were.
    /// </summary>
    public async Task<NamesRefresh> RefreshAsync(string workKey, MediaMetadata? fresh, bool fetch, CancellationToken ct, bool unthrottled = false)
    {
        Work? work;
        await using (var read = await factory.CreateDbContextAsync(ct))
            work = await read.Works.AsNoTracking().FirstOrDefaultAsync(w => w.WorkKey == workKey, ct);
        if (work?.Provider == null || work.ProviderId == null) return NamesRefresh.Skipped;
        var own = fresh != null && fresh.Source == work.Provider && fresh.ExternalId == work.ProviderId ? fresh : null;
        if (own != null) return await SaveAsync(workKey, own, ct);
        if (!fetch || !Stale(work) || !IMetadataResolver.SupportsProvider(work.Provider)) return NamesRefresh.Skipped;

        Task<NamesRefresh> lookup;
        lock (_lookupsLock)
        {
            if (!_lookups.TryGetValue(work.Id, out lookup!))
            {
                var now = time.GetUtcNow();
                if (pacing?.BlockedUntil(work.Provider) != null) return NamesRefresh.RateLimited;
                if (!Claim(_tried, Interval, work.Id, now) && !(unthrottled && Claim(_urgent, UrgentInterval, work.Id, now))) return NamesRefresh.Skipped;
                var started = work;
                lookup = Task.Run(() => LookupAsync(started));
                _lookups[work.Id] = lookup;
                _ = lookup.ContinueWith(_ => { lock (_lookupsLock) _lookups.Remove(started.Id); }, TaskScheduler.Default);
            }
        }
        return await lookup.WaitAsync(ct);
    }

    /// <summary>The one lookup of a stale work, shared by every caller waiting on it, on its own budget.</summary>
    private async Task<NamesRefresh> LookupAsync(Work work)
    {
        using var budget = new CancellationTokenSource(LookupBudget);
        MediaMetadata? own;
        logger?.LogInformation("Asking {Provider} about {WorkKey} (names, format, anime)", work.Provider, work.WorkKey);
        try
        {
            var kind = work.IsSeries() ? "tv" : "movie";
            own = await metadata.GetByIdAsync(work.Provider!, kind, work.ProviderId!, budget.Token);
        }
        catch (OperationCanceledException)
        {
            logger?.LogInformation("{Provider} did not answer about {WorkKey} in time; a later grab or pass asks again", work.Provider, work.WorkKey);
            return NamesRefresh.Failed;
        }
        catch (Exception error)
        {
            if (Limited(work.Provider!)) return NamesRefresh.RateLimited;
            logger?.LogInformation("Could not refresh the names of {WorkKey} from {Provider}: {Error}", work.WorkKey, work.Provider, error.Message);
            await CheckedAsync(work.WorkKey, budget.Token);
            return NamesRefresh.Failed;
        }
        if (own == null || own.Source != work.Provider || own.ExternalId != work.ProviderId)
        {
            // An empty answer while the provider refuses requests is a rate limit, never "not found".
            if (Limited(work.Provider!)) return NamesRefresh.RateLimited;
            await CheckedAsync(work.WorkKey, budget.Token);
            return NamesRefresh.NotFound;
        }
        return await SaveAsync(work.WorkKey, own, budget.Token);
    }

    private bool Limited(string provider) => pacing?.BlockedUntil(provider) != null;

    /// <summary>Notes that the provider was asked and gave no verdict, so the backfill waits a day before asking again.</summary>
    private async Task CheckedAsync(string workKey, CancellationToken ct)
    {
        try
        {
            await WorkLinks.WriteAsync(factory, workKey, (_, current, _) =>
            {
                if (current.Anime != null) return false;
                current.AnimeCheckedAt = time.GetUtcNow().UtcDateTime;
                return true;
            }, ct);
        }
        catch (Exception error) when (error is DbUpdateException or OperationCanceledException)
        {
            logger?.LogInformation("Could not note the anime check of {WorkKey}: {Error}", workKey, error.Message);
        }
    }

    private async Task<NamesRefresh> SaveAsync(string workKey, MediaMetadata own, CancellationToken ct)
    {
        MediaMetadata record = own;
        var changed = false;
        LinkWrite? written;
        try
        {
            written = await WorkLinks.WriteAsync(factory, workKey, (db, current, links) =>
            {
                if (current.Provider != record.Source || current.ProviderId != record.ExternalId) return false;
                var priorNames = current.NamesJson;
                var priorIds = current.IdsJson;
                current.NamesJson = WorkNames.Of(record).Merge(current.ReadNames()).ToJson();
                // The ids the provider reports about itself are verified crosswalk rows; the ids and linked names are
                // rebuilt from the rows by their one writer, so an unlinked id never comes back through a refresh.
                WorkLinks.Record(db, current, links, WorkLinks.Claims(record.Ids, record.MediaType == "movie" ? "movie" : "tv", WorkLinks.FromProvider),
                    null, time.GetUtcNow().UtcDateTime);
                WorkLinks.Apply(current, links);
                var format = WorkFormats.Of(record) ?? current.Format;
                var language = WorkFormats.LanguageOf(record) ?? current.OriginalLanguage;
                var anime = AnimeIdentity.IsAnime(record);
                changed = current.NamesJson != priorNames || current.IdsJson != priorIds || format != current.Format || language != current.OriginalLanguage
                    || anime != current.Anime;
                if (!changed && current.NamesRefreshedAt != null) return false;
                current.Format = format;
                current.OriginalLanguage = language;
                current.Anime = anime;
                current.NamesRefreshedAt = time.GetUtcNow().UtcDateTime;
                return true;
            }, ct);
        }
        catch (DbUpdateException error)
        {
            logger?.LogWarning("Could not save the names of {WorkKey}; a later open or grab tries again: {Error}", workKey, error.InnerException?.Message ?? error.Message);
            return NamesRefresh.Failed;
        }
        if (written is not { Saved: true } || !changed) return NamesRefresh.Unchanged;
        var saved = written.Work;
        var names = saved.ReadNames();
        logger?.LogInformation("Names of {WorkKey}: {Names}; ids {Ids}; format {Format}; original language {Language}; searched as anime: {AnimeSearch}; otherwise: {OtherSearch}; this work is {Kind}",
            workKey, string.Join(" | ", names.All.Select(n => $"{n.Kind}: {n.Text}")), saved.IdsJson, saved.Format, saved.OriginalLanguage,
            string.Join(" | ", names.SearchNames(true)), string.Join(" | ", names.SearchNames(false)), saved.IsAnime() switch { true => "anime", false => "non-anime", null => "unknown" });
        return NamesRefresh.Saved;
    }
}

/// <summary>How a <see cref="WorkNamesRefresh.RefreshAsync"/> went: <see cref="NamesRefresh.RateLimited"/> is never "not found" and is asked again soon.</summary>
public enum NamesRefresh { Skipped, Saved, Unchanged, NotFound, RateLimited, Failed }
