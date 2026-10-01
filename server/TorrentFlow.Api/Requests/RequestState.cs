using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Metadata.Browse;

namespace TorrentFlow.Api.Requests;

/// <summary>
/// What a requester is told about a request: the one derivation the title page, Requests, notifications and Library
/// share. <see cref="Phase"/> follows what was asked for (requested, approved, downloading, available) and only says
/// available once the film's or every wanted episode's files are on disk. Counts only, never transfer stats.
/// </summary>
public sealed record RequestProgress(string Phase, int Done, int Total)
{
    public const string Downloading = "downloading";
    public const string Available = "available";
}

/// <summary>
/// The library as files on disk, read from the same ready transfers as the Downloaded rail
/// (<see cref="BrowseService.ReadyTorrentsAsync"/>): which films and which episodes of each work are there.
/// </summary>
public sealed class LibraryOnDisk
{
    private readonly HashSet<string> _films;
    private readonly Dictionary<string, HashSet<(int Season, int Episode)>> _episodes;
    private readonly List<ReleaseIdentity> _unmatched;
    private readonly Dictionary<string, List<(int? Season, int? Episode, bool Ready)>> _wanted;

    private LibraryOnDisk(HashSet<string> films, Dictionary<string, HashSet<(int, int)>> episodes, List<ReleaseIdentity> unmatched,
        Dictionary<string, List<(int?, int?, bool)>> wanted)
    {
        _films = films;
        _episodes = episodes;
        _unmatched = unmatched;
        _wanted = wanted;
    }

    public static async Task<LibraryOnDisk> LoadAsync(TorrentFlowDbContext db, BrowseService browse, CancellationToken ct)
    {
        var ready = await browse.ReadyTorrentsAsync(LocalUser.Id, 5000, ct);
        var hashes = ready.Select(t => t.Hash.ToLowerInvariant()).ToHashSet(StringComparer.Ordinal);
        var targets = await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.Status != "failed")
            .Select(t => new { t.WorkKey, t.Scope, t.Season, t.Episode, t.InfoHash }).ToListAsync(ct);
        var workIds = ready.Select(t => t.WorkId).OfType<string>().Distinct().ToList();
        var workKeys = await db.Works.AsNoTracking().Where(w => workIds.Contains(w.Id)).ToDictionaryAsync(w => w.Id, w => w.WorkKey, ct);

        var films = new HashSet<string>(StringComparer.Ordinal);
        var episodes = new Dictionary<string, HashSet<(int, int)>>(StringComparer.Ordinal);
        var wanted = new Dictionary<string, List<(int?, int?, bool)>>(StringComparer.Ordinal);
        var claimed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var t in targets)
        {
            var isReady = t.InfoHash is { } h && hashes.Contains(h.ToLowerInvariant());
            if (!wanted.TryGetValue(t.WorkKey, out var list)) wanted[t.WorkKey] = list = [];
            list.Add((t.Season, t.Episode, isReady));
            if (!isReady) continue;
            claimed.Add(t.InfoHash!.ToLowerInvariant());
            if (t.Scope == "episode" && t.Season is { } s && t.Episode is { } e) Add(episodes, t.WorkKey, (s, e));
            else if (t.Scope == "title") films.Add(t.WorkKey);
        }
        var unmatched = new List<ReleaseIdentity>();
        foreach (var torrent in ready.Where(t => !claimed.Contains(t.Hash.ToLowerInvariant())))
        {
            var identity = ReleaseNames.WorkIdentity(torrent.Name);
            var key = torrent.WorkId is { } id ? workKeys.GetValueOrDefault(id) : null;
            var episode = ReleaseEpisodeParser.Parse(torrent.Name);
            if (key != null && episode is { Season: { } s, Episode: { } e } && !episode.IsBatch) Add(episodes, key, (s, e));
            else if (key != null && !identity.IsSeries) films.Add(key);
            else unmatched.Add(identity);
        }
        return new LibraryOnDisk(films, episodes, unmatched, wanted);
    }

    private static void Add(Dictionary<string, HashSet<(int, int)>> map, string key, (int, int) episode)
    {
        if (!map.TryGetValue(key, out var set)) map[key] = set = [];
        set.Add(episode);
    }

    /// <summary>The film's file is on disk (matched by its work, else by its release name like the Downloaded rail).</summary>
    public bool HasFilm(string workKey) =>
        _films.Contains(workKey) || _unmatched.Any(r => !r.IsSeries && TorrentFlow.Core.Text.WorkKeySlug.Matches(workKey, r.Name, r.Year));

    /// <summary>Seasons of this work with at least one episode on disk and none still wanted.</summary>
    public IReadOnlyList<int> AvailableSeasons(string workKey)
    {
        if (!_episodes.TryGetValue(workKey, out var onDisk)) return [];
        var open = _wanted.GetValueOrDefault(workKey)?.Where(w => w.Season != null && w.Episode != null && !w.Ready)
            .Select(w => w.Season!.Value).ToHashSet() ?? [];
        return onDisk.Select(e => e.Season).Distinct().Where(s => !open.Contains(s)).Order().ToList();
    }

    /// <summary>
    /// The derived state of one request (<see cref="RequestProgress"/>). Seasons count the episodes the queue wants
    /// for them; a season request never counts other seasons, so it never marks the whole show.
    /// </summary>
    public RequestProgress Progress(MediaRequest row)
    {
        var status = row.Status;
        if (status is MediaRequestStatus.Pending or MediaRequestStatus.Declined or MediaRequestStatus.Cancelled) return new(status, 0, 0);
        var started = !string.IsNullOrEmpty(row.GrabbedHashes);
        if (row.Scope == MediaRequestScope.Movie)
        {
            if (HasFilm(row.WorkKey)) return new(RequestProgress.Available, 1, 1);
            return new(started || status == MediaRequestStatus.Fulfilled ? RequestProgress.Downloading : status, 0, 1);
        }
        var seasons = RequestRules.ParseSeasons(row.Seasons);
        var all = row.Scope == MediaRequestScope.Series || seasons.Count == 0;
        var onDisk = _episodes.GetValueOrDefault(row.WorkKey) ?? [];
        var wanted = (_wanted.GetValueOrDefault(row.WorkKey) ?? [])
            .Where(w => w.Season is { } s && w.Episode != null && (all || seasons.Contains(s)))
            .Select(w => (w.Season!.Value, w.Episode!.Value)).ToHashSet();
        wanted.UnionWith(onDisk.Where(e => all || seasons.Contains(e.Season)));
        var done = wanted.Count(onDisk.Contains);
        if (wanted.Count > 0 && done == wanted.Count) return new(RequestProgress.Available, done, wanted.Count);
        if (started || done > 0 || status == MediaRequestStatus.Fulfilled) return new(RequestProgress.Downloading, done, wanted.Count);
        return new(status, done, wanted.Count);
    }
}
