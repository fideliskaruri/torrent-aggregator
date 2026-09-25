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
    /// <summary>What a release or file name claims to hold (TS coverageFromName, via the shared episode parser).</summary>
    internal readonly record struct Coverage(string Kind, int? Season = null, int? Episode = null, int From = 1)
    {
        public static Coverage FromName(string name)
        {
            var raw = (name ?? "").Trim();
            if (raw.Length == 0) return new("unknown");
            var ep = ReleaseNames.ParseEpisode(raw);
            if (ep.IsMultiSeason == true) return new("seasons", From: ep.Season ?? 1);
            if (ep.IsSeasonPack || ep.IsBatch) return ep.Season is { } s ? new("season", s) : new("seasons", From: 1);
            // Stricter than TS (which reads "S01E01-E03" as E01 alone): a range holds several episodes, so it is season-wide here.
            if (ep.Episode != null && ReleaseNames.IsEpisodeRangeRelease(raw)) return ep.Season is { } rs ? new("season", rs) : new("seasons", From: 1);
            if (ep.Episode is { } e) return new("episode", ep.Season, e);
            return new("unknown");
        }
        /// <summary>TS coverageWithin: false generously — every wrong true costs the user files.</summary>
        public bool Within(DeletionScope scope) => scope.Kind switch
        {
            "show" => true,
            "season" => Kind is "episode" or "season" && Season == scope.Season,
            _ => Kind == "episode" && Season == scope.Season && Episode == scope.Episode,
        };
        /// <summary>TS coverageOverlaps: only overlapping material is worth reporting as blocked.</summary>
        public bool Overlaps(DeletionScope scope)
        {
            if (scope.Kind == "show" || Kind == "unknown") return true;
            if (scope.Kind == "season")
                return Kind switch { "episode" => Season == null || Season == scope.Season, "season" => Season == scope.Season, _ => scope.Season >= From };
            return Kind switch
            {
                "episode" => Episode == scope.Episode && (Season == null || Season == scope.Season),
                "season" => Season == scope.Season,
                _ => scope.Season >= From,
            };
        }
        public string Label => Kind switch
        {
            "episode" => Season == null ? $"episode {Episode}" : $"S{Season:00}E{Episode:00}",
            "season" => $"Season {Season}",
            "seasons" => $"Season {From} and later",
            _ => "not stated",
        };
        public int Rank => Kind == "seasons" ? 3 : Kind == "season" ? 2 : 1;
    }


    /// <summary>Port of TS planDeletion: the release name and every recorded file name both vote on coverage.</summary>
    internal static DeletionPlan Plan(IEnumerable<EngineTorrent> rows, DeletionScope scope)
    {
        var releases = new List<DeletionRelease>();
        var blocked = new List<BlockedRelease>();
        var missing = 0;
        foreach (var row in rows)
        {
            var entries = VerifiedFiles.Read(row.VerifiedFilesJson) ?? [];
            // Only files with an on-disk location count toward bytes and presence; a duplicate the layout discarded has none.
            var files = entries.Where(f => !string.IsNullOrWhiteSpace(f.Path))
                .Select(f => (Path: f.Path!.Trim(), Size: Math.Max(0, f.Size))).ToList();
            var present = files.Where(f => !VerifiedFiles.ConfirmedMissing(f.Path)).ToList();
            var bytes = files.Count > 0 ? present.Sum(x => x.Size) : Math.Max(0, row.SizeBytes);
            // Unknown names (sample.mkv, poster.jpg) state nothing and must not block an episode delete.
            var stated = entries.Select(f => f.Name).OfType<string>().Select(Coverage.FromName).Prepend(Coverage.FromName(row.Name))
                .Where(c => c.Kind != "unknown").ToList();
            if (stated.Count == 0 && scope.Kind != "show")
            {
                blocked.Add(new(row.Name, "unrecognised", "not stated", present.Count, bytes));
                continue;
            }
            if (stated.All(c => c.Within(scope)))
            {
                missing += files.Count - present.Count;
                releases.Add(new(row.Hash, row.Name, present.Count, bytes, files.Count > 0));
                continue;
            }
            if (stated.Any(c => c.Overlaps(scope)))
            {
                var wider = stated.Any(c => c.Kind is "season" or "seasons" || c.Kind == "episode" && c.Season != null);
                blocked.Add(new(row.Name, wider ? "covers-more" : "unrecognised", stated.OrderByDescending(c => c.Rank).First().Label, present.Count, bytes));
            }
        }
        return new(scope, releases, blocked, missing);
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
