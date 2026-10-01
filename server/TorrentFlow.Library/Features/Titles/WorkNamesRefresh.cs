using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Library.Features.Titles;

/// <summary>
/// Keeps a work's stored names and ids (<see cref="Work.NamesJson"/>, <see cref="Work.IdsJson"/>) in step with its own
/// provider. A provider record already in hand is saved as it is; a work whose names never came from its provider (no
/// MAL id from AniList, no IMDb id from TMDB, or an anime without an English or Romaji name) is looked up again on the
/// next grab or title open, at most once a day per work.
/// </summary>
public sealed class WorkNamesRefresh(IDbContextFactory<TorrentFlowDbContext> factory, IMetadataResolver metadata, TimeProvider time,
    ILogger<WorkNamesRefresh>? logger = null)
{
    private static readonly TimeSpan Interval = TimeSpan.FromDays(1);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _tried = new(StringComparer.Ordinal);

    /// <summary>Whether this work's names or ids still lack what its provider can tell.</summary>
    public static bool Stale(Work work)
    {
        var ids = work.ReadIds();
        var names = work.ReadNames();
        return work.Provider switch
        {
            "anilist" => ids.Mal == null || !names.Has(WorkNameKind.English) || !names.Has(WorkNameKind.Romaji),
            "tmdb" => ids.Imdb == null || AnimeIdentity.IsAnime(work.Provider, work.MediaType, work.ProviderId)
                && (!names.Has(WorkNameKind.English) || !names.Has(WorkNameKind.Romaji)),
            _ => false
        };
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
            var now = time.GetUtcNow();
            if (_tried.TryGetValue(work.Id, out var last) && now - last < Interval) return;
            _tried[work.Id] = now;
            try { own = await metadata.GetByIdAsync(work.Provider, work.MediaType == "movie" ? "movie" : "tv", work.ProviderId, ct); }
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
        if (namesJson == work.NamesJson && idsJson == work.IdsJson) return;
        work.NamesJson = namesJson;
        work.IdsJson = idsJson;
        await db.SaveChangesAsync(ct);
        var anime = AnimeIdentity.IsAnime(own) || AnimeIdentity.IsAnime(work.Provider, work.MediaType, work.ProviderId);
        logger?.LogInformation("Names of {WorkKey}: {Names}; ids {Ids}; searched as anime: {AnimeSearch}; otherwise: {OtherSearch}; this work searches as {Kind}",
            workKey, string.Join(" | ", names.All.Select(n => $"{n.Kind}: {n.Text}")), idsJson,
            string.Join(" | ", names.SearchNames(true)), string.Join(" | ", names.SearchNames(false)), anime ? "anime" : "non-anime");
    }
}
