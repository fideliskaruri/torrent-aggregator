using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using TorrentFlow.Api.Catalog;
using TorrentFlow.Domain;
using TorrentFlow.Library.Jellyfin;
using TorrentFlow.Store;

namespace TorrentFlow.Api;

internal sealed record WatchLaterItem(string WatchItemId, string WorkKey, string MediaType,
    string Title, int? Year, string? PosterUrl, string State, DateTimeOffset? AvailableAt,
    bool Watched, bool NewEpisodes, bool Unavailable, bool Series = false);
internal sealed record WatchLaterEntry(string UserId, WatchLaterItem Item,
    DateTimeOffset SavedAt = default, DateTimeOffset? OutSince = null);
internal sealed record WatchLaterResult(ImmutableArray<WatchLaterItem> Items, bool JellyfinStale);

internal sealed class WatchLaterJellyfinSnapshots
{
    private readonly ConcurrentDictionary<string, ImmutableDictionary<string, JellyfinTitleState>> snapshots = new();

    public ImmutableDictionary<string, JellyfinTitleState> Read(string key) =>
        snapshots.GetValueOrDefault(key, ImmutableDictionary<string, JellyfinTitleState>.Empty);

    public void Remember(string key, ImmutableDictionary<string, JellyfinTitleState> values) =>
        snapshots.AddOrUpdate(key, values, (_, current) => current.SetItems(values));
}

internal sealed class WatchLaterReadService(TorrentFlowDbContext db,
    IConfiguration configuration, WatchLaterJellyfinSnapshots jellyfinSnapshots)
{
    public async Task<WatchLaterResult> ReadAsync(string userId, CancellationToken ct)
    {
        var projected = await ProjectAsync(await CandidatesAsync(userId, ct), userId, ct);
        return new([.. projected.Entries.Select(entry => entry.Item)], projected.JellyfinStale);
    }

    public async Task<ImmutableArray<WatchLaterEntry>> ReadAllAsync(CancellationToken ct)
    {
        var candidates = await CandidatesAsync(null, ct);
        return (await ProjectAsync(candidates, null, ct)).Entries;
    }

    private async Task<WatchItemRow[]> CandidatesAsync(string? userId, CancellationToken ct)
    {
        var query = db.WatchItems.AsNoTracking().Where(item => item.Status == WatchStatus.Planned &&
            !db.Follows.AsNoTracking().Any(follow => follow.WorkId == item.WorkId && follow.Enabled));
        if (userId is not null) query = query.Where(item => item.UserId == userId);
        return await query.OrderByDescending(item => item.UpdatedAt).ThenBy(item => item.Id).ToArrayAsync(ct);
    }

    private async Task<ProjectedEntries> ProjectAsync(WatchItemRow[] candidates, string? userId, CancellationToken ct)
    {
        if (candidates.Length == 0) return new([], false);
        var workIds = candidates.Select(item => item.WorkId).Distinct(StringComparer.Ordinal).ToArray();
        var works = await db.Works.AsNoTracking().Where(work => workIds.Contains(work.Id)).ToArrayAsync(ct);
        var names = await db.WorkNames.AsNoTracking().Where(name => workIds.Contains(name.WorkId))
            .OrderBy(name => name.Ordinal).ThenBy(name => name.Id).ToArrayAsync(ct);
        var links = await db.WorkLinks.AsNoTracking().Where(link => workIds.Contains(link.WorkId)).ToArrayAsync(ct);
        var seasons = await db.Seasons.AsNoTracking().Where(season => workIds.Contains(season.WorkId))
            .OrderBy(season => season.Number).ToArrayAsync(ct);
        var seasonIds = seasons.Select(season => season.Id).ToArray();
        EpisodeRow[] episodes = seasonIds.Length == 0 ? [] :
            await db.Episodes.AsNoTracking().Where(episode => seasonIds.Contains(episode.SeasonId))
                .OrderBy(episode => episode.Number).ToArrayAsync(ct);
        var targets = await db.Targets.AsNoTracking().Where(target => workIds.Contains(target.WorkId) &&
            target.State != TargetState.Done &&
            target.State != TargetState.Removed)
            .Select(target => target.WorkId).Distinct().ToArrayAsync(ct);
        var activeWorkIds = targets.ToHashSet(StringComparer.Ordinal);
        var media = await db.MediaFiles.AsNoTracking().Where(file => workIds.Contains(file.WorkId))
            .ToArrayAsync(ct);
        var filesByWork = media.Where(file => file.Role == FileRole.Video &&
                file.Status is FilePresence.Present or FilePresence.Offline)
            .Select(file => file.WorkId).ToHashSet(StringComparer.Ordinal);
        var worksById = works.ToDictionary(work => work.Id, StringComparer.Ordinal);
        var namesByWork = names.ToLookup(name => name.WorkId, StringComparer.Ordinal);
        var linksByWork = links.ToLookup(link => link.WorkId, StringComparer.Ordinal);
        var seasonsByWork = seasons.ToLookup(season => season.WorkId, StringComparer.Ordinal);
        var episodesBySeason = episodes.ToLookup(episode => episode.SeasonId, StringComparer.Ordinal);
        var snapshots = works.Select(work => new WorkSnapshot(work,
            [.. namesByWork[work.Id]], [.. linksByWork[work.Id]], [.. seasonsByWork[work.Id]],
            [.. seasonsByWork[work.Id].SelectMany(season => episodesBySeason[season.Id])])).ToArray();
        var snapshotsById = snapshots.ToDictionary(snapshot => snapshot.Work.Id, StringComparer.Ordinal);
        var filesByWorkLookup = media.Where(file => file.Role == FileRole.Video &&
                file.Status is FilePresence.Present or FilePresence.Offline)
            .ToLookup(file => file.WorkId, StringComparer.Ordinal);
        var jellyfin = await ReadJellyfinAsync(snapshots, filesByWorkLookup, userId, ct);
        var now = DateTimeOffset.UtcNow;
        var entries = candidates.Select(item =>
        {
            if (!worksById.TryGetValue(item.WorkId, out var work))
                return new WatchLaterEntry(item.UserId, new(item.Id, item.WorkId, "unknown",
                    item.WorkId, null, null, "unavailable", null, false, false, true));

            var snapshot = snapshotsById[work.Id];
            var gate = ReleaseAvailability.BrowseGate(snapshot, now);
            jellyfin.Items.TryGetValue(work.Id, out var watchedState);
            var watched = Watched(snapshot, watchedState, now, out var newEpisodes);
            var hasJellyfinItem = watchedState is not null &&
                (watchedState.Film is not null || watchedState.Episodes.Count > 0);
            var state = activeWorkIds.Contains(work.Id) ? "downloading" :
                filesByWork.Contains(work.Id) || hasJellyfinItem ? "inLibrary" :
                gate.Coming ? "coming" : gate.InTheatricalWindow ? "inCinemas" : "available";
            return new WatchLaterEntry(item.UserId, new(item.Id, work.WorkKey, CatalogProjection.Type(snapshot),
                CatalogProjection.Title(snapshot), work.Year, work.PosterUrl, state,
                state is "coming" or "inCinemas" ? gate.AvailableAt : null,
                watched, newEpisodes, false, CatalogProjection.Series(snapshot)), item.CreatedAt, ReleaseAvailability.OutSince(snapshot));
        }).ToImmutableArray();
        return new(entries, jellyfin.Stale);
    }

    private async Task<JellyfinRead> ReadJellyfinAsync(WorkSnapshot[] works,
        ILookup<string, MediaFileRow> filesByWork, string? userId, CancellationToken ct)
    {
        JellyfinSettings settings;
        try
        {
            var row = await db.Settings.AsNoTracking().SingleOrDefaultAsync(setting => setting.Id == "jellyfin", ct);
            if (row is null) return new(ImmutableDictionary<string, JellyfinTitleState>.Empty, false);
            settings = SettingsCatalog.Read<JellyfinSettings>(row);
            if (settings.ServerUrl is null || settings.Credential is null ||
                string.IsNullOrWhiteSpace(settings.UserId))
                return new(ImmutableDictionary<string, JellyfinTitleState>.Empty, false);
            var mapped = settings.UserMappings.FirstOrDefault(mapping =>
                string.Equals(mapping.TorrentFlowUserId, userId, StringComparison.Ordinal))?.JellyfinUserId;
            if (!string.IsNullOrWhiteSpace(mapped)) settings = settings with { UserId = mapped };
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        {
            return new(ImmutableDictionary<string, JellyfinTitleState>.Empty, true);
        }

        var cacheKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            settings.ServerUrl + "|" + settings.UserId + "|" + settings.Credential.FileId +
            "|" + settings.Credential.Revision)));
        string? key;
        try { key = SecretFiles.Read(HostPaths.DataDirectory(configuration), settings.Credential); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        { return new(jellyfinSnapshots.Read(cacheKey), true); }
        if (string.IsNullOrWhiteSpace(key)) return new(jellyfinSnapshots.Read(cacheKey), true);

        try
        {
            var result = await JellyfinEndpoints.Adapter.ReadBatchWithStatusAsync(settings, key,
                works.Select(work => (work, filesByWork[work.Work.Id].ToImmutableArray())), ct);
            if (result.Status == "ok")
            {
                jellyfinSnapshots.Remember(cacheKey, result.Items);
                return new(result.Items, false);
            }
            if (result.Status == "off")
                return new(ImmutableDictionary<string, JellyfinTitleState>.Empty, false);
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or JsonException or ArgumentException)
        {
            if (ct.IsCancellationRequested) throw;
        }
        return new(jellyfinSnapshots.Read(cacheKey), true);
    }

    private static bool Watched(WorkSnapshot work, JellyfinTitleState? state, DateTimeOffset now,
        out bool newEpisodes)
    {
        newEpisodes = false;
        if (state is null) return false;
        if (work.Work.Kind == WorkKind.Film) return state.Film?.Watched == true;
        if (work.Work.Kind != WorkKind.Series) return false;

        var seasons = work.Seasons.ToDictionary(season => season.Id);
        var aired = work.Episodes.Where(episode => episode.MappingStatus == MappingStatus.Confirmed &&
            episode.AirAt is { } airAt && airAt <= now &&
            seasons.TryGetValue(episode.SeasonId, out var season) && season.Number >= 1).ToArray();
        var watched = aired.Where(episode => state.Episodes.TryGetValue(episode.Id, out var progress) &&
            progress.Watched).ToArray();
        if (aired.Length > 0 && watched.Length == aired.Length) return true;
        var latestPlayedAt = watched.Select(episode => state.Episodes[episode.Id].LastPlayedAt)
            .OfType<DateTimeOffset>().Select(value => (DateTimeOffset?)value).Max();
        newEpisodes = latestPlayedAt is { } playedAt && aired.Any(episode =>
            episode.AirAt > playedAt && (!state.Episodes.TryGetValue(episode.Id, out var progress) ||
                !progress.Watched));
        return false;
    }

    private sealed record ProjectedEntries(ImmutableArray<WatchLaterEntry> Entries, bool JellyfinStale);
    private sealed record JellyfinRead(ImmutableDictionary<string, JellyfinTitleState> Items, bool Stale);
}
