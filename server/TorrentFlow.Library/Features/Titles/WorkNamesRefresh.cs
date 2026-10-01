using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Library.Features.Titles;

/// <summary>
/// Keeps a work's stored names and ids (<see cref="Work.NamesJson"/>, <see cref="Work.IdsJson"/>), format and original
/// language in step with its own provider. A provider record already in hand is saved as it is; an AniList or
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
    public static bool Stale(Work work) => work.NamesRefreshedAt == null && work.Provider is "anilist" or "tmdb";

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
    /// stale work up first (throttled). Never throws for a provider failure: the stored names stay as they were.
    /// </summary>
    public async Task RefreshAsync(string workKey, MediaMetadata? fresh, bool fetch, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var work = await db.Works.FirstOrDefaultAsync(w => w.WorkKey == workKey, ct);
        if (work?.Provider == null || work.ProviderId == null) return;
        var own = fresh != null && fresh.Source == work.Provider && fresh.ExternalId == work.ProviderId ? fresh : null;
        if (own == null)
        {
            if (!fetch || !Stale(work) || !IMetadataResolver.SupportsProvider(work.Provider)) return;
            if (!Claim(work.Id, time.GetUtcNow())) return;

            try
            {
                var kind = work.Format == WorkFormat.Movie || work.Format == null && work.MediaType == "movie" ? "movie" : "tv";
                own = await metadata.GetByIdAsync(work.Provider, kind, work.ProviderId, ct);
            }
            catch (Exception error) when (!ct.IsCancellationRequested)
            {
                logger?.LogInformation(error, "Could not refresh the names of {WorkKey} from {Provider}", workKey, work.Provider);
                return;
            }
            if (own == null || own.Source != work.Provider || own.ExternalId != work.ProviderId) return;
        }
        var names = WorkNames.Of(own).Merge(work.ReadNames());
        var ids = (own.Ids ?? new()).Merge(work.ReadIds());
        var namesJson = names.ToJson();
        var idsJson = ids.ToJson() ?? "{}";
        var format = WorkFormats.Of(own) ?? work.Format;
        var language = WorkFormats.LanguageOf(own) ?? work.OriginalLanguage;
        var changed = namesJson != work.NamesJson || idsJson != work.IdsJson || format != work.Format || language != work.OriginalLanguage;
        if (!changed && work.NamesRefreshedAt != null) return;
        work.NamesJson = namesJson;
        work.IdsJson = idsJson;
        work.Format = format;
        work.OriginalLanguage = language;
        work.NamesRefreshedAt = time.GetUtcNow().UtcDateTime;
        await db.SaveChangesAsync(ct);
        if (!changed) return;
        var anime = AnimeIdentity.IsAnime(own) || AnimeIdentity.IsAnime(work.Provider, work.MediaType, work.ProviderId);
        logger?.LogInformation("Names of {WorkKey}: {Names}; ids {Ids}; format {Format}; original language {Language}; searched as anime: {AnimeSearch}; otherwise: {OtherSearch}; this work searches as {Kind}",
            workKey, string.Join(" | ", names.All.Select(n => $"{n.Kind}: {n.Text}")), idsJson, format, language,
            string.Join(" | ", names.SearchNames(true)), string.Join(" | ", names.SearchNames(false)), anime ? "anime" : "non-anime");
    }
}
