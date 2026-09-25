using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Storage;

public sealed record DeletionScope(string Kind, int? Season = null, int? Episode = null);
public sealed record DeletionRelease(string Hash, string Name, int FileCount, long Bytes, bool FilesRecorded);
public sealed record BlockedRelease(string Name, string Reason, string Covers, int FileCount, long Bytes);
public sealed record DeletionPlan(DeletionScope Scope, IReadOnlyList<DeletionRelease> Releases, IReadOnlyList<BlockedRelease> Blocked, int MissingFileCount)
{
    public string Outcome => Releases.Count > 0 ? "deletes" : Blocked.Count > 0 ? "blocked" : "nothing-held";
    public int FileCount => Releases.Sum(x => x.FileCount);
    public long TotalBytes => Releases.Sum(x => x.Bytes);
    public string Subject => Scope.Kind == "show" ? "this title" : Scope.Kind == "season" ? $"Season {Scope.Season}" : new EpisodeCursor(Scope.Season!.Value, Scope.Episode!.Value).Label;
    public string Summary
    {
        get
        {
            static string Count(int n, string noun) => $"{n} {noun}{(n == 1 ? "" : "s")}";
            if (Outcome == "nothing-held") return $"No files held for {Subject}. Nothing to delete.";
            if (Outcome == "blocked")
            {
                var first = Blocked[0];
                var head = first.Reason == "covers-more" ? $"Nothing can be deleted for {Subject}: {Count(Blocked.Count, "release")} cover{(Blocked.Count == 1 ? "s" : "")} {first.Covers}, not just {Subject}." :
                    $"Nothing can be deleted for {Subject}: {Count(Blocked.Count, "release")} could not be matched to a season.";
                return head + $" {Count(Blocked.Sum(x => x.FileCount), "file")} · {BackfillController.Format(Blocked.Sum(x => x.Bytes))} left in place." +
                    (Scope.Kind == "episode" ? $" A single episode cannot be removed from a pack — delete Season {Scope.Season} to remove it." : " Delete the whole title to remove it.");
            }
            var summary = $"Deletes {Count(FileCount > 0 ? FileCount : Releases.Count, FileCount > 0 ? "file" : "release")} · {BackfillController.Format(TotalBytes)} from {Subject}.";
            var unlisted = Releases.Count(x => !x.FilesRecorded);
            if (unlisted > 0) summary += $" {Count(unlisted, "release")} with no recorded file list; the size shown is the full allocation.";
            if (MissingFileCount > 0) summary += $" {Count(MissingFileCount, "recorded file")} already gone from disk, so not counted.";
            if (Blocked.Count > 0) summary += $" {Count(Blocked.Count, "release")} left alone: {Blocked[0].Name} covers {Blocked[0].Covers}.";
            return summary;
        }
    }
    public object Json() => new { scope = Scope, outcome = Outcome, fileCount = FileCount, totalBytes = TotalBytes, missingFileCount = MissingFileCount,
        releases = Releases.Select(x => new { x.Name, x.FileCount, x.Bytes, x.FilesRecorded }), blocked = Blocked, summary = Summary };
}

[ApiController, Route("api/library/delete"), ServiceFilter(typeof(LibraryExceptionFilter))]
public sealed class DeletionController(IDbContextFactory<TorrentFlowDbContext> factory, ITorrentEngine engine) : ControllerBase
{
    internal static DeletionPlan Plan(IEnumerable<EngineTorrent> rows, DeletionScope scope)
    {
        var releases = new List<DeletionRelease>();
        var blocked = new List<BlockedRelease>();
        var missing = 0;
        foreach (var row in rows)
        {
            var files = new List<(string Path, long Size)>();
            try
            {
                using var doc = JsonDocument.Parse(row.VerifiedFilesJson ?? "[]");
                foreach (var f in doc.RootElement.EnumerateArray())
                    files.Add((f.GetProperty("path").GetString()!, f.GetProperty("size").GetInt64()));
            }
            catch (Exception) { files.Clear(); }
            var present = files.Where(f => !ConfirmedMissing(f.Path)).ToList();
            var bytes = files.Count > 0 ? present.Sum(x => x.Size) : row.SizeBytes;
            var cursor = EpisodeCursor.Parse(row.Name);
            var seasonMatch = Regex.Match(row.Name, @"(?i)\bS(\d{1,3})\b");
            int? statedSeason = cursor?.Season ?? (seasonMatch.Success ? int.Parse(seasonMatch.Groups[1].Value) : null);
            var multiseason = Regex.IsMatch(row.Name, @"(?i)\b(?:complete|S\d+\s*[-–]\s*S?\d+)\b");
            var multiEpisode = Regex.IsMatch(row.Name, @"(?i)E\d+\s*(?:-E?|E)\d+");
            var allInside = scope.Kind == "show" || !multiseason && statedSeason == scope.Season &&
                (scope.Kind == "season" || !multiEpisode && cursor?.Episode == scope.Episode);
            // A release's name cannot authorize deleting recorded files outside the requested coordinates.
            if (scope.Kind != "show" && files.Any(x => EpisodeCursor.Parse(Path.GetFileName(x.Path)) is { } c &&
                (c.Season != scope.Season || scope.Kind == "episode" && c.Episode != scope.Episode))) allInside = false;
            if (allInside)
            {
                missing += files.Count - present.Count;
                releases.Add(new(row.Hash, row.Name, present.Count, bytes, files.Count > 0));
            }
            else if (statedSeason == null || multiseason || statedSeason == scope.Season)
            {
                blocked.Add(new(row.Name, statedSeason == null && !multiseason ? "unrecognised" : "covers-more",
                    multiseason ? $"Seasons {statedSeason ?? 1} onwards" : cursor?.Label ?? (statedSeason != null ? $"Season {statedSeason}" : "unknown coverage"), present.Count, bytes));
            }
        }
        return new(scope, releases, blocked, missing);
    }
    private static bool ConfirmedMissing(string path)
    {
        try { _ = System.IO.File.GetAttributes(path); return false; }
        catch (FileNotFoundException) { return true; }
        catch (DirectoryNotFoundException) { return true; }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
        catch (ArgumentException) { return false; }
    }
    [HttpGet, HttpPost]
    public async Task<IActionResult> Handle(CancellationToken ct)
    {
        var mutate = Request.Method == "POST";
        Fields f;
        if (mutate) f = await Fields.Read(Request, ct);
        else
        {
            var values = Request.Query.ToDictionary(x => x.Key, x => (object?)x.Value.ToString());
            foreach (var key in new[] { "season", "episode" })
                if (values.TryGetValue(key, out var value) && int.TryParse(value as string, out var n)) values[key] = n;
            f = new(JsonSerializer.SerializeToElement(values));
        }
        var id = f.String("watchListItemId", true, 128);
        var kind = f.Enum("scope", ["show", "season", "episode"], true)!;
        var season = f.Int("season", 10000);
        var episode = f.Int("episode");
        if (mutate && f.Bool("confirm") != true)
            return BadRequest(new { ok = false, error = "Confirmation required", message = "Deleting files needs `confirm: true`. Ask for the plan with GET first and show the file count and size.", reason = "unconfirmed" });
        if (kind != "show" && (season == null || kind == "episode" && episode == null))
            return BadRequest(new { ok = false, error = "Invalid scope", message = "A season scope needs `season`, and an episode scope needs `season` and `episode`.", reason = "bad-scope" });
        await using var db = await factory.CreateDbContextAsync(ct);
        var item = await db.WatchListItems.FirstOrDefaultAsync(x => x.Id == id && x.UserId == LocalUser.Id, ct);
        if (item == null) return NotFound(new { error = "Not found" });
        var rows = await db.EngineTorrents.Where(x => x.UserId == LocalUser.Id && x.Status != "removed").Take(500).ToListAsync(ct);
        var plan = Plan(rows.Where(x => ReleaseSelection.Normalize(ReleaseSelection.CleanTitle(x.Name)) == ReleaseSelection.Normalize(item.Title)),
            new(kind, kind == "show" ? null : season, kind == "episode" ? episode : null));
        if (!mutate) return Ok(new { ok = true, title = item.Title, plan = plan.Json() });
        if (plan.Outcome != "deletes")
            return Conflict(new { ok = false, error = plan.Outcome == "blocked" ? "Refused" : "Nothing to delete", message = plan.Summary, reason = plan.Outcome, plan = plan.Json() });
        var deleted = new List<object>();
        var failed = new List<object>();
        long freedBytes = 0; var freedFiles = 0;
        foreach (var release in plan.Releases)
        {
            EngineActionResult result;
            try { result = await engine.RemoveAsync(release.Hash, true, ct); }
            catch (Exception error) when (!ct.IsCancellationRequested) { result = new(false, error.Message); }
            if (!result.Ok) { failed.Add(new { name = release.Name, message = result.Message }); continue; }
            await db.EngineTorrents.Where(x => x.UserId == LocalUser.Id && x.Hash == release.Hash).ExecuteDeleteAsync(ct);
            deleted.Add(new { name = release.Name, bytes = release.Bytes, fileCount = release.FileCount });
            freedBytes += release.Bytes; freedFiles += release.FileCount;
        }
        return Ok(new { ok = failed.Count == 0, freedBytes, freedFiles, deleted, failed, plan = plan.Json() });
    }
}
