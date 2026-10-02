using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Api.Notifications;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Grabs;

namespace TorrentFlow.Api.Requests;

/// <summary>
/// Connects the wanted queue to requests and notifications: what the queue starts joins every open request for that
/// title, and what still needs the owner after several tries becomes one notification with "Pick a release yourself".
/// </summary>
public sealed class RequestWantedObserver(IDbContextFactory<TorrentFlowDbContext> factory, IServiceProvider services,
    NotificationService notifications) : IWantedObserver
{
    private static readonly string[] Live = [MediaRequestStatus.Approved, MediaRequestStatus.Partial, MediaRequestStatus.Failed];

    // Resolved late: RequestDecisionService -> RequestGrabber -> WantedQueue -> this observer would otherwise be a cycle.
    private RequestDecisionService Decisions => services.GetRequiredService<RequestDecisionService>();

    public async Task<string?> LaneAsync(string workKey, int? season, CancellationToken ct) =>
        (await Covering(workKey, season, [MediaRequestStatus.Approved, MediaRequestStatus.Partial, MediaRequestStatus.Failed], ct)).Count > 0
            ? TorrentLane.Request : null;

    public async Task StartedAsync(string workKey, int? season, IReadOnlyCollection<string> hashes, CancellationToken ct)
    {
        // Every request for the title gets the hashes in one turn, so a Remove never sees the group half attached; once
        // the turn is taken it finishes whole.
        using var held = await HoldAsync(workKey, ct);
        foreach (var id in await Covering(workKey, season, Live, CancellationToken.None))
            await Decisions.AttachStartedAsync(id, hashes, CancellationToken.None);
    }

    public async Task ReplacedAsync(TorrentFlowDbContext db, string workKey, string oldHash, string newHash, CancellationToken ct)
    {
        using var held = await HoldAsync(workKey, ct);
        await ReplaceHashAsync(db, oldHash, newHash, ct);
    }

    public async Task NeedsOwnerAsync(WantedHelp help, CancellationToken ct)
    {
        foreach (var id in await Covering(help.WorkKey, help.Season, [MediaRequestStatus.Approved], ct))
            await Decisions.MarkStillLookingAsync(id, ct);
        await using (var db = await factory.CreateDbContextAsync(ct))
        {
            // One unread note per title and season is enough; the queue keeps looking either way.
            if (await db.Notifications.AnyAsync(n => n.RecipientUserId == LocalUser.Id && n.ReadAt == null && n.Link == help.Link, ct)) return;
        }
        var subject = help.Season is not { } season ? help.Title
            : help.Episodes.Count == 1 ? $"{help.Title} season {season}, episode {help.Episodes[0]}" : $"{help.Title} season {season}";
        var body = help.Failure.Code == GrabFailure.Storage.Code ? $"{help.Failure.Message} {help.Failure.Action}"
            : "We haven't found it yet and will keep looking. You can also pick a release yourself.";
        await notifications.TryPublishAsync(LocalUser.Id, NotificationKind.DownloadFailed, $"Still looking for {subject}", body, help.Link);
    }

    /// <summary>The owner's one note per season download, counts only; later finds change its numbers in place.</summary>
    public Task RunSummaryAsync(WantedRunSummary run, bool create, CancellationToken ct) =>
        notifications.UpsertAsync(LocalUser.Id, NotificationKind.DownloadSummary, run.Summary.Message,
            run.Summary.Action is { Length: > 0 } next ? next : null, run.Link, create, ct);

    /// <summary>
    /// Stop looking for a film, a season or one episode. Transfers the stopped search started and Remove undid
    /// (<paramref name="removed"/>) leave every request naming them, so none waits on a transfer that is gone. Then each
    /// request covering what stopped is settled on its own. One with no transfer left and nothing left in its scope (no
    /// wanted row, no download) is cancelled, so nothing brings it back. Any other stays open and is checked for
    /// fulfilment at once; an approved one with no transfer yet is marked as stopped in part, so the restart sweep doesn't
    /// grab its seasons again and bring back what the owner removed.
    /// </summary>
    public async Task StoppedAsync(string workKey, int? season, int? episode, IReadOnlyCollection<string> removed, CancellationToken ct)
    {
        using var held = await HoldAsync(workKey, ct);
        await using var db = await factory.CreateDbContextAsync(ct);
        foreach (var hash in removed) await ReplaceHashAsync(db, hash, null, ct);
        var ids = await Covering(workKey, season, Live, ct);
        if (ids.Count == 0) return;
        // The seasons (null: the film) that still have a wanted row or a download for this title.
        var left = await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkKey == workKey &&
                (t.Scope == "title" || t.Scope == "episode" && t.Season != null) && (t.Status == "queued" || t.InfoHash != null))
            .Select(t => t.Scope == "title" ? null : t.Season).Distinct().ToListAsync(ct);
        var rows = await db.MediaRequests.AsNoTracking().Where(r => ids.Contains(r.Id))
            .Select(r => new { r.Id, r.Status, r.Scope, r.Seasons, r.GrabbedHashes }).ToListAsync(ct);
        var now = DateTime.UtcNow;
        foreach (var row in rows)
        {
            var empty = string.IsNullOrEmpty(row.GrabbedHashes);
            if (empty && !left.Any(s => Covers(row.Scope, row.Seasons, s)))
            {
                await db.MediaRequests.Where(r => r.Id == row.Id && Live.Contains(r.Status) && (r.GrabbedHashes == null || r.GrabbedHashes == ""))
                    .ExecuteUpdateAsync(u => u.SetProperty(r => r.Status, MediaRequestStatus.Cancelled)
                        .SetProperty(r => r.DecisionReason, StoppedReason).SetProperty(r => r.UpdatedAt, now), ct);
            }
            else if (empty && row.Status == MediaRequestStatus.Approved && row.Scope != MediaRequestScope.Movie)
            {
                await db.MediaRequests.Where(r => r.Id == row.Id && r.Status == MediaRequestStatus.Approved && (r.GrabbedHashes == null || r.GrabbedHashes == ""))
                    .ExecuteUpdateAsync(u => u.SetProperty(r => r.DecisionReason, StoppedPartReason).SetProperty(r => r.UpdatedAt, now), ct);
            }
            else if (!empty) await Decisions.RecheckAsync(row.Id, ct);
        }
    }

    public const string StoppedReason = "The owner stopped looking for this.";
    public const string StoppedPartReason = "The owner stopped looking for some episodes.";

    /// <summary>The owner stopped this request, or part of it: grabbing it again would bring back what he removed.</summary>
    public static bool OwnerStopped(string? reason) => reason is StoppedReason or StoppedPartReason;

    /// <summary>
    /// A transfer requests were waiting on was replaced (a picked release, <paramref name="replacement"/>) or undone
    /// (Remove, null): every request row naming it, siblings included, names the replacement instead or drops it. Saves on
    /// <paramref name="db"/>, so it joins the caller's transaction.
    /// </summary>
    private static async Task ReplaceHashAsync(TorrentFlowDbContext db, string old, string? replacement, CancellationToken ct)
    {
        var needle = old.ToLowerInvariant();
        var next = replacement?.ToLowerInvariant();
        var rows = await db.MediaRequests.Where(r => r.GrabbedHashes != null && r.GrabbedHashes.Contains(needle)).ToListAsync(ct);
        foreach (var row in rows)
        {
            var hashes = row.GrabbedHashes!.Split(',', StringSplitOptions.RemoveEmptyEntries).ToList();
            if (!hashes.Contains(needle)) continue;
            row.GrabbedHashes = string.Join(',', hashes.Select(h => h == needle ? next : h).OfType<string>().Distinct());
            row.UpdatedAt = DateTime.UtcNow;
        }
        await db.SaveChangesAsync(ct);
    }

    /// <summary>One turn per title: attaching what a search started and stopping it never interleave.</summary>
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> Titles = new(StringComparer.Ordinal);

    private static async Task<IDisposable> HoldAsync(string workKey, CancellationToken ct)
    {
        var gate = Titles.GetOrAdd(workKey, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        return new Held(gate);
    }

    private sealed class Held(SemaphoreSlim gate) : IDisposable
    {
        private int done;
        public void Dispose() { if (Interlocked.Exchange(ref done, 1) == 0) gate.Release(); }
    }

    /// <summary>Requests in <paramref name="statuses"/> for this title whose scope includes the season (or the film).</summary>
    private async Task<IReadOnlyList<string>> Covering(string workKey, int? season, string[] statuses, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var rows = await db.MediaRequests.AsNoTracking().Where(r => r.WorkKey == workKey && statuses.Contains(r.Status))
            .Select(r => new { r.Id, r.Scope, r.Seasons }).ToListAsync(ct);
        return rows.Where(r => Covers(r.Scope, r.Seasons, season)).Select(r => r.Id).ToArray();
    }

    /// <summary>Whether a request's scope includes this season (null: the film).</summary>
    private static bool Covers(string scope, string? seasons, int? season) => season == null ? scope == MediaRequestScope.Movie
        : scope != MediaRequestScope.Movie && (scope == MediaRequestScope.Series || RequestRules.ParseSeasons(seasons) is var s && (s.Count == 0 || s.Contains(season.Value)));
}
