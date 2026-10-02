using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Api.Notifications;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Api.Requests;

public enum DecisionOutcome { Done, NotFound, NotPending }

/// <summary>Whether a grabbed transfer has finished; a seam so tests need no real torrents.</summary>
public interface IRequestTransfers
{
    Task<bool> CompletedAsync(string hash, CancellationToken ct);
}

public sealed class EngineRequestTransfers(ITorrentEngine engine) : IRequestTransfers
{
    public async Task<bool> CompletedAsync(string hash, CancellationToken ct) =>
        await engine.GetAsync(hash, ct) is { } info && (info.Progress >= 1 || info.State == "downloaded");
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
        LastGrab = Task.Run(async () =>
        {
            try { await GrabCoreAsync(id, lifetime.ApplicationStopping, retry: true); }
            finally { activeGrabs.TryRemove(id, out _); }
        }, CancellationToken.None);
        return (DecisionOutcome.Done, row.Status);
    }

    public async Task<(DecisionOutcome Outcome, string? Status)> ApproveAsync(string id, CancellationToken ct, string? decisionReason = null)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var row = await db.MediaRequests.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (row is null) return (DecisionOutcome.NotFound, null);
        if (row.Status != MediaRequestStatus.Pending) return (DecisionOutcome.NotPending, row.Status);
        var now = time.GetUtcNow().UtcDateTime;
        row.Status = MediaRequestStatus.Approved;
        row.DecisionReason = string.IsNullOrWhiteSpace(decisionReason) ? null : decisionReason.Trim();
        row.DecidedAt = now;
        row.UpdatedAt = now;
        var changed = await db.MediaRequests.Where(r => r.Id == id && r.Status == MediaRequestStatus.Pending)
            .ExecuteUpdateAsync(update => update.SetProperty(r => r.Status, row.Status)
                .SetProperty(r => r.DecisionReason, row.DecisionReason).SetProperty(r => r.DecidedAt, now)
                .SetProperty(r => r.UpdatedAt, now), ct);
        if (changed == 0)
            return (DecisionOutcome.NotPending, await db.MediaRequests.Where(r => r.Id == id).Select(r => r.Status).FirstOrDefaultAsync(ct));
        await notifications.TryPublishAsync(row.RequestedByUserId, NotificationKind.RequestApproved, "Request approved", row.Title, "/requests");
        LastGrab = Task.Run(() => GrabAsync(id, lifetime.ApplicationStopping), CancellationToken.None);
        return (DecisionOutcome.Done, row.Status);
    }

    public async Task<(DecisionOutcome Outcome, string? Status)> DeclineAsync(string id, string? reason, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var row = await db.MediaRequests.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (row is null) return (DecisionOutcome.NotFound, null);
        if (row.Status != MediaRequestStatus.Pending) return (DecisionOutcome.NotPending, row.Status);
        var now = time.GetUtcNow().UtcDateTime;
        row.Status = MediaRequestStatus.Declined;
        row.DecisionReason = string.IsNullOrWhiteSpace(reason) ? null : reason.Trim();
        row.DecidedAt = now;
        row.UpdatedAt = now;
        var changed = await db.MediaRequests.Where(r => r.Id == id && r.Status == MediaRequestStatus.Pending)
            .ExecuteUpdateAsync(update => update.SetProperty(r => r.Status, row.Status)
                .SetProperty(r => r.DecisionReason, row.DecisionReason).SetProperty(r => r.DecidedAt, now)
                .SetProperty(r => r.UpdatedAt, now), ct);
        if (changed == 0)
            return (DecisionOutcome.NotPending, await db.MediaRequests.Where(r => r.Id == id).Select(r => r.Status).FirstOrDefaultAsync(ct));
        await notifications.TryPublishAsync(row.RequestedByUserId, NotificationKind.RequestDeclined, "Request declined",
            row.DecisionReason is { } reasonText ? $"{row.Title}: {reasonText}" : row.Title, "/requests");
        return (DecisionOutcome.Done, row.Status);
    }

    private async Task GrabAsync(string id, CancellationToken ct)
    {
        if (!activeGrabs.TryAdd(id, 0)) return;
        try { await GrabCoreAsync(id, ct); }
        finally { activeGrabs.TryRemove(id, out _); }
    }

    private async Task GrabCoreAsync(string id, CancellationToken ct, bool retry = false)
    {
        RequestGrabOutcome outcome;
        try
        {
            await using var read = await factory.CreateDbContextAsync(ct);
            var row = await read.MediaRequests.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id, ct);
            if (row is null || (retry
                ? row.Status is not (MediaRequestStatus.Partial or MediaRequestStatus.Failed)
                : row.Status != MediaRequestStatus.Approved || !string.IsNullOrEmpty(row.GrabbedHashes))) return;
            outcome = await grabber.GrabAsync(row, ct);
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
            current.DecisionReason = retry ? null : current.DecisionReason;
            await db.SaveChangesAsync(CancellationToken.None);
            return;
        }
        if (outcome.Hashes.Count == 0)
        {
            logger.LogInformation("Approved request {Id} started no download: {Problem}", id, outcome.Problem);
            current.Status = string.IsNullOrEmpty(current.GrabbedHashes) ? MediaRequestStatus.Failed : MediaRequestStatus.Partial;
            current.DecisionReason = current.Status == MediaRequestStatus.Partial
                ? PartialReason : NoDownloadReason;
            await db.SaveChangesAsync(CancellationToken.None);
            await notifications.TryPublishAsync(current.RequestedByUserId, NotificationKind.RequestFailed,
                current.Status == MediaRequestStatus.Partial ? "Request partly started" : "Request could not be downloaded",
                $"{current.Title}: {current.DecisionReason}", "/requests");
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
            return;
        }
        current.Status = MediaRequestStatus.Approved;
        if (retry) current.DecisionReason = null;
        await db.SaveChangesAsync(CancellationToken.None);
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
        await AttachAsync(db, row, [hash], announce: true, ct);
        return (DecisionOutcome.Done, row.Status);
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
        row.Status = MediaRequestStatus.Approved;
        row.DecisionReason = null;
        row.UpdatedAt = time.GetUtcNow().UtcDateTime;
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
            .Where(r => r.Status == MediaRequestStatus.Approved).Select(r => new { r.Id, r.GrabbedHashes, r.DecisionReason }).ToListAsync(ct);
        foreach (var row in rows)
        {
            // Grabbing a request the owner stopped part of would bring back the episodes he removed.
            if (string.IsNullOrEmpty(row.GrabbedHashes)) { if (!RequestWantedObserver.OwnerStopped(row.DecisionReason)) await GrabAsync(row.Id, ct); }
            else await CheckFulfilledAsync(row.Id, ct);
        }
    }

    private async Task CheckFulfilledAsync(string id, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var row = await db.MediaRequests.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (row is null || row.Status != MediaRequestStatus.Approved || string.IsNullOrEmpty(row.GrabbedHashes)) return;
        // Episodes (or the film) the wanted queue is still looking for keep the request open.
        var wanted = db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkKey == row.WorkKey &&
            t.Status == "queued" && t.InfoHash == null);
        var seasons = RequestRules.ParseSeasons(row.Seasons).ToArray();
        wanted = row.Scope == MediaRequestScope.Movie ? wanted.Where(t => t.Scope == "title")
            : row.Scope == MediaRequestScope.Series || seasons.Length == 0 ? wanted.Where(t => t.Scope == "episode")
            : wanted.Where(t => t.Scope == "episode" && t.Season != null && seasons.Contains(t.Season.Value));
        if (await wanted.AnyAsync(ct)) return;
        foreach (var hash in row.GrabbedHashes.Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!await transfers.CompletedAsync(hash, ct)) return;
        }
        row.Status = MediaRequestStatus.Fulfilled;
        row.UpdatedAt = time.GetUtcNow().UtcDateTime;
        var changed = await db.MediaRequests.Where(r => r.Id == id && r.Status == MediaRequestStatus.Approved)
            .ExecuteUpdateAsync(update => update.SetProperty(r => r.Status, MediaRequestStatus.Fulfilled)
                .SetProperty(r => r.UpdatedAt, row.UpdatedAt), ct);
        if (changed == 0) return;
        await notifications.TryPublishAsync(row.RequestedByUserId, NotificationKind.RequestFulfilled, "Request fulfilled", row.Title, "/library");
    }
}

/// <summary>Moves approved requests to fulfilled when the engine reports their transfers complete.</summary>
public sealed class RequestFulfillmentWatcher(ITorrentEngine engine, RequestDecisionService decisions, ILogger<RequestFulfillmentWatcher> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        void OnCompleted(object? sender, EngineTorrentCompletedEventArgs e) => _ = Task.Run(async () =>
        {
            try { await decisions.OnTorrentCompletedAsync(e.Hash, stoppingToken); }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested) { logger.LogWarning(ex, "Request fulfillment check failed for {Hash}", e.Hash); }
        }, CancellationToken.None);

        engine.TorrentCompleted += OnCompleted;
        try
        {
            try { await decisions.SweepAsync(stoppingToken); }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested) { logger.LogWarning(ex, "Request fulfillment sweep failed"); }
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException) { }
        finally
        {
            engine.TorrentCompleted -= OnCompleted;
        }
    }
}
