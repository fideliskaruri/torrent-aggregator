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
        foreach (var id in await Covering(workKey, season, Live, ct))
            await Decisions.AttachStartedAsync(id, hashes, ct);
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

    /// <summary>Requests in <paramref name="statuses"/> for this title whose scope includes the season (or the film).</summary>
    private async Task<IReadOnlyList<string>> Covering(string workKey, int? season, string[] statuses, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var rows = await db.MediaRequests.AsNoTracking().Where(r => r.WorkKey == workKey && statuses.Contains(r.Status))
            .Select(r => new { r.Id, r.Scope, r.Seasons }).ToListAsync(ct);
        return rows.Where(r => season == null ? r.Scope == MediaRequestScope.Movie
                : r.Scope == MediaRequestScope.Series || RequestRules.ParseSeasons(r.Seasons) is var s && (s.Count == 0 || s.Contains(season.Value)))
            .Select(r => r.Id).ToArray();
    }
}
