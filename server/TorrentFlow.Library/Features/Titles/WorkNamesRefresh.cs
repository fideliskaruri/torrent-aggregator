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
    ILogger<WorkNamesRefresh>? logger = null)
{
    private static readonly TimeSpan Interval = TimeSpan.FromDays(1);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _tried = new(StringComparer.Ordinal);

    /// <summary>
    /// Whether this work's names, ids, format and language were never taken from its own provider (AniList or TMDB; the
    /// others give nothing more than ingest stored). Once taken, values the provider doesn't know (TMDB "xx", a country
    /// with no mapped language, no IMDb id) stay unknown rather than being fetched again.
    /// </summary>
    public static bool Stale(Work work) =>
        work.NamesRefreshedAt == null && work.Provider is "anilist" or "tmdb"
        || work.Anime == null && work.Provider != null && work.ProviderId != null && IMetadataResolver.SupportsProvider(work.Provider);

    /// <summary>Claims this work's once-a-day lookup; only one caller wins a slot, however many race for it.</summary>
    private bool Claim(string workId, DateTimeOffset now)
    {
        while (true)
        {
            if (_tried.TryAdd(workId, now)) return true;
            if (!_tried.TryGetValue(workId, out var last)) continue;
            if (now - last < Interval) return false;
            if (_tried.TryUpdate(workId, now, last)) return true;
        }
    }

    /// <summary>
    /// Saves <paramref name="fresh"/> when it is this work's own provider record; with <paramref name="fetch"/>, looks a
    /// stale work up first (throttled; <paramref name="unthrottled"/> skips the once-a-day limit, for a grab that cannot
    /// place its download without the anime verdict). Never throws for a provider failure: the stored names stay as they were.
    /// </summary>
    public async Task RefreshAsync(string workKey, MediaMetadata? fresh, bool fetch, CancellationToken ct, bool unthrottled = false)
    {
        Work? work;
        await using (var read = await factory.CreateDbContextAsync(ct))
            work = await read.Works.AsNoTracking().FirstOrDefaultAsync(w => w.WorkKey == workKey, ct);
        if (work?.Provider == null || work.ProviderId == null) return;
        var own = fresh != null && fresh.Source == work.Provider && fresh.ExternalId == work.ProviderId ? fresh : null;
        if (own == null)
        {
            if (!fetch || !Stale(work) || !IMetadataResolver.SupportsProvider(work.Provider)) return;
            if (!Claim(work.Id, time.GetUtcNow()) && !unthrottled) return;

            try
            {
                var kind = work.IsSeries() ? "tv" : "movie";
                own = await metadata.GetByIdAsync(work.Provider, kind, work.ProviderId, ct);
            }
            catch (Exception error) when (!ct.IsCancellationRequested)
            {
                logger?.LogInformation(error, "Could not refresh the names of {WorkKey} from {Provider}", workKey, work.Provider);
                return;
            }
            if (own == null || own.Source != work.Provider || own.ExternalId != work.ProviderId) return;
        }

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
            return;
        }
        if (written is not { Saved: true } || !changed) return;
        var saved = written.Work;
        var names = saved.ReadNames();
        logger?.LogInformation("Names of {WorkKey}: {Names}; ids {Ids}; format {Format}; original language {Language}; searched as anime: {AnimeSearch}; otherwise: {OtherSearch}; this work is {Kind}",
            workKey, string.Join(" | ", names.All.Select(n => $"{n.Kind}: {n.Text}")), saved.IdsJson, saved.Format, saved.OriginalLanguage,
            string.Join(" | ", names.SearchNames(true)), string.Join(" | ", names.SearchNames(false)), saved.IsAnime() switch { true => "anime", false => "non-anime", null => "unknown" });
    }
}
