using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Api.Notifications;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Grabs;

namespace TorrentFlow.Api.Requests;

public enum DecisionOutcome { Done, NotFound, NotPending }

/// <summary>Whether a grabbed transfer has finished; a seam so tests need no real torrents.</summary>
public interface IRequestTransfers
{
    Task<bool> CompletedAsync(string hash, CancellationToken ct);
}

public sealed class EngineRequestTransfers(ITorrentEngine engine) : IRequestTransfers
{
    /// <summary>Done the one way the engine counts it: promoted into the library (<see cref="EngineTorrentInfo.IsDownloaded"/>).</summary>
    public async Task<bool> CompletedAsync(string hash, CancellationToken ct) =>
        await engine.GetAsync(hash, ct) is { IsDownloaded: true };
}

/// <summary>
/// The owner's approve/decline, the request-lane grab an approval starts, and the move to fulfilled once every
/// transfer it started has completed.
/// </summary>
public sealed class RequestDecisionService(
    IDbContextFactory<TorrentFlowDbContext> factory,
    IRequestGrabber grabber,
    IRequestTransfers transfers,
    IHostApplicationLifetime lifetime,
    TimeProvider time,
    ILogger<RequestDecisionService> logger,
    NotificationService notifications)
{
    public const int MaxReasonLength = 500;
    /// <summary>What a requester reads when nothing could be started; the indexer detail stays in the owner's log.</summary>
    public const string NoDownloadReason = "We couldn't find a download for this yet. We'll keep looking, and the owner can also pick one by hand.";
    public const string PartialReason = "Some episodes started. We're still looking for the rest.";
    public const string StoppedReason = "The download stopped. The owner can retry it or pick another release.";
    public const string PartStoppedReason = "Part of the download stopped. The owner can retry it or pick another release.";
    /// <summary>An approved season that has not aired yet; the airing check queues it once it does.</summary>
    public const string WaitingReason = "Downloads when it airs.";
    /// <summary>The owner removed everything the request had: not a stop (nobody is told), but Retry and Pick stay offered.</summary>
    public const string RemovedReason = "The download was removed. The owner can retry it or pick another release.";
    /// <summary>The owner removed some episodes before they were all here: partial, quietly, with Retry and Pick.</summary>
    public const string PartRemovedReason = "Some episodes were removed. The owner can retry them or pick another release.";
    /// <summary>A fulfilled season request is checked for newly aired episodes for this long after it was last touched.</summary>
    private static readonly TimeSpan AiringWindow = TimeSpan.FromDays(365);

    /// <summary>The last grab an approval started; tests await it.</summary>
    internal Task LastGrab { get; private set; } = Task.CompletedTask;
    private readonly ConcurrentDictionary<string, byte> activeGrabs = new(StringComparer.Ordinal);

    public async Task<(DecisionOutcome Outcome, string? Status)> RetryAsync(string id, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var row = await db.MediaRequests.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id, ct);
        if (row is null) return (DecisionOutcome.NotFound, null);
        if (row.Status is not (MediaRequestStatus.Partial or MediaRequestStatus.Failed))
            return (DecisionOutcome.NotPending, row.Status);
        if (!activeGrabs.TryAdd(id, 0)) return (DecisionOutcome.Done, row.Status);
        // A request that stopped waiting because the owner removed part of it looks for those again; after a stop, only
        // the stopped ones: what the owner removed stays removed.
        var removed = row.DecisionReason is RemovedReason or PartRemovedReason;
        try
        {
            // Everyone waiting on the same ask lets go of the same dead transfers, so no sibling stays stuck on them.
            foreach (var waiting in await RetryRowsAsync(db, row, ct)) await DropDeadAsync(db, waiting, removed, ct);
        }
        catch { activeGrabs.TryRemove(id, out _); throw; }
        LastGrab = Task.Run(async () =>
        {
            try { await GrabCoreAsync(id, lifetime.ApplicationStopping, retry: true, removed); }
            finally { activeGrabs.TryRemove(id, out _); }
        }, CancellationToken.None);
        return (DecisionOutcome.Done, row.Status);
    }

    public async Task<(DecisionOutcome Outcome, string? Status)> ApproveAsync(string id, CancellationToken ct, string? decisionReason = null)
    {
        var (outcome, status, claimed, grab) = await DecideAsync(id, MediaRequestStatus.Approved, decisionReason, ct);
        if (outcome != DecisionOutcome.Done) return (outcome, status);
        foreach (var row in claimed)
            await notifications.TryPublishAsync(row.RequestedByUserId, NotificationKind.RequestApproved, "Request approved", row.Title, "/requests");
        if (grab is { } leadId) LastGrab = Task.Run(() => GrabAsync(leadId, lifetime.ApplicationStopping), CancellationToken.None);
        return (outcome, status);
    }

    public async Task<(DecisionOutcome Outcome, string? Status)> DeclineAsync(string id, string? reason, CancellationToken ct)
    {
        var (outcome, status, claimed, _) = await DecideAsync(id, MediaRequestStatus.Declined, reason, ct);
        if (outcome != DecisionOutcome.Done) return (outcome, status);
        foreach (var row in claimed)
            await notifications.TryPublishAsync(row.RequestedByUserId, NotificationKind.RequestDeclined, "Request declined",
                row.DecisionReason is { } reasonText ? $"{row.Title}: {reasonText}" : row.Title, "/requests");
        return (outcome, status);
    }

    /// <summary>
    /// Decides a whole shared ask at once (<see cref="RequestRules.SameAskKey"/>): every pending row for the same title and
    /// scope takes the decision in one transaction, behind <see cref="RequestRules.AskGate"/>, so racing approvals and
    /// declines leave one outcome. An approval elects one row to grab (the oldest), unless the ask is already downloading
    /// for an earlier approved row, whose transfers the claimed rows then share.
    /// </summary>
    private async Task<(DecisionOutcome Outcome, string? Status, List<MediaRequest> Claimed, string? Grab)> DecideAsync(string id, string status,
        string? reason, CancellationToken ct)
    {
        await RequestRules.AskGate.WaitAsync(ct);
        try
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            var row = await db.MediaRequests.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id, ct);
            if (row is null) return (DecisionOutcome.NotFound, null, [], null);
            if (row.Status != MediaRequestStatus.Pending) return (DecisionOutcome.NotPending, row.Status, [], null);
            var key = RequestRules.SameAskKey(row);
            var ask = (await db.MediaRequests.AsNoTracking().Where(r => r.WorkKey == row.WorkKey).ToListAsync(ct))
                .Where(r => RequestRules.SameAskKey(r) == key).ToList();
            var claimed = ask.Where(r => r.Status == MediaRequestStatus.Pending).OrderBy(r => r.CreatedAt).ToList();
            var ids = claimed.Select(r => r.Id).ToList();
            var now = time.GetUtcNow().UtcDateTime;
            var note = string.IsNullOrWhiteSpace(reason) ? null : reason.Trim();
            var running = status == MediaRequestStatus.Approved
                ? ask.Where(r => r.Status is MediaRequestStatus.Approved or MediaRequestStatus.Partial).OrderBy(r => r.CreatedAt).FirstOrDefault()
                : null;
            var hashes = running?.GrabbedHashes;
            var mark = running?.FulfilledThrough;
            var covered = running?.CoveredThrough;
            // The stopped transfers the running row already announced come along, so the newcomers are not told again.
            var told = running?.StoppedKey;
            var changed = await db.MediaRequests.Where(r => ids.Contains(r.Id) && r.Status == MediaRequestStatus.Pending)
                .ExecuteUpdateAsync(u => u.SetProperty(r => r.Status, status).SetProperty(r => r.DecisionReason, note)
                    .SetProperty(r => r.DecidedAt, now).SetProperty(r => r.UpdatedAt, now)
                    .SetProperty(r => r.GrabbedHashes, r => hashes ?? r.GrabbedHashes)
                    .SetProperty(r => r.FulfilledThrough, r => mark ?? r.FulfilledThrough)
                    .SetProperty(r => r.CoveredThrough, r => covered ?? r.CoveredThrough)
                    .SetProperty(r => r.StoppedKey, r => told ?? r.StoppedKey), ct);
            if (changed != ids.Count)
            {
                await tx.RollbackAsync(CancellationToken.None);
                return (DecisionOutcome.NotPending, await db.MediaRequests.Where(r => r.Id == id).Select(r => r.Status).FirstOrDefaultAsync(ct), [], null);
            }
            await tx.CommitAsync(ct);
            foreach (var r in claimed) { r.Status = status; r.DecisionReason = note; r.DecidedAt = now; r.UpdatedAt = now; }
            return (DecisionOutcome.Done, status, claimed, status == MediaRequestStatus.Approved && running is null ? claimed[0].Id : null);
        }
        finally
        {
            RequestRules.AskGate.Release();
        }
    }

    /// <summary>
    /// The rows that share the elected row's ask and are waiting on its grab take its outcome, and each requester hears it.
    /// </summary>
    private async Task ShareOutcomeAsync(TorrentFlowDbContext db, MediaRequest lead, string? kind, string? heading, CancellationToken ct)
    {
        var key = RequestRules.SameAskKey(lead);
        var siblings = (await db.MediaRequests.AsNoTracking().Where(r => r.WorkKey == lead.WorkKey && r.Id != lead.Id &&
                (r.Status == MediaRequestStatus.Approved || r.Status == MediaRequestStatus.Failed)).ToListAsync(ct))
            .Where(r => RequestRules.SameAskKey(r) == key && string.IsNullOrEmpty(r.GrabbedHashes)).ToList();
        if (siblings.Count == 0) return;
        var ids = siblings.Select(r => r.Id).ToList();
        await db.MediaRequests.Where(r => ids.Contains(r.Id) && (r.Status == MediaRequestStatus.Approved || r.Status == MediaRequestStatus.Failed))
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.Status, lead.Status).SetProperty(r => r.DecisionReason, lead.DecisionReason)
                .SetProperty(r => r.GrabbedHashes, lead.GrabbedHashes).SetProperty(r => r.UpdatedAt, lead.UpdatedAt), ct);
        if (kind is { } k && heading != null)
            foreach (var r in siblings)
                await notifications.TryPublishAsync(r.RequestedByUserId, k, heading, $"{r.Title}: {lead.DecisionReason}", "/requests");
    }

    private async Task GrabAsync(string id, CancellationToken ct)
    {
        if (!activeGrabs.TryAdd(id, 0)) return;
        try { await GrabCoreAsync(id, ct); }
        finally { activeGrabs.TryRemove(id, out _); }
    }

    private async Task GrabCoreAsync(string id, CancellationToken ct, bool retry = false, bool removed = false)
    {
        RequestGrabOutcome outcome;
        try
        {
            await using var read = await factory.CreateDbContextAsync(ct);
            var row = await read.MediaRequests.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id, ct);
            if (row is null || (retry
                ? row.Status is not (MediaRequestStatus.Partial or MediaRequestStatus.Failed)
                : row.Status != MediaRequestStatus.Approved || !string.IsNullOrEmpty(row.GrabbedHashes))) return;
            outcome = retry ? await grabber.RetryAsync(row, removed, ct) : await grabber.GrabAsync(row, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Grab for approved request {Id} failed", id);
            outcome = new([], ex.Message);
        }

        await using var db = await factory.CreateDbContextAsync(CancellationToken.None);
        var current = await db.MediaRequests.FirstOrDefaultAsync(r => r.Id == id, CancellationToken.None);
        if (current is null || current.Status is not (MediaRequestStatus.Approved or MediaRequestStatus.Partial or MediaRequestStatus.Failed)) return;
        current.UpdatedAt = time.GetUtcNow().UtcDateTime;
        if (outcome.Queued)
        {
            // The wanted queue starts and retries it; what it starts joins the request through AttachStartedAsync.
            current.Status = MediaRequestStatus.Approved;
            current.DecisionReason = retry || current.DecisionReason == WaitingReason ? null : current.DecisionReason;
            await db.SaveChangesAsync(CancellationToken.None);
            if (retry)
            {
                // Retry is for the whole ask: the rows that waited with this one look again with it.
                var ask = (await RetryRowsAsync(db, current, CancellationToken.None)).Select(r => r.Id).Where(r => r != id).ToList();
                await db.MediaRequests.Where(r => ask.Contains(r.Id) && (r.Status == MediaRequestStatus.Partial || r.Status == MediaRequestStatus.Failed))
                    .ExecuteUpdateAsync(u => u.SetProperty(r => r.Status, MediaRequestStatus.Approved).SetProperty(r => r.DecisionReason, (string?)null)
                        .SetProperty(r => r.UpdatedAt, current.UpdatedAt), CancellationToken.None);
            }
            // A retry that owes nothing new may already be complete.
            await CheckFulfilledAsync(id, CancellationToken.None);
            return;
        }
        if (outcome.Waiting)
        {
            // Only seasons that have not aired yet: approved and waiting, never failed; the airing check queues them.
            current.Status = MediaRequestStatus.Approved;
            current.DecisionReason = WaitingReason;
            await db.SaveChangesAsync(CancellationToken.None);
            await ShareOutcomeAsync(db, current, null, null, CancellationToken.None);
            return;
        }
        if (outcome.Hashes.Count == 0)
        {
            logger.LogInformation("Approved request {Id} started no download: {Problem}", id, outcome.Problem);
            current.Status = string.IsNullOrEmpty(current.GrabbedHashes) ? MediaRequestStatus.Failed : MediaRequestStatus.Partial;
            current.DecisionReason = current.Status == MediaRequestStatus.Partial
                ? PartialReason : NoDownloadReason;
            await db.SaveChangesAsync(CancellationToken.None);
            var heading = current.Status == MediaRequestStatus.Partial ? "Request partly started" : "Request could not be downloaded";
            await notifications.TryPublishAsync(current.RequestedByUserId, NotificationKind.RequestFailed, heading,
                $"{current.Title}: {current.DecisionReason}", "/requests");
            await ShareOutcomeAsync(db, current, NotificationKind.RequestFailed, heading, CancellationToken.None);
            return;
        }
        current.GrabbedHashes = string.Join(',', outcome.Hashes.Select(h => h.ToLowerInvariant()).Distinct());
        if (outcome.Partial)
        {
            // Keep the hashes so progress is visible, but do not leave a silent full approval.
            current.Status = MediaRequestStatus.Partial;
            logger.LogInformation("Approved request {Id} partly started: {Problem}", id, outcome.Problem);
            current.DecisionReason = string.IsNullOrWhiteSpace(outcome.Problem) ? PartialReason : outcome.Problem.Trim();
            await db.SaveChangesAsync(CancellationToken.None);
            await notifications.TryPublishAsync(current.RequestedByUserId, NotificationKind.RequestFailed, "Request partly started",
                $"{current.Title}: {current.DecisionReason}", "/requests");
            await ShareOutcomeAsync(db, current, NotificationKind.RequestFailed, "Request partly started", CancellationToken.None);
            return;
        }
        current.Status = MediaRequestStatus.Approved;
        if (retry) current.DecisionReason = null;
        await db.SaveChangesAsync(CancellationToken.None);
        await ShareOutcomeAsync(db, current, null, null, CancellationToken.None);
        await CheckFulfilledAsync(id, CancellationToken.None);
    }

    /// <summary>
    /// The owner picked a release by hand for a failed or partial request: its transfer joins the request, which is
    /// approved again and fulfilled once every transfer completes.
    /// </summary>
    public async Task<(DecisionOutcome Outcome, string? Status)> AttachPickAsync(string id, string hash, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var row = await db.MediaRequests.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (row is null) return (DecisionOutcome.NotFound, null);
        if (row.Status is not (MediaRequestStatus.Approved or MediaRequestStatus.Partial or MediaRequestStatus.Failed))
            return (DecisionOutcome.NotPending, row.Status);
        await TrackPickAsync(row, hash.ToLowerInvariant(), ct);
        var key = RequestRules.SameAskKey(row);
        var siblings = (await db.MediaRequests.Where(r => r.WorkKey == row.WorkKey && r.Id != row.Id &&
                (r.Status == MediaRequestStatus.Approved || r.Status == MediaRequestStatus.Partial || r.Status == MediaRequestStatus.Failed))
            .ToListAsync(ct)).Where(r => RequestRules.SameAskKey(r) == key).ToList();
        await AttachAsync(db, row, [hash], announce: true, ct);
        // Everyone who shares the ask shares the pick.
        foreach (var sibling in siblings) await AttachAsync(db, sibling, [hash], announce: sibling.Status != MediaRequestStatus.Approved, ct);
        return (DecisionOutcome.Done, row.Status);
    }

    /// <summary>
    /// A hand pick is tracked like any queue find, through the acquisition target it fills (the film, or the episode its
    /// queue key names): the queue stops looking for it, and when the transfer dies the target is what reopens on retry.
    /// </summary>
    private async Task TrackPickAsync(MediaRequest row, string hash, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var torrent = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.Hash == hash)
            .Select(t => new { t.QueueKey, t.WorkId }).FirstOrDefaultAsync(ct);
        var workId = torrent?.WorkId ?? await db.Works.AsNoTracking().Where(w => w.WorkKey == row.WorkKey).Select(w => w.Id).FirstOrDefaultAsync(ct);
        var episode = TorrentFlow.Core.QueueKeys.Parse(torrent?.QueueKey);
        if (workId is null || row.Scope != MediaRequestScope.Movie && episode is null) return;
        var scope = row.Scope == MediaRequestScope.Movie ? "title" : "episode";
        var key = WantedQueue.TargetKey(row.WorkKey, scope, episode?.Item1, episode?.Item2);
        var now = time.GetUtcNow().UtcDateTime;
        var target = await db.AcquisitionTargets.FirstOrDefaultAsync(t => t.UserId == LocalUser.Id && t.TargetKey == key, ct);
        if (target is null)
        {
            db.AcquisitionTargets.Add(target = new() { Id = Ids.New(), UserId = LocalUser.Id, TargetKey = key, WorkKey = row.WorkKey, WorkId = workId,
                Scope = scope, Season = episode?.Item1, Episode = episode?.Item2, CreatedAt = now });
        }
        target.Status = "downloading"; target.InfoHash = hash; target.Progress = 0; target.FileIndex = null; target.FilePath = null;
        target.Error = null; target.UpdatedAt = now;
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException error) { logger.LogWarning(error, "Could not track the pick {Hash} for request {Id}", hash, row.Id); }
    }

    /// <summary>Transfers the wanted queue (or a hand pick on the title page) started for this request's title join it.</summary>
    public async Task AttachStartedAsync(string id, IReadOnlyCollection<string> hashes, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var row = await db.MediaRequests.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (row is null || row.Status is not (MediaRequestStatus.Approved or MediaRequestStatus.Partial or MediaRequestStatus.Failed)) return;
        await AttachAsync(db, row, hashes, announce: row.Status != MediaRequestStatus.Approved, ct);
    }

    private async Task AttachAsync(TorrentFlowDbContext db, MediaRequest row, IEnumerable<string> started, bool announce, CancellationToken ct)
    {
        var hashes = (row.GrabbedHashes ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries).ToList();
        foreach (var hash in started.Select(h => h.ToLowerInvariant()))
            if (!hashes.Contains(hash)) hashes.Add(hash);
        row.GrabbedHashes = string.Join(',', hashes);
        row.UpdatedAt = time.GetUtcNow().UtcDateTime;
        // A stop the requester and owner were told about, or episodes the owner removed before the request was ever
        // fulfilled, hold it partial until Retry, a pick or the owner settles them, so a find for another episode never
        // flips it back and forth (or announces it again).
        var removed = row.DecisionReason is PartRemovedReason or RemovedReason && row.FulfilledThrough is null;
        var health = row.StoppedKey != null || removed ? await HealthOfAsync(db, row, ct) : null;
        if (row.StoppedKey != null && health!.Stopped.Count > 0)
        {
            row.Status = MediaRequestStatus.Partial;
            row.DecisionReason = PartStoppedReason;
            announce = false;
        }
        else if (removed && health is { Missing: > 0, Open: false })
        {
            row.Status = MediaRequestStatus.Partial;
            row.DecisionReason = PartRemovedReason;
            announce = false;
        }
        else
        {
            row.Status = MediaRequestStatus.Approved;
            // The owner's own stop (Remove on a looking row) stays on record; anything else is answered by the find.
            if (!RequestWantedObserver.OwnerStopped(row.DecisionReason)) row.DecisionReason = null;
            row.StoppedKey = null;
        }
        await db.SaveChangesAsync(ct);
        if (announce)
            await notifications.TryPublishAsync(row.RequestedByUserId, NotificationKind.RequestApproved, "Request started", row.Title, "/requests");
        await CheckFulfilledAsync(row.Id, CancellationToken.None);
    }

    /// <summary>
    /// The wanted queue tried several times and part of this request is still not found: the requester is told once and
    /// the owner can pick a release by hand. The queue keeps looking; a later find approves the request again.
    /// </summary>
    public async Task MarkStillLookingAsync(string id, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var row = await db.MediaRequests.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (row is null || row.Status != MediaRequestStatus.Approved) return;
        var status = string.IsNullOrEmpty(row.GrabbedHashes) ? MediaRequestStatus.Failed : MediaRequestStatus.Partial;
        var reason = status == MediaRequestStatus.Partial ? PartialReason : NoDownloadReason;
        var now = time.GetUtcNow().UtcDateTime;
        var changed = await db.MediaRequests.Where(r => r.Id == id && r.Status == MediaRequestStatus.Approved)
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.Status, status).SetProperty(r => r.DecisionReason, reason)
                .SetProperty(r => r.UpdatedAt, now), ct);
        if (changed == 0) return;
        await notifications.TryPublishAsync(row.RequestedByUserId, NotificationKind.RequestFailed,
            status == MediaRequestStatus.Partial ? "Request partly started" : "Request still searching", $"{row.Title}: {reason}", "/requests");
    }

    /// <summary>Checks one request for fulfilment now, e.g. after the owner stopped part of what it was waiting on.</summary>
    public Task RecheckAsync(string id, CancellationToken ct) => CheckFulfilledAsync(id, ct);

    /// <summary>Called when a transfer completes: every approved request that grabbed it is re-checked.</summary>
    public async Task OnTorrentCompletedAsync(string hash, CancellationToken ct)
    {
        var needle = hash.ToLowerInvariant();
        await using var db = await factory.CreateDbContextAsync(ct);
        var candidates = await db.MediaRequests.AsNoTracking()
            .Where(r => r.Status == MediaRequestStatus.Approved && r.GrabbedHashes != null && r.GrabbedHashes.Contains(needle))
            .Select(r => new { r.Id, r.GrabbedHashes }).ToListAsync(ct);
        foreach (var c in candidates.Where(c => c.GrabbedHashes!.Split(',').Contains(needle)))
            await CheckFulfilledAsync(c.Id, ct);
    }

    /// <summary>Re-checks every approved request (after a restart, completions may have been missed).</summary>
    public async Task SweepAsync(CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        await db.MediaRequests.Where(r => r.Status == MediaRequestStatus.Failed && r.GrabbedHashes != null && r.GrabbedHashes != "")
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.Status, MediaRequestStatus.Partial), ct);
        var rows = await db.MediaRequests.AsNoTracking()
            .Where(r => r.Status == MediaRequestStatus.Approved).ToListAsync(ct);
        foreach (var row in rows)
        {
            // Grabbing a request the owner stopped part of, or one not yet given its covered mark, would bring back the
            // episodes he removed.
            if (string.IsNullOrEmpty(row.GrabbedHashes))
            {
                if (!RequestWantedObserver.OwnerStopped(row.DecisionReason) && !RequestMarks.AwaitsCover(row)) await GrabAsync(row.Id, ct);
            }
            else await CheckFulfilledAsync(row.Id, ct);
        }
    }

    /// <summary>
    /// The one-time upgrade backfill, and its retry for rows a lookup could not settle: a season request decided before
    /// covered marks existed takes, per season, the last episode that had aired when it was decided. A wanted row missing
    /// at or below it since then is one the owner removed or stopped, so nothing brings it back.
    /// </summary>
    public async Task BackfillCoveredAsync(CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var rows = await db.MediaRequests.AsNoTracking().Where(r => r.Scope != MediaRequestScope.Movie && r.DecidedAt != null &&
            r.CoveredThrough == null && r.Status != MediaRequestStatus.Cancelled && r.Status != MediaRequestStatus.Declined).ToListAsync(ct);
        foreach (var row in rows)
        {
            string? covered;
            try { covered = await grabber.AiredByAsync(row, row.DecidedAt!.Value, null, ct); }
            catch (Exception error) when (!ct.IsCancellationRequested)
            {
                logger.LogWarning(error, "Could not backfill the covered mark of request {Id}", row.Id);
                continue;
            }
            if (covered is null) continue;
            if (await db.MediaRequests.Where(r => r.Id == row.Id && r.CoveredThrough == null)
                    .ExecuteUpdateAsync(u => u.SetProperty(r => r.CoveredThrough, covered), ct) > 0)
                logger.LogInformation("Request {Id}: covered mark backfilled to {Covered}", row.Id, covered);
        }
    }

    /// <summary>
    /// The owner stopped looking for an episode, or a whole season (Remove on a looking row). Every decided request
    /// covering it, of any ask, remembers it as covered before anything is rechecked, so no reconcile, re-grab or Retry
    /// brings it back. A season counts as stopped through its last aired episode. A pending ask has queued nothing (a
    /// mark would hold back episodes it never wanted); approving it later is the owner's call.
    /// </summary>
    public async Task CoverStoppedAsync(string workKey, int? season, int? episode, CancellationToken ct)
    {
        if (season is not { } stopped) return;
        await using var db = await factory.CreateDbContextAsync(ct);
        var rows = (await db.MediaRequests.Where(r => r.WorkKey == workKey && r.Scope != MediaRequestScope.Movie && r.DecidedAt != null &&
                r.Status != MediaRequestStatus.Cancelled && r.Status != MediaRequestStatus.Declined).ToListAsync(ct))
            .Where(r => r.Scope == MediaRequestScope.Series || RequestRules.ParseSeasons(r.Seasons) is var asked && (asked.Count == 0 || asked.Contains(stopped)))
            .ToList();
        if (rows.Count == 0) return;
        var now = time.GetUtcNow().UtcDateTime;
        var through = episode ?? RequestMarks.Parse(await grabber.AiredByAsync(rows[0], now, [stopped], ct))?.GetValueOrDefault(stopped) ?? 0;
        var kept = 0;
        foreach (var row in rows)
        {
            // A row still waiting for its upgrade backfill takes it now, so the stop does not stand in for the rest of it.
            // If that lookup fails it keeps waiting (nothing reconciles or re-grabs it) rather than holding the stop alone.
            var start = row.CoveredThrough ?? await grabber.AiredByAsync(row, row.DecidedAt!.Value, null, ct);
            if (start is null) continue;
            row.CoveredThrough = RequestMarks.Advance(start, through > 0 ? [(stopped, through)] : []);
            kept++;
        }
        await db.SaveChangesAsync(ct);
        logger.LogInformation("{WorkKey} season {Season} episode {Episode} stopped: {Rows} requests remember it", workKey, stopped,
            episode?.ToString() ?? "all", kept);
    }

    /// <summary>The acquisition targets in this request's scope: the film, or the episodes of the asked seasons.</summary>
    private static IQueryable<AcquisitionTarget> ScopeTargets(TorrentFlowDbContext db, MediaRequest row)
    {
        var all = db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkKey == row.WorkKey);
        var seasons = RequestRules.ParseSeasons(row.Seasons).ToArray();
        return row.Scope == MediaRequestScope.Movie ? all.Where(t => t.Scope == "title")
            : row.Scope == MediaRequestScope.Series || seasons.Length == 0 ? all.Where(t => t.Scope == "episode")
            : all.Where(t => t.Scope == "episode" && t.Season != null && seasons.Contains(t.Season.Value));
    }

    /// <summary>One acquisition target in a request's scope.</summary>
    private sealed record ScopeTarget(string TargetKey, string Scope, int? Season, int? Episode, string Status, string? InfoHash);

    /// <summary>
    /// What a request's transfers and wanted rows say now. Each tracked transfer is live, stopped (error or missing files,
    /// nothing in its place), gone (removed) or replaced (its film or episode has another live transfer). Of what the
    /// request still owes (above its mark once it was fulfilled): <see cref="Open"/> the queue still looks for something,
    /// <see cref="Pending"/> a wanted row names a live transfer the request does not track yet (a find not attached yet),
    /// <see cref="Missing"/> counts the film or episodes with nothing live, nothing looking and no stop to retry (the
    /// owner removed them, or their files went), and <see cref="Here"/> says something in scope is live or on disk.
    /// </summary>
    private sealed record TrackedTransfers(IReadOnlyList<string> Live, IReadOnlyList<string> Stopped, IReadOnlyList<string> Gone,
        IReadOnlyList<string> Replaced, bool Open, bool Pending, int Missing, bool Here);

    private static async Task<TrackedTransfers> HealthOfAsync(TorrentFlowDbContext db, MediaRequest row, CancellationToken ct)
    {
        var marks = RequestMarks.Parse(row.FulfilledThrough);
        var targets = (await ScopeTargets(db, row).Select(t => new ScopeTarget(t.TargetKey, t.Scope, t.Season, t.Episode, t.Status, t.InfoHash))
                .ToListAsync(ct))
            .Where(t => t.Scope == "title" || t.Season is { } s && t.Episode is { } e && RequestMarks.Counts(marks, s, e)).ToList();
        var tracked = RequestHealth.Hashes(row.GrabbedHashes);
        var mine = tracked.ToHashSet(StringComparer.Ordinal);
        var states = await RequestHealth.StatesAsync(db, tracked.Concat(targets.Select(t => t.InfoHash).OfType<string>()), ct);
        bool Alive(string? hash) => hash is not null && states.TryGetValue(hash.ToLowerInvariant(), out var s) && !RequestHealth.IsStopped(s.Status);
        List<string> live = [], stopped = [], gone = [], replaced = [];
        var stoppedOn = new HashSet<string>(StringComparer.Ordinal);
        foreach (var hash in tracked)
        {
            var known = states.TryGetValue(hash, out var state);
            var filled = FilledTarget(row, hash, known ? state.QueueKey : null, targets);
            // At or below the mark (or nothing it still owes): settled history, whatever became of it since.
            if (marks != null && filled is null) continue;
            if (known && !RequestHealth.IsStopped(state.Status)) live.Add(hash);
            else if (filled?.InfoHash?.ToLowerInvariant() is { } now && now != hash && Alive(now)) replaced.Add(hash);
            else if (!known) gone.Add(hash);
            else
            {
                stopped.Add(hash);
                if (filled != null) stoppedOn.Add(filled.TargetKey);
            }
        }
        var open = false;
        var pending = false;
        var here = live.Count > 0;
        var missing = 0;
        foreach (var t in targets)
        {
            // A stopped transfer is Retry's: its film or episode is never counted missing. If the engine already handed
            // its wanted row back (a dead magnet, a refused file list or English check), the queue is replacing it: open.
            var stoppedHere = stoppedOn.Contains(t.TargetKey);
            var named = t.InfoHash?.ToLowerInvariant();
            if (named is null)
            {
                // Handed back as failed: removed, its file went, or nothing was found by hand.
                if (t.Status == "queued") open = true;
                else if (!stoppedHere) missing++;
            }
            else if (!Alive(named))
            {
                if (!stoppedHere) missing++;
            }
            else if (!stoppedHere)
            {
                here = true;
                if (!mine.Contains(named) && t.Status != "downloaded" && states[named].Progress < 1) pending = true;
            }
        }
        // Nothing in scope at all and nothing live (its wanted rows went with a removal): nothing is here either.
        if (targets.Count == 0 && live.Count == 0) missing++;
        return new(live, stopped, gone, replaced, open, pending, missing, here);
    }

    /// <summary>The target a transfer filled among <paramref name="targets"/>: its queue key's episode, the film, or one that names it.</summary>
    private static ScopeTarget? FilledTarget(MediaRequest row, string hash, string? queueKey, IReadOnlyList<ScopeTarget> targets)
    {
        if (TorrentFlow.Core.QueueKeys.Parse(queueKey) is { } episode)
            return targets.FirstOrDefault(t => t.Scope == "episode" && t.Season == episode.Item1 && t.Episode == episode.Item2);
        if (row.Scope == MediaRequestScope.Movie) return targets.FirstOrDefault(t => t.Scope == "title");
        return targets.FirstOrDefault(t => string.Equals(t.InfoHash, hash, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>The partial or failed rows of the ask an owner's Retry is pressed on.</summary>
    private static async Task<List<MediaRequest>> RetryRowsAsync(TorrentFlowDbContext db, MediaRequest row, CancellationToken ct)
    {
        var key = RequestRules.SameAskKey(row);
        return (await db.MediaRequests.AsNoTracking().Where(r => r.WorkKey == row.WorkKey &&
                (r.Status == MediaRequestStatus.Partial || r.Status == MediaRequestStatus.Failed)).ToListAsync(ct))
            .Where(r => r.Id == row.Id || RequestRules.SameAskKey(r) == key).ToList();
    }

    /// <summary>
    /// Retry forgets the request's stopped, replaced and removed transfers and hands the targets of the stopped ones back
    /// as failed, so the retry grab looks for them again. What the owner removed stays removed, unless the request stopped
    /// waiting because of that removal (<paramref name="removed"/>): then those targets are handed back too.
    /// </summary>
    private async Task DropDeadAsync(TorrentFlowDbContext db, MediaRequest row, bool removed, CancellationToken ct)
    {
        var health = await HealthOfAsync(db, row, ct);
        var drop = health.Stopped.Concat(health.Gone).Concat(health.Replaced).ToHashSet(StringComparer.Ordinal);
        var reopen = health.Stopped.ToList();
        if (removed)
        {
            // It stopped waiting because of a removal: every film or episode in scope whose transfer is gone is looked
            // for again, the request's own or not (a download the owner had made himself and deleted since).
            var marks = RequestMarks.Parse(row.FulfilledThrough);
            var named = (await ScopeTargets(db, row).Where(t => t.InfoHash != null).Select(t => new { t.Season, t.Episode, t.InfoHash })
                    .ToListAsync(ct))
                .Where(t => t.Season is not { } s || t.Episode is not { } e || RequestMarks.Counts(marks, s, e))
                .Select(t => t.InfoHash!.ToLowerInvariant()).Distinct().ToList();
            var known = await RequestHealth.StatesAsync(db, named, ct);
            reopen.AddRange(named.Where(h => !known.ContainsKey(h)));
        }
        var kept = RequestHealth.Join(RequestHealth.Hashes(row.GrabbedHashes).Where(h => !drop.Contains(h)));
        var now = time.GetUtcNow().UtcDateTime;
        // The stops already announced stay recorded: if the retry brings back the same dead release, nobody hears it twice.
        await db.MediaRequests.Where(r => r.Id == row.Id).ExecuteUpdateAsync(u => u.SetProperty(r => r.GrabbedHashes, kept)
            .SetProperty(r => r.UpdatedAt, now), ct);
        row.GrabbedHashes = kept;
        if (reopen.Count == 0) return;
        // A target loses its hash once the title page reconciles it, so the stopped transfer's queue key finds it too.
        var keys = (await RequestHealth.StatesAsync(db, reopen, ct)).Values.Select(s => TorrentFlow.Core.QueueKeys.Parse(s.QueueKey))
            .OfType<(int, int)>().Select(e => WantedQueue.TargetKey(row.WorkKey, "episode", e.Item1, e.Item2)).ToList();
        await db.AcquisitionTargets.Where(t => t.UserId == LocalUser.Id && t.WorkKey == row.WorkKey &&
                (t.InfoHash != null && reopen.Contains(t.InfoHash) || t.InfoHash == null && keys.Contains(t.TargetKey)))
            .ExecuteUpdateAsync(u => u.SetProperty(t => t.Status, "failed").SetProperty(t => t.Error, (string?)null)
                .SetProperty(t => t.UpdatedAt, now), ct);
    }

    /// <summary>
    /// Request upkeep. An approved request the queue is not looking for anymore whose tracked transfer stopped (error or
    /// missing files, nothing in its place) becomes partial, or failed when nothing else lives. The stopped transfers the
    /// requester and owner were told about are stored (<see cref="MediaRequest.StoppedKey"/>): only one that stops later is
    /// news, and a set that only shrinks (resumed, replaced or removed) is stored quietly. A removal by the owner is not a
    /// stop and notifies nobody: a request fulfilled before is judged on the rest; one never fulfilled that can't be, with
    /// nothing looking, stops waiting quietly with Retry and Pick a release. A reported stop that cleared goes back to approved.
    /// </summary>
    public async Task SettleDeadAsync(CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var rows = await db.MediaRequests.AsNoTracking().Where(r => r.GrabbedHashes != null && r.GrabbedHashes != "" &&
            (r.Status == MediaRequestStatus.Approved ||
             r.StoppedKey != null && (r.Status == MediaRequestStatus.Partial || r.Status == MediaRequestStatus.Failed))).ToListAsync(ct);
        var told = new HashSet<string>(StringComparer.Ordinal);
        foreach (var row in rows)
        {
            var health = await HealthOfAsync(db, row, ct);
            if (row.Status != MediaRequestStatus.Approved)
            {
                await RecheckStoppedAsync(db, row, health, told, ct);
                continue;
            }
            // The queue still looks, or a find has not joined the request yet: nothing to judge.
            if (health.Open || health.Pending) continue;
            if (health.Stopped.Count > 0)
            {
                await MarkStoppedAsync(db, row, health, told, ct);
                continue;
            }
            await DropReplacedAsync(db, row, health, ct);
            // The owner's stop marker only keeps the restart sweep from re-grabbing a request with no transfers; one with
            // transfers that lost some is judged like any other (its covered mark keeps what he stopped from coming back).
            if (health.Missing > 0 && row.FulfilledThrough is null) await MarkRemovedAsync(db, row, health, ct);
            else if (health.Gone.Count > 0 || health.Replaced.Count > 0 || row.FulfilledThrough != null) await CheckFulfilledAsync(row.Id, ct);
        }
    }

    private async Task MarkStoppedAsync(TorrentFlowDbContext db, MediaRequest row, TrackedTransfers health, HashSet<string> told, CancellationToken ct)
    {
        var status = health.Here ? MediaRequestStatus.Partial : MediaRequestStatus.Failed;
        var reason = health.Here ? PartStoppedReason : StoppedReason;
        var key = RequestHealth.Sorted(health.Stopped);
        if (status == row.Status && reason == row.DecisionReason && key == row.StoppedKey) return;
        var announced = RequestHealth.Hashes(row.StoppedKey).ToHashSet(StringComparer.Ordinal);
        var now = time.GetUtcNow().UtcDateTime;
        var changed = await db.MediaRequests.Where(r => r.Id == row.Id && r.Status == row.Status && r.GrabbedHashes == row.GrabbedHashes)
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.Status, status).SetProperty(r => r.DecisionReason, reason)
                .SetProperty(r => r.StoppedKey, key).SetProperty(r => r.UpdatedAt, now), ct);
        // Only a transfer that stopped since the last notice is news; a set that only shrank was stored quietly.
        if (changed == 0 || health.Stopped.All(announced.Contains)) return;
        logger.LogInformation("Request {Id} {Status}: {Count} tracked transfers stopped", row.Id, status, health.Stopped.Count);
        await notifications.TryPublishAsync(row.RequestedByUserId, NotificationKind.RequestFailed, "Request download stopped",
            $"{row.Title}: {reason}", "/requests");
        if (told.Add(RequestRules.SameAskKey(row)))
            await notifications.TryPublishAsync(LocalUser.Id, NotificationKind.RequestFailed, "A request's download stopped",
                $"{row.Title}: retry it or pick another release.", "/requests");
    }

    /// <summary>A reported stop: still stopped, the set is kept current (news only for a newly stopped transfer); cleared, approved again quietly.</summary>
    private async Task RecheckStoppedAsync(TorrentFlowDbContext db, MediaRequest row, TrackedTransfers health, HashSet<string> told, CancellationToken ct)
    {
        if (health.Stopped.Count > 0)
        {
            await MarkStoppedAsync(db, row, health, told, ct);
            return;
        }
        var now = time.GetUtcNow().UtcDateTime;
        var changed = await db.MediaRequests.Where(r => r.Id == row.Id && r.Status == row.Status && r.StoppedKey == row.StoppedKey)
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.Status, MediaRequestStatus.Approved).SetProperty(r => r.DecisionReason, (string?)null)
                .SetProperty(r => r.StoppedKey, (string?)null).SetProperty(r => r.UpdatedAt, now), ct);
        if (changed > 0) await CheckFulfilledAsync(row.Id, ct);
    }

    /// <summary>A dead release the queue or a pick replaced leaves the request, so only the live one counts (OPS-622).</summary>
    private static async Task DropReplacedAsync(TorrentFlowDbContext db, MediaRequest row, TrackedTransfers health, CancellationToken ct)
    {
        if (health.Replaced.Count == 0) return;
        var kept = RequestHealth.Join(RequestHealth.Hashes(row.GrabbedHashes).Where(h => !health.Replaced.Contains(h)));
        if (kept is null) return;
        if (await db.MediaRequests.Where(r => r.Id == row.Id && r.GrabbedHashes == row.GrabbedHashes)
                .ExecuteUpdateAsync(u => u.SetProperty(r => r.GrabbedHashes, kept), ct) > 0)
            row.GrabbedHashes = kept;
    }

    /// <summary>
    /// Never fulfilled, nothing looking or stopped, and episodes (or the film) are not here: the owner removed them or their
    /// files went. The request stops waiting quietly (the owner did it; nobody is told): partial when something in it is
    /// here or coming, failed otherwise, with Retry (which looks for those again) and Pick a release.
    /// </summary>
    private async Task MarkRemovedAsync(TorrentFlowDbContext db, MediaRequest row, TrackedTransfers health, CancellationToken ct)
    {
        var status = health.Here ? MediaRequestStatus.Partial : MediaRequestStatus.Failed;
        var reason = health.Here ? PartRemovedReason : RemovedReason;
        var now = time.GetUtcNow().UtcDateTime;
        var changed = await db.MediaRequests.Where(r => r.Id == row.Id && r.Status == MediaRequestStatus.Approved && r.GrabbedHashes == row.GrabbedHashes)
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.Status, status).SetProperty(r => r.DecisionReason, reason)
                .SetProperty(r => r.StoppedKey, (string?)null).SetProperty(r => r.UpdatedAt, now), ct);
        if (changed > 0) logger.LogInformation("Request {Id} {Status}: {Count} of it removed by the owner", row.Id, status, health.Missing);
    }

    /// <summary>
    /// Season requests that are open, waiting for their season to air, or fulfilled recently enough that their season
    /// may still be airing, queue every episode aired since (above the mark once fulfilled). Everyone who shares an ask
    /// moves together: one check, and every row of it is approved again (or stops waiting) at once, so each requester
    /// gets the new episode's transfer.
    /// </summary>
    public async Task ReconcileAiringAsync(CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var since = time.GetUtcNow().UtcDateTime - AiringWindow;
        var rows = await db.MediaRequests.AsNoTracking().Where(r => r.Scope != MediaRequestScope.Movie &&
            (r.Status == MediaRequestStatus.Approved || r.Status == MediaRequestStatus.Partial ||
             r.Status == MediaRequestStatus.Fulfilled && r.UpdatedAt > since)).OrderBy(r => r.CreatedAt).ToListAsync(ct);
        foreach (var ask in rows.GroupBy(RequestRules.SameAskKey).Select(g => g.ToList()))
        {
            var lead = ask[0];
            // Not backfilled yet (an upgrade whose lookup failed): it would bring back what the owner stopped before it.
            if (RequestMarks.AwaitsCover(lead)) continue;
            if (lead.Status == MediaRequestStatus.Fulfilled && lead.FulfilledThrough is null) lead.FulfilledThrough = await BackfillMarkAsync(db, ask, ct);
            var ids = ask.Select(r => r.Id).ToList();
            int queued;
            // The ask reopens before anything is queued, so a find the queue reports at once has approved rows to join.
            try { queued = await grabber.ReconcileAsync(lead, ct, () => ReopenAsync(db, ids, ct)); }
            catch (Exception error) when (!ct.IsCancellationRequested)
            {
                logger.LogWarning(error, "Could not check request {Id} for newly aired episodes", lead.Id);
                continue;
            }
            if (queued > 0) logger.LogInformation("Request {Id} ({Rows} rows of the ask): {Count} newly aired episodes queued", lead.Id, ask.Count, queued);
        }
    }

    /// <summary>A request fulfilled before marks existed takes the episodes its scope covers as its mark, and at least its covered mark.</summary>
    private async Task<string> BackfillMarkAsync(TorrentFlowDbContext db, IReadOnlyList<MediaRequest> ask, CancellationToken ct)
    {
        var mark = RequestMarks.Advance(ask[0].CoveredThrough, await CoveredAsync(db, ask[0], ct));
        var ids = ask.Where(r => r.Status == MediaRequestStatus.Fulfilled && r.FulfilledThrough == null).Select(r => r.Id).ToList();
        await db.MediaRequests.Where(r => ids.Contains(r.Id) && r.FulfilledThrough == null)
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.FulfilledThrough, mark), ct);
        return mark;
    }

    /// <summary>The ask's fulfilled rows are approved again for the newly aired episodes; waiting rows stop waiting.</summary>
    private async Task ReopenAsync(TorrentFlowDbContext db, IReadOnlyList<string> ids, CancellationToken ct)
    {
        var now = time.GetUtcNow().UtcDateTime;
        await db.MediaRequests.Where(r => ids.Contains(r.Id) && r.Status == MediaRequestStatus.Fulfilled)
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.Status, MediaRequestStatus.Approved).SetProperty(r => r.UpdatedAt, now), ct);
        await db.MediaRequests.Where(r => ids.Contains(r.Id) && r.DecisionReason == WaitingReason)
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.DecisionReason, (string?)null).SetProperty(r => r.UpdatedAt, now), ct);
    }

    /// <summary>Every episode this request's scope has a target for (the film has none).</summary>
    private static async Task<List<(int Season, int Episode)>> CoveredAsync(TorrentFlowDbContext db, MediaRequest row, CancellationToken ct) =>
        (await ScopeTargets(db, row).Where(t => t.Season != null && t.Episode != null).Select(t => new { t.Season, t.Episode }).ToListAsync(ct))
            .Select(t => (t.Season!.Value, t.Episode!.Value)).ToList();

    private async Task CheckFulfilledAsync(string id, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var row = await db.MediaRequests.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id, ct);
        if (row is null || row.Status != MediaRequestStatus.Approved || string.IsNullOrEmpty(row.GrabbedHashes)) return;
        // A season request is the whole season as it airs: episodes aired since approval are queued first (the ask's
        // fulfilled rows reopen before the queue can report a find) and count.
        if (await grabber.ReconcileAsync(row, ct, () => ReopenAskAsync(db, row, ct)) > 0) return;
        // What the queue still looks for, a find not joined yet, or a transfer that stopped with nothing in its place
        // (the upkeep sweep offers Retry) keeps the request open. Replaced or removed transfers say nothing more.
        var health = await HealthOfAsync(db, row, ct);
        if (health.Open || health.Pending || health.Stopped.Count > 0) return;
        // Never fulfilled, what is not here waits for the owner (the sweep offers Retry and Pick). Fulfilled before, what
        // the owner removed since is settled, and the request is judged on the rest (above its mark).
        if (health.Missing > 0 && row.FulfilledThrough is null) return;
        foreach (var hash in health.Live)
        {
            if (!await transfers.CompletedAsync(hash, ct)) return;
        }
        await FulfilAsync(db, row, announce: row.FulfilledThrough is null || health.Live.Count > 0, ct);
    }

    /// <summary>The fulfilled rows that share this request's ask are approved again with it.</summary>
    private async Task ReopenAskAsync(TorrentFlowDbContext db, MediaRequest row, CancellationToken ct)
    {
        var key = RequestRules.SameAskKey(row);
        var ids = (await db.MediaRequests.AsNoTracking().Where(r => r.WorkKey == row.WorkKey && r.Status == MediaRequestStatus.Fulfilled)
                .ToListAsync(ct))
            .Where(r => RequestRules.SameAskKey(r) == key).Select(r => r.Id).ToList();
        if (ids.Count > 0) await ReopenAsync(db, ids, ct);
    }

    /// <summary>
    /// Fulfilled, with the mark raised to every episode now covered and to at least the covered mark (an episode the owner
    /// stopped is behind it, never owed again); a reopened request says new episodes are here.
    /// </summary>
    private async Task FulfilAsync(TorrentFlowDbContext db, MediaRequest row, bool announce, CancellationToken ct)
    {
        var mark = row.Scope == MediaRequestScope.Movie ? null
            : RequestMarks.Advance(row.FulfilledThrough, RequestMarks.Entries(row.CoveredThrough).Concat(await CoveredAsync(db, row, ct)));
        var now = time.GetUtcNow().UtcDateTime;
        var changed = await db.MediaRequests.Where(r => r.Id == row.Id && r.Status == MediaRequestStatus.Approved)
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.Status, MediaRequestStatus.Fulfilled).SetProperty(r => r.FulfilledThrough, mark)
                .SetProperty(r => r.StoppedKey, (string?)null).SetProperty(r => r.UpdatedAt, now), ct);
        if (changed == 0 || !announce) return;
        await notifications.TryPublishAsync(row.RequestedByUserId, NotificationKind.RequestFulfilled,
            row.FulfilledThrough is null ? "Request fulfilled" : "New episodes ready", row.Title, "/library");
    }
}

/// <summary>Moves approved requests to fulfilled when the engine reports their transfers complete, fails requests whose
/// transfers all died, and keeps season requests covering every episode as it airs.</summary>
public sealed class RequestFulfillmentWatcher(ITorrentEngine engine, RequestDecisionService decisions, ILogger<RequestFulfillmentWatcher> logger)
    : BackgroundService
{
    /// <summary>How often dead transfers are looked for (sooner when the engine reports a failure).</summary>
    private static readonly TimeSpan HealthCheck = TimeSpan.FromMinutes(1);
    /// <summary>How often season requests look for newly aired episodes; the season shape refreshes every few hours.</summary>
    private static readonly TimeSpan AiringCheck = TimeSpan.FromMinutes(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        void OnCompleted(object? sender, EngineTorrentCompletedEventArgs e) => _ = Task.Run(async () =>
        {
            try { await decisions.OnTorrentCompletedAsync(e.Hash, stoppingToken); }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested) { logger.LogWarning(ex, "Request fulfillment check failed for {Hash}", e.Hash); }
        }, CancellationToken.None);

        var wake = new SemaphoreSlim(0);
        void OnFailed(object? sender, EngineTorrentFailedEventArgs e) => wake.Release();

        engine.TorrentCompleted += OnCompleted;
        engine.TorrentFailed += OnFailed;
        try
        {
            // Before anything reconciles or re-grabs: requests from before covered marks get theirs first.
            try { await decisions.BackfillCoveredAsync(stoppingToken); }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested) { logger.LogWarning(ex, "Covered mark backfill failed"); }
            try { await decisions.SweepAsync(stoppingToken); }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested) { logger.LogWarning(ex, "Request fulfillment sweep failed"); }
            var nextAiring = DateTime.MinValue;
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await decisions.SettleDeadAsync(stoppingToken);
                    if (DateTime.UtcNow >= nextAiring)
                    {
                        // A row whose backfill lookup failed is tried again before the airing check.
                        await decisions.BackfillCoveredAsync(stoppingToken);
                        await decisions.ReconcileAiringAsync(stoppingToken);
                        nextAiring = DateTime.UtcNow + AiringCheck;
                    }
                }
                catch (Exception ex) when (!stoppingToken.IsCancellationRequested) { logger.LogWarning(ex, "Request upkeep failed"); }
                await wake.WaitAsync(HealthCheck, stoppingToken);
            }
        }
        catch (OperationCanceledException) { }
        finally
        {
            engine.TorrentCompleted -= OnCompleted;
            engine.TorrentFailed -= OnFailed;
        }
    }
}
