using Microsoft.EntityFrameworkCore;
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
    ILogger<RequestDecisionService> logger)
{
    public const int MaxReasonLength = 500;
    /// <summary>What a requester reads when nothing could be started; the indexer detail stays in the owner's log.</summary>
    public const string NoDownloadReason = "No download could be found for this yet.";

    /// <summary>The last grab an approval started; tests await it.</summary>
    internal Task LastGrab { get; private set; } = Task.CompletedTask;

    public async Task<(DecisionOutcome Outcome, string? Status)> ApproveAsync(string id, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var row = await db.MediaRequests.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (row is null) return (DecisionOutcome.NotFound, null);
        if (row.Status != MediaRequestStatus.Pending) return (DecisionOutcome.NotPending, row.Status);
        var now = time.GetUtcNow().UtcDateTime;
        row.Status = MediaRequestStatus.Approved;
        row.DecisionReason = null;
        row.DecidedAt = now;
        row.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
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
        await db.SaveChangesAsync(ct);
        return (DecisionOutcome.Done, row.Status);
    }

    private async Task GrabAsync(string id, CancellationToken ct)
    {
        RequestGrabOutcome outcome;
        try
        {
            await using var read = await factory.CreateDbContextAsync(ct);
            var row = await read.MediaRequests.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id, ct);
            if (row is null || row.Status != MediaRequestStatus.Approved) return;
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
        if (current is null || current.Status != MediaRequestStatus.Approved) return;
        current.UpdatedAt = time.GetUtcNow().UtcDateTime;
        if (outcome.Hashes.Count == 0)
        {
            logger.LogInformation("Approved request {Id} started no download: {Problem}", id, outcome.Problem);
            current.Status = MediaRequestStatus.Failed;
            current.DecisionReason = NoDownloadReason;
            await db.SaveChangesAsync(CancellationToken.None);
            return;
        }
        current.GrabbedHashes = string.Join(',', outcome.Hashes.Select(h => h.ToLowerInvariant()).Distinct());
        await db.SaveChangesAsync(CancellationToken.None);
        await CheckFulfilledAsync(id, CancellationToken.None);
    }

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
        var ids = await db.MediaRequests.AsNoTracking()
            .Where(r => r.Status == MediaRequestStatus.Approved && r.GrabbedHashes != null).Select(r => r.Id).ToListAsync(ct);
        foreach (var id in ids) await CheckFulfilledAsync(id, ct);
    }

    private async Task CheckFulfilledAsync(string id, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var row = await db.MediaRequests.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (row is null || row.Status != MediaRequestStatus.Approved || string.IsNullOrEmpty(row.GrabbedHashes)) return;
        foreach (var hash in row.GrabbedHashes.Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!await transfers.CompletedAsync(hash, ct)) return;
        }
        row.Status = MediaRequestStatus.Fulfilled;
        row.UpdatedAt = time.GetUtcNow().UtcDateTime;
        await db.SaveChangesAsync(ct);
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
