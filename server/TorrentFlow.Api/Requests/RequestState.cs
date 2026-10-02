using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Metadata.Browse;

namespace TorrentFlow.Api.Requests;

/// <summary>
/// What a requester is told about a request: the one derivation the title page, Requests, notifications and Library
/// share. <see cref="Phase"/> follows what was asked for (requested, approved, downloading, available) and only says
/// available once the film's or every wanted episode's files are on disk. Counts only, never transfer stats.
/// </summary>
/// <param name="Airing">A requested season still has episodes to come: "Available" then means every aired one is here,
/// and new episodes download as they air.</param>
public sealed record RequestProgress(string Phase, int Done, int Total, bool Airing = false)
{
    public const string AiringNote = "New episodes download as they air";
    public const string Downloading = "downloading";
    public const string Available = "available";
}

/// <summary>
/// Whether the transfers a request tracks are still alive, by the one healthy-transfer predicate
/// (<see cref="EngineTorrentStatus.IsHealthy"/>). A transfer in error or with missing files has stopped and needs the
/// owner; one the owner removed is gone on purpose and never counts as stopped.
/// </summary>
public static class RequestHealth
{
    public static IReadOnlyList<string> Hashes(string? grabbed) =>
        (grabbed ?? "").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(h => h.ToLowerInvariant()).Distinct().ToList();

    public static string? Join(IEnumerable<string> hashes) => hashes.Any() ? string.Join(',', hashes) : null;

    /// <summary>The engine says the transfer stopped (error, missing files), as opposed to removed or still alive.</summary>
    public static bool IsStopped(string? status) => status?.ToLowerInvariant() is "error" or "missingfiles";

    /// <summary>A set of hashes as stored on a request: lowercased, sorted, comma-separated; null when empty.</summary>
    public static string? Sorted(IEnumerable<string> hashes) =>
        Join(hashes.Select(h => h.ToLowerInvariant()).Distinct().Order(StringComparer.Ordinal));

    /// <summary>The engine rows (status, queue key, progress) of <paramref name="hashes"/>, keyed by lowercased hash; removed rows are absent.</summary>
    public static async Task<Dictionary<string, (string Status, string? QueueKey, double Progress)>> StatesAsync(TorrentFlowDbContext db,
        IEnumerable<string> hashes, CancellationToken ct)
    {
        var wanted = hashes.Select(h => h.ToLowerInvariant()).Distinct().ToList();
        if (wanted.Count == 0) return new(StringComparer.Ordinal);
        var rows = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == LocalUser.Id && wanted.Contains(t.Hash.ToLower()))
            .Select(t => new { t.Hash, t.Status, t.QueueKey, t.Progress }).ToListAsync(ct);
        return rows.Where(t => !string.Equals(t.Status, "removed", StringComparison.OrdinalIgnoreCase))
            .GroupBy(t => t.Hash.ToLowerInvariant())
            .ToDictionary(g => g.Key, g => (g.First().Status, g.First().QueueKey, g.First().Progress), StringComparer.Ordinal);
    }

    /// <summary>The healthy ones among <paramref name="hashes"/>, lowercased.</summary>
    public static async Task<HashSet<string>> HealthyAsync(TorrentFlowDbContext db, IEnumerable<string> hashes, CancellationToken ct) =>
        (await StatesAsync(db, hashes, ct)).Where(s => EngineTorrentStatus.IsHealthy(s.Value.Status)).Select(s => s.Key).ToHashSet(StringComparer.Ordinal);
}

/// <summary>
/// A season request's high-water mark (<see cref="MediaRequest.FulfilledThrough"/>): per season, the last episode it
/// covered when it was fulfilled. Reopened by a newly aired episode, the request only counts episodes above it, so an
/// episode the owner deleted is never looked for again. A season it never covered (one that had not aired) is 0.
/// </summary>
public static class RequestMarks
{
    /// <summary>Null when the request was never fulfilled (or is a film).</summary>
    public static IReadOnlyDictionary<int, int>? Parse(string? value)
    {
        if (value is null) return null;
        var marks = new Dictionary<int, int>();
        foreach (var part in value.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
            if (part.Split(':') is [var s, var e] && int.TryParse(s, out var season) && int.TryParse(e, out var episode))
                marks[season] = Math.Max(episode, marks.GetValueOrDefault(season));
        return marks;
    }

    public static string Format(IReadOnlyDictionary<int, int> marks) =>
        string.Join(',', marks.OrderBy(m => m.Key).Select(m => $"{m.Key}:{m.Value}"));

    /// <summary>Whether an episode still counts for the request: always without a mark, else only above it.</summary>
    public static bool Counts(IReadOnlyDictionary<int, int>? marks, int season, int episode) =>
        marks is null || episode > marks.GetValueOrDefault(season);

    /// <summary>The mark after a fulfilment: the old one raised to every episode now covered.</summary>
    public static string Advance(string? current, IEnumerable<(int Season, int Episode)> covered)
    {
        var marks = new Dictionary<int, int>(Parse(current) ?? new Dictionary<int, int>());
        foreach (var (season, episode) in covered) marks[season] = Math.Max(episode, marks.GetValueOrDefault(season));
        return Format(marks);
    }
}

/// <summary>
/// The library as files on disk, read from the same ready transfers as the Downloaded rail
/// (<see cref="BrowseService.ReadyTorrentsAsync"/>): which films and which episodes of each work are there. A season is
/// only complete when every aired episode of it is on disk, by the season shape every acquisition path reads
/// (<see cref="ISeasonShapeLookup"/>); without a shape, every episode the queue wants for it.
/// </summary>
public sealed class LibraryOnDisk
{
    private const int MaxShapeSeasons = 30;

    private readonly HashSet<string> _films = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HashSet<(int Season, int Episode)>> _episodes = new(StringComparer.Ordinal);
    private readonly List<ReleaseIdentity> _unmatched = [];
    private readonly Dictionary<string, List<(int? Season, int? Episode, bool Ready)>> _wanted = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Work> _works = new(StringComparer.Ordinal);
    private readonly Dictionary<(string, int), IReadOnlyList<(int Season, int Episode)>?> _shapes = [];
    private readonly HashSet<(string, int)> _airing = [];
    private readonly ISeasonShapeLookup _shapeLookup;
    private HashSet<string> _live = new(StringComparer.Ordinal);

    private LibraryOnDisk(ISeasonShapeLookup shapes) => _shapeLookup = shapes;

    /// <summary>A work as the season shape asks about it.</summary>
    private sealed record Identity(string WorkKey, string Title, int? Year, string? MediaType, string? Provider, string? ProviderId);

    public static async Task<LibraryOnDisk> LoadAsync(TorrentFlowDbContext db, BrowseService browse, ISeasonShapeLookup shapes, CancellationToken ct)
    {
        var library = new LibraryOnDisk(shapes);
        var ready = await browse.ReadyTorrentsAsync(LocalUser.Id, 5000, ct);
        var hashes = ready.Select(t => t.Hash.ToLowerInvariant()).ToHashSet(StringComparer.Ordinal);
        var targets = await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.Status != "failed")
            .Select(t => new { t.WorkKey, t.Scope, t.Season, t.Episode, t.InfoHash }).ToListAsync(ct);
        // Transfers still on their way: a request whose grabs were all removed or failed is not downloading.
        library._live = (await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == LocalUser.Id)
                .Select(t => new { t.Hash, t.Status }).ToListAsync(ct))
            .Where(t => EngineTorrentStatus.IsHealthy(t.Status)).Select(t => t.Hash.ToLowerInvariant()).ToHashSet(StringComparer.Ordinal);
        var workIds = ready.Select(t => t.WorkId).OfType<string>().Distinct().ToList();
        var byId = await db.Works.AsNoTracking().Where(w => workIds.Contains(w.Id)).ToDictionaryAsync(w => w.Id, ct);

        var claimed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var t in targets)
        {
            var isReady = t.InfoHash is { } h && hashes.Contains(h.ToLowerInvariant());
            if (!library._wanted.TryGetValue(t.WorkKey, out var list)) library._wanted[t.WorkKey] = list = [];
            list.Add((t.Season, t.Episode, isReady));
            if (!isReady) continue;
            claimed.Add(t.InfoHash!.ToLowerInvariant());
            if (t.Scope == "episode" && t.Season is { } s && t.Episode is { } e) library.Add(t.WorkKey, (s, e));
            else if (t.Scope == "title") library._films.Add(t.WorkKey);
        }
        foreach (var work in byId.Values) library._works[work.WorkKey] = work;
        foreach (var torrent in ready.Where(t => !claimed.Contains(t.Hash.ToLowerInvariant())))
        {
            var identity = ReleaseNames.WorkIdentity(torrent.Name);
            var work = torrent.WorkId is { } id ? byId.GetValueOrDefault(id) : null;
            if (work == null) { library._unmatched.Add(identity); continue; }
            if (await library.EpisodeOfAsync(work, torrent, ct) is { } episode) library.Add(work.WorkKey, episode);
            else if (!identity.IsSeries) library._films.Add(work.WorkKey);
            else library._unmatched.Add(identity);
        }
        var missing = library._episodes.Keys.Where(k => !library._works.ContainsKey(k)).ToList();
        foreach (var work in await db.Works.AsNoTracking().Where(w => missing.Contains(w.WorkKey)).ToListAsync(ct))
            library._works[work.WorkKey] = work;
        return library;
    }

    private void Add(string key, (int, int) episode)
    {
        if (!_episodes.TryGetValue(key, out var set)) _episodes[key] = set = [];
        set.Add(episode);
    }

    private static Identity Of(Work w) => new(w.WorkKey, w.CanonicalTitle, w.Year, w.MediaType, w.Provider, w.ProviderId);

    /// <summary>
    /// The episode a ready transfer of a work holds: its queue key, else its name's season and episode, else an
    /// absolute number ("Frieren - 29") placed through the season shape's franchise numbering. Null for packs and films.
    /// </summary>
    private async Task<(int, int)?> EpisodeOfAsync(Work work, EngineTorrent torrent, CancellationToken ct)
    {
        if (QueueKeys.Parse(torrent.QueueKey) is { } keyed) return keyed;
        var parsed = ReleaseEpisodeParser.Parse(torrent.Name);
        if (parsed.IsBatch || parsed.IsSeasonPack) return null;
        if (parsed is { Season: { } s, Episode: { } e }) return (s, e);
        if ((parsed.AbsoluteEpisode ?? parsed.Episode) is not { } absolute) return null;
        var identity = Of(work);
        for (var season = 1; season <= MaxShapeSeasons; season++)
        {
            var shape = await ShapeAsync(identity, season, ct);
            if (shape is null) break;
            if (shape.FirstOrDefault(x => x.Absolute == absolute) is { } hit) return (hit.Season, hit.Episode);
        }
        return (await ShapeAsync(identity, 1, ct))?.Any(x => x.Episode == absolute) == true ? (1, absolute) : null;
    }

    private readonly Dictionary<(string, int), IReadOnlyList<SeasonShapeEpisode>?> _fullShapes = [];

    private async Task<IReadOnlyList<SeasonShapeEpisode>?> ShapeAsync(Identity work, int season, CancellationToken ct)
    {
        if (_fullShapes.TryGetValue((work.WorkKey, season), out var cached)) return cached;
        IReadOnlyList<SeasonShapeEpisode>? episodes = null;
        try
        {
            episodes = (await _shapeLookup.GetSeasonAsync(new(work.WorkKey, work.Title, work.Year, work.MediaType, work.Provider,
                work.ProviderId, season), ct))?.Episodes;
        }
        catch (Exception) when (!ct.IsCancellationRequested) { }
        if (episodes is { Count: 0 }) episodes = null;
        _fullShapes[(work.WorkKey, season)] = episodes;
        return episodes;
    }

    /// <summary>Every episode a season needs on disk: its aired episodes, else the ones the queue wants for it.</summary>
    private async Task<IReadOnlyCollection<(int Season, int Episode)>> RequiredAsync(Identity? work, string workKey, int season, CancellationToken ct)
    {
        if (!_shapes.TryGetValue((workKey, season), out var required))
        {
            var shape = work is null ? null : await ShapeAsync(work, season, ct);
            var aired = shape?.Where(e => e.Aired).Select(e => (season, e.Episode)).Distinct().ToList();
            required = aired is { Count: > 0 } ? aired : null;
            if (shape?.Any(e => !e.Aired) == true) _airing.Add((workKey, season));
            _shapes[(workKey, season)] = required;
        }
        if (required != null) return required;
        return (_wanted.GetValueOrDefault(workKey) ?? []).Where(w => w.Season == season && w.Episode != null)
            .Select(w => (season, w.Episode!.Value)).ToHashSet();
    }

    /// <summary>The film's file is on disk (matched by its work, else by its release name like the Downloaded rail).</summary>
    public bool HasFilm(string workKey) =>
        _films.Contains(workKey) || _unmatched.Any(r => !r.IsSeries && TorrentFlow.Core.Text.WorkKeySlug.Matches(workKey, r.Name, r.Year));

    /// <summary>Seasons of this work whose every episode is on disk.</summary>
    public async Task<IReadOnlyList<int>> AvailableSeasonsAsync(string workKey, CancellationToken ct)
    {
        if (!_episodes.TryGetValue(workKey, out var onDisk)) return [];
        var work = _works.TryGetValue(workKey, out var w) ? Of(w) : null;
        var seasons = new List<int>();
        foreach (var season in onDisk.Select(e => e.Season).Distinct().Order())
        {
            var required = await RequiredAsync(work, workKey, season, ct);
            if (required.Count > 0 && required.All(onDisk.Contains)) seasons.Add(season);
        }
        return seasons;
    }

    /// <summary>
    /// The derived state of one request (<see cref="RequestProgress"/>). A season counts every episode it needs; a
    /// season request never counts other seasons, so it never marks the whole show.
    /// </summary>
    public async Task<RequestProgress> ProgressAsync(MediaRequest row, CancellationToken ct)
    {
        var status = row.Status;
        if (status is MediaRequestStatus.Pending or MediaRequestStatus.Declined or MediaRequestStatus.Cancelled) return new(status, 0, 0);
        var started = (row.GrabbedHashes ?? "").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Any(h => _live.Contains(h.ToLowerInvariant()));
        // Fulfilled whose files have since gone reads as approved again (it is wanted, not here).
        if (status == MediaRequestStatus.Fulfilled) status = MediaRequestStatus.Approved;
        if (row.Scope == MediaRequestScope.Movie)
        {
            if (HasFilm(row.WorkKey)) return new(RequestProgress.Available, 1, 1);
            return new(started ? RequestProgress.Downloading : status, 0, 1);
        }
        var onDisk = _episodes.GetValueOrDefault(row.WorkKey) ?? [];
        var asked = RequestRules.ParseSeasons(row.Seasons);
        var seasons = row.Scope == MediaRequestScope.Seasons && asked.Count > 0 ? asked
            : (_wanted.GetValueOrDefault(row.WorkKey) ?? []).Select(w => w.Season).OfType<int>().Concat(onDisk.Select(e => e.Season))
                .Where(s => s >= 1).Distinct().Order().ToList();
        var work = new Identity(row.WorkKey, row.Title, row.Year, row.MediaType, row.Provider, row.ProviderId);
        // A request fulfilled earlier counts what it still owes (episodes above its mark) and what is still here; an
        // episode the owner deleted since is neither, the same set fulfilment judges.
        var marks = RequestMarks.Parse(row.FulfilledThrough);
        var total = 0;
        var done = 0;
        foreach (var season in seasons)
        {
            var required = (await RequiredAsync(work, row.WorkKey, season, ct))
                .Where(e => RequestMarks.Counts(marks, e.Season, e.Episode) || onDisk.Contains(e)).ToList();
            total += required.Count;
            done += required.Count(onDisk.Contains);
        }
        var airing = seasons.Any(s => _airing.Contains((row.WorkKey, s)));
        if (total > 0 && done == total) return new(RequestProgress.Available, done, total, airing);
        if (started || done > 0) return new(RequestProgress.Downloading, done, total, airing);
        return new(status, done, total, airing);
    }
}
