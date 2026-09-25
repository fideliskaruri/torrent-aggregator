using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Titles;

public sealed record TitleQuery(string WorkKey, string? Title = null, int? Year = null, string? MediaType = null,
    int? Season = null, int? Remembered = null, MediaMetadata? Provider = null);

public sealed class TitleService(IDbContextFactory<TorrentFlowDbContext> factory, ICatalogLookup catalog, ILibraryArtworkResolver artwork)
{
    private static readonly TimeSpan ArtworkBudget = TimeSpan.FromMilliseconds(1200);

    internal static Dictionary<string, object?> Transfer(AcquisitionTarget target) =>
        LibraryJson.Object(("status", target.Status), ("progress", Math.Clamp(target.Progress, 0, 1)),
            ("infoHash", target.InfoHash), ("filePath", target.FilePath), ("error", target.Error));

    internal static bool FilesAbsent(EngineTorrent row)
    {
        var located = (VerifiedFiles.Read(row.VerifiedFilesJson) ?? []).Select(f => f.Path).OfType<string>().ToList();
        return located.Count > 0 && located.All(VerifiedFiles.ConfirmedMissing);
    }
    internal static void Reconcile(AcquisitionTarget target, EngineTorrent? row)
    {
        target.Progress = Math.Clamp(target.Progress, 0, 1);
        if (target.InfoHash == null) return;
        if (row == null || FilesAbsent(row) || InvalidMedia(row))
        {
            target.Status = "failed"; target.Progress = 0; target.InfoHash = null; target.FilePath = null;
            target.Error = "The requested file is no longer available.";
        }
        else if (row.Status.ToLowerInvariant() is "error" or "missingfiles")
        {
            target.Status = "failed"; target.Progress = 0; target.InfoHash = null; target.FilePath = null;
            target.Error ??= "The downloaded release could not be used. TorrentFlow will choose another release.";
        }
        else
        {
            target.Progress = Math.Clamp(row.Progress, 0, 1);
            // An engine row waiting in the built-in download queue is admitted but not moving (TS 446bff0).
            target.Status = row.Progress >= 1 || row.Status.Equals("seeding", StringComparison.OrdinalIgnoreCase) ? "downloaded" : target.Status == "failed" ? "failed" :
                row.Status.Equals("queued", StringComparison.OrdinalIgnoreCase) ? "queued" : "downloading";
            if (target.Status == "downloaded") target.Progress = 1;
        }
    }
    public async Task<object> Progress(string key, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var targets = await db.AcquisitionTargets.Where(x => x.UserId == LocalUser.Id && x.WorkKey == key && (x.Status == "queued" || x.Status == "downloading")).ToListAsync(ct);
        var hashes = targets.Select(x => x.InfoHash).OfType<string>().ToArray();
        var engines = await db.EngineTorrents.Where(x => x.UserId == LocalUser.Id && x.Status != "removed" && hashes.Contains(x.Hash)).ToListAsync(ct);
        var episodes = new Dictionary<string, object?>();
        var seasons = new Dictionary<string, object?>();
        object? transfer = null;
        foreach (var target in targets)
        {
            Reconcile(target, engines.FirstOrDefault(x => x.Hash.Equals(target.InfoHash, StringComparison.OrdinalIgnoreCase)));
            if (target.Status is not ("queued" or "downloading")) continue;
            if (target.Scope == "title") transfer = Transfer(target);
            else if (target.Scope == "season" && target.Season != null) seasons[target.Season.ToString()!] = Transfer(target);
            else if (target.Season != null && target.Episode != null) episodes[new EpisodeCursor(target.Season.Value, target.Episode.Value).Label] = Transfer(target);
        }
        await db.SaveChangesAsync(ct);
        return LibraryJson.Object(("workKey", key), ("transfer", transfer), ("seasonTransfers", seasons), ("episodeTransfers", episodes), ("generatedAt", LibraryJson.Iso(DateTime.UtcNow)));
    }
    public async Task<Dictionary<string, object?>> Detail(TitleQuery query, CancellationToken ct)
    {
        var key = query.WorkKey.Trim().ToLowerInvariant();
        await using var db = await factory.CreateDbContextAsync(ct);
        var cat = await catalog.FindByWorkKeyAsync(key, ct);
        var watches = await db.WatchListItems.AsNoTracking().Where(x => x.UserId == LocalUser.Id).OrderByDescending(x => x.UpdatedAt).Take(400).ToListAsync(ct);
        var watch = watches.FirstOrDefault(x => ReleaseSelection.MatchesWork(key, x.Title));
        var engineRows = await db.EngineTorrents.AsNoTracking().Where(x => x.UserId == LocalUser.Id && x.Status != "removed").OrderByDescending(x => x.UpdatedAt).Take(400).ToListAsync(ct);
        var targets = await db.AcquisitionTargets.Where(x => x.UserId == LocalUser.Id && x.WorkKey == key).OrderByDescending(x => x.UpdatedAt).Take(400).ToListAsync(ct);
        // TS missingLinkedHashes: a linked torrent older than the scan window is still this work's torrent, not a lost one.
        var scanned = engineRows.Select(x => x.Hash.Trim().ToLowerInvariant()).ToHashSet(StringComparer.Ordinal);
        var missingLinked = targets.Select(x => x.InfoHash?.Trim().ToLowerInvariant()).OfType<string>().Where(x => x.Length > 0 && !scanned.Contains(x)).Distinct().ToArray();
        if (missingLinked.Length > 0)
            engineRows.AddRange(await db.EngineTorrents.AsNoTracking().Where(x => x.UserId == LocalUser.Id && x.Status != "removed" &&
                (missingLinked.Contains(x.Hash) || missingLinked.Contains(x.Hash.ToLower()))).ToListAsync(ct));
        var local = engineRows.Where(x => ReleaseSelection.MatchesWork(key, ReleaseSelection.CleanTitle(x.Name), ReleaseYear(x.Name))).ToList();
        var hashes = local.Select(x => x.Hash).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var progress = (await db.PlaybackProgresses.AsNoTracking().Where(x => x.UserId == LocalUser.Id).OrderByDescending(x => x.UpdatedAt).Take(400).ToListAsync(ct))
            .Where(x => hashes.Contains(x.InfoHash) || watch != null && x.WatchListItemId == watch.Id || ReleaseSelection.MatchesWork(key, x.Title)).ToList();
        foreach (var target in targets) Reconcile(target, engineRows.FirstOrDefault(x => x.Hash.Equals(target.InfoHash, StringComparison.OrdinalIgnoreCase)));
        await db.SaveChangesAsync(ct);
        var title = query.Provider?.Title ?? cat?.Title ?? (query.Title != null && ReleaseSelection.MatchesWork(key, query.Title, query.Year) ? query.Title : null) ??
            watch?.Title ?? (local.FirstOrDefault() is { } first ? ReleaseSelection.CleanTitle(first.Name) : null) ?? progress.FirstOrDefault()?.Title ?? Display(key);
        var type = query.Provider?.MediaType ?? cat?.MediaType ?? query.MediaType ?? watch?.MediaType;
        var year = query.Provider?.Year ?? cat?.Year ?? query.Year;
        var isSeries = type != "movie" && (EpisodeCursor.IsSeries(type) || local.Any(x => EpisodeCursor.Parse(x.Name) != null || PackSeason(x.Name) != null || MultiSeason(x.Name)) || watch?.CursorSeason != null || progress.Any(x => x.Season != null));
        var cached = (await db.CachedMetadata.AsNoTracking().OrderByDescending(x => x.UpdatedAt).Take(200).ToListAsync(ct))
            .FirstOrDefault(x => ReleaseSelection.Normalize(x.Title) == ReleaseSelection.Normalize(title) && (type == null || x.MediaType == type) &&
                (year == null || x.Year == null || (type == "tv" ? x.Year - year < 2 : Math.Abs(x.Year.Value - year.Value) < 2)));
        var poster = query.Provider?.PosterUrl ?? cat?.PosterUrl ?? cached?.PosterUrl ?? progress.FirstOrDefault(x => x.PosterUrl != null)?.PosterUrl;
        var backdrop = query.Provider?.BackdropUrl ?? cat?.BackdropUrl ?? cached?.BackdropUrl;
        if (poster == null && backdrop == null)
        {
            // Nothing local: one budgeted remote attempt (TS ARTWORK_BUDGET_MS). The resolver keeps its own lookup alive to warm its cache.
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(ArtworkBudget);
            try
            {
                var resolved = await artwork.ResolveAsync(title, year, type, budget.Token).WaitAsync(budget.Token);
                poster = resolved.PosterUrl;
                backdrop = resolved.BackdropUrl;
            }
            catch (Exception) when (!ct.IsCancellationRequested) { }
        }
        var overview = query.Provider?.Synopsis ?? cat?.Overview ?? cached?.Synopsis;
        var rating = query.Provider?.Rating ?? cat?.Rating ?? cached?.Rating;
        var release = query.Provider?.ReleaseDate ?? cat?.ReleaseDate ?? (cached?.ReleaseDate is { } date ? LibraryJson.Iso(date) : null);
        var searchRows = await db.SearchCaches.AsNoTracking().OrderByDescending(x => x.CreatedAt).Take(80).ToListAsync(ct);
        SearchResponse? cachedSearch = null;
        foreach (var row in searchRows)
        {
            try
            {
                var data = JsonSerializer.Deserialize<SearchResponse>(row.Payload, new JsonSerializerOptions(JsonSerializerDefaults.Web));
                if (data != null && ReleaseSelection.Normalize(ReleaseSelection.CleanTitle(data.Query)) == ReleaseSelection.Normalize(title)) { cachedSearch = data; break; }
            }
            catch (JsonException) { }
        }
        var releases = cachedSearch?.Results.Where(x => ReleaseSelection.SameWork(x, title, query.Provider?.Aliases ?? [])).ToArray() ?? [];
        var playable = local.Where(x => x.Status is not ("error" or "missingfiles") && !FilesAbsent(x) && !InvalidMedia(x)).OrderByDescending(x => x.Progress).ToList();
        var best = playable.FirstOrDefault(x => x.Progress > 0);
        string? State(EngineTorrent? row) => row == null ? null : row.Progress >= 1 ? "ready" : row.Progress > 0 ? "warm" : null;
        double? Fraction(EngineTorrent? row) => row != null && row.Origin is not ("stream" or "prewarm") && row.Progress > 0 && row.Progress < 1 ? row.Progress : null;
        var availability = State(best) ?? (releases.Any(x => x.Seeders >= 3) ? "fetchable" : cachedSearch != null ? "unavailable" : null);
        var resumeRow = progress.FirstOrDefault(x => x.CompletedAt == null && x.PositionSec > 0 && playable.Any(l => l.Hash == x.InfoHash));
        object? resume = resumeRow == null ? null : LibraryJson.Object(("infoHash", resumeRow.InfoHash), ("filePath", resumeRow.FilePath),
            ("positionSec", resumeRow.PositionSec), ("durationSec", resumeRow.DurationSec), ("fraction", resumeRow.DurationSec > 0 ? resumeRow.PositionSec / resumeRow.DurationSec : null),
            ("season", resumeRow.Season), ("episode", resumeRow.Episode), ("label", resumeRow.Season != null && resumeRow.Episode != null ? new EpisodeCursor(resumeRow.Season.Value, resumeRow.Episode.Value).Label : null));
        var knownCoordinates = local.Select(x => EpisodeCursor.Parse(x.Name)).Concat(releases.Select(x => EpisodeCursor.Parse(x.Title)))
            .Concat(progress.Where(x => x.Season != null && x.Episode != null).Select(x => (EpisodeCursor?)new EpisodeCursor(x.Season!.Value, x.Episode!.Value)))
            .OfType<EpisodeCursor>().ToArray();
        var coordinates = knownCoordinates.Select(x => (EpisodeCursor?)x).Concat(targets.Where(x => x.Season != null && x.Episode != null).Select(x => (EpisodeCursor?)new EpisodeCursor(x.Season!.Value, x.Episode!.Value)))
            .Concat(watch?.CursorSeason != null && watch.CursorEpisode != null ? [new EpisodeCursor(watch.CursorSeason.Value, watch.CursorEpisode.Value)] : []).OfType<EpisodeCursor>().ToArray();
        var seasonNumbers = isSeries ? coordinates.Select(x => x.Season)
            .Concat(local.Select(x => PackSeason(x.Name)).Concat(releases.Select(x => PackSeason(x.Title))).OfType<int>())
            .Concat(targets.Where(x => x.Season != null).Select(x => x.Season!.Value)).Distinct().Order().ToArray() : [];
        int? selected = isSeries && seasonNumbers.Length > 0 ? query.Season ?? query.Remembered ?? resumeRow?.Season ?? progress.FirstOrDefault()?.Season ?? watch?.CursorSeason ?? seasonNumbers[0] : null;
        var seasons = seasonNumbers.Select(s =>
        {
            var pack = playable.FirstOrDefault(x => PackSeason(x.Name) == s && x.Progress > 0);
            return LibraryJson.Object(("season", s), ("knownEpisodes", knownCoordinates.Where(c => c.Season == s).Select(c => c.Episode).Distinct().Count()),
                ("pack", pack == null ? null : LibraryJson.Object(("name", pack.Name), ("availability", State(pack)), ("infoHash", pack.Hash), ("downloadFraction", Fraction(pack)))),
                ("transfer", targets.FirstOrDefault(t => t.Scope == "season" && t.Season == s) is { } target ? Transfer(target) : null));
        }).ToList();
        var coverage = selected is { } selectedSeason ? PackCoverage(playable, selectedSeason) : [];
        var maxEpisode = coordinates.Where(x => x.Season == selected).Select(x => x.Episode).Concat(coverage.Keys).DefaultIfEmpty(0).Max();
        var episodes = new List<object>();
        for (var ep = 1; ep <= Math.Min(200, maxEpisode); ep++)
        {
            var cursor = new EpisodeCursor(selected!.Value, ep);
            var p = progress.FirstOrDefault(x => x.Season == cursor.Season && x.Episode == ep);
            var t = targets.FirstOrDefault(x => x.Scope == "episode" && x.Season == cursor.Season && x.Episode == ep);
            var linkedHash = t?.InfoHash ?? p?.InfoHash;
            var row = linkedHash != null ? playable.FirstOrDefault(x => x.Hash.Equals(linkedHash, StringComparison.OrdinalIgnoreCase)) :
                playable.FirstOrDefault(x => EpisodeCursor.Parse(x.Name) == cursor && x.Progress > 0);
            var state = t?.Status == "downloaded" ? "ready" : t?.Status == "downloading" && t.Progress > 0 ? "warm" :
                State(row) ?? (releases.Any(x => x.Seeders >= 3 && (ReleaseSelection.ExactEpisode(x, cursor) || PackSeason(x.Title) == cursor.Season)) ? "fetchable" : null);
            var hash = t?.InfoHash ?? row?.Hash;
            var file = t?.FilePath ?? (hash != null && p?.InfoHash == hash ? p?.FilePath : null);
            var fromPack = t?.InfoHash != null && row != null && (PackSeason(row.Name) != null || MultiSeason(row.Name));
            if (state != "ready" && coverage.TryGetValue(ep, out var cover))
            {
                state = State(cover.Row); hash = cover.Row.Hash; file = cover.Path; fromPack = true;
            }
            object? transfer = t == null ? null : Transfer(t);
            double? fraction = t?.Status == "downloading" ? t.Progress : Fraction(row);
            if (t == null)
            {
                var downloading = row?.Progress > 0 && row.Progress < 1 && row.Origin is not ("stream" or "prewarm") ? row :
                    row == null ? playable.FirstOrDefault(x => EpisodeCursor.Parse(x.Name) == cursor && x.Progress < 1 && x.Origin is not ("stream" or "prewarm")) : null;
                if (downloading != null)
                {
                    transfer = LibraryJson.Object(("status", "downloading"), ("progress", downloading.Progress), ("infoHash", downloading.Hash), ("filePath", null), ("error", null));
                    hash = downloading.Hash; fraction = downloading.Progress;
                    if (downloading.Progress > 0) state = "warm";
                }
            }
            episodes.Add(LibraryJson.Object(("season", cursor.Season), ("episode", ep), ("label", cursor.Label),
                ("availability", state), ("infoHash", hash), ("filePath", file), ("downloadFraction", fraction),
                ("watchedFraction", p?.DurationSec > 0 ? Math.Min(1, p.PositionSec / p.DurationSec.Value) : null),
                ("resumePositionSec", hash != null && p?.InfoHash == hash && p?.CompletedAt == null ? p?.PositionSec : null), ("watched", p?.CompletedAt != null),
                ("nextUp", watch?.CursorSeason == cursor.Season && watch?.CursorEpisode == ep), ("fromPack", fromPack), ("transfer", transfer)));
        }
        var library = LibraryJson.Object(("inLibrary", watch != null), ("watchListItemId", watch?.Id), ("monitored", watch?.Monitored ?? false),
            ("status", watch?.Status), ("cursorSeason", watch?.CursorSeason), ("cursorEpisode", watch?.CursorEpisode),
            ("addPayload", LibraryJson.Object(("mediaType", type ?? (isSeries ? "tv" : "movie")), ("externalId", query.Provider?.ExternalId ?? cached?.ExternalId ?? $"work:{key}"),
                ("title", title), ("posterUrl", poster), ("synopsis", overview), ("rating", rating))));
        return LibraryJson.Object(("workKey", key), ("title", title), ("aliases", query.Provider?.Aliases?.Where(x => !x.Equals(title, StringComparison.OrdinalIgnoreCase)).ToArray() ?? []),
            ("year", year), ("mediaType", type), ("isSeries", isSeries), ("overview", overview), ("rating", rating), ("posterUrl", poster), ("backdropUrl", backdrop),
            ("releaseDate", release), ("availability", availability), ("infoHash", best?.Hash), ("downloadFraction", Fraction(best)), ("resume", resume),
            ("transfer", targets.FirstOrDefault(x => x.Scope == "title") is { } tt ? Transfer(tt) : null),
            ("seasons", seasons), ("season", selected), ("episodes", episodes), ("episodesTruncated", maxEpisode > 200),
            ("library", library), ("known", cat != null || query.Provider != null || watch != null || local.Count > 0 || progress.Count > 0 || releases.Length > 0 || cached != null),
            ("generatedAt", LibraryJson.Iso(DateTime.UtcNow)));
    }
    private static bool MultiSeason(string name) => Regex.IsMatch(name, @"(?i)\bS\d+\s*[-–]\s*S?\d+\b|\bcomplete\s+(?:series|collection)\b");
    private static bool InvalidMedia(EngineTorrent row)
    {
        if (row.Progress < .9999 || string.IsNullOrWhiteSpace(row.VerifiedBitfield)) return false;
        var paths = (VerifiedFiles.Read(row.VerifiedFilesJson) ?? []).Select(x => x.Name).OfType<string>().ToArray();
        return paths.Length > 0 && !paths.Any(x => Regex.IsMatch(x, @"(?i)\.(?:mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg|vob)$"));
    }
    private static int? PackSeason(string name)
    {
        if (EpisodeCursor.Parse(name) != null || MultiSeason(name)) return null;
        var match = Regex.Match(name, @"(?i)\b(?:S|Season[ ._-]+)(\d{1,3})\b");
        return match.Success ? int.Parse(match.Groups[1].Value) : null;
    }
    private static Dictionary<int, (EngineTorrent Row, string Path)> PackCoverage(IEnumerable<EngineTorrent> rows, int season)
    {
        var result = new Dictionary<int, (EngineTorrent, string)>();
        foreach (var row in rows.Where(x => PackSeason(x.Name) == season || MultiSeason(x.Name))
            .OrderBy(x => MultiSeason(x.Name)).ThenByDescending(x => x.Progress))
        {
            if (row.Progress < .9999 || string.IsNullOrWhiteSpace(row.VerifiedBitfield)) continue;
            var best = new Dictionary<int, (string Path, long Size)>();
            foreach (var file in VerifiedFiles.Read(row.VerifiedFilesJson) ?? [])
            {
                if (file.Path is not { } path || !Regex.IsMatch(path, @"(?i)\.(?:mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg|vob)$")) continue;
                if (path.Split(['\\', '/']).Any(part => Regex.IsMatch(Regex.Replace(part, "[._-]", " "), @"(?i)\b(?:featurettes?|extras?|specials?|samples?|behind the scenes|animatics?)\b"))) continue;
                var fileName = path.Split(['\\', '/'])[^1];
                if (EpisodeCursor.Parse(fileName) is not { } coordinate || coordinate.Season != season ||
                    Regex.IsMatch(fileName, @"(?i)E\d+\s*(?:-E?|E)\d+")) continue;
                var size = Math.Max(0, file.Size);
                if (!best.TryGetValue(coordinate.Episode, out var current) || size > current.Size) best[coordinate.Episode] = (path, size);
            }
            foreach (var (episode, file) in best) result.TryAdd(episode, (row, file.Path));
        }
        return result;
    }
    private static int? ReleaseYear(string name)
    {
        if (EpisodeCursor.Parse(name) != null) return null;
        var m = System.Text.RegularExpressions.Regex.Match(name, @"\b((?:19|20)\d{2})\b");
        return m.Success ? int.Parse(m.Groups[1].Value) : null;
    }
    private static string Display(string key)
    {
        string[] minor = ["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to"];
        return string.Join(' ', System.Text.RegularExpressions.Regex.Split(Uri.UnescapeDataString(key).Trim(), @"[-_\s]+")
            .Select((x, i) => i > 0 && minor.Contains(x.ToLowerInvariant()) ? x.ToLowerInvariant() : x.Length > 0 ? char.ToUpperInvariant(x[0]) + x[1..] : x));
    }
}
