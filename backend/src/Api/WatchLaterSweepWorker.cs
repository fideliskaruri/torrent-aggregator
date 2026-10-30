using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Api;

internal sealed class WatchLaterSweepWorker(IServiceScopeFactory scopes, ILogger<WatchLaterSweepWorker> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await SweepSafelyAsync(stoppingToken);
        using var timer = new PeriodicTimer(TimeSpan.FromHours(24));
        while (await timer.WaitForNextTickAsync(stoppingToken))
            await SweepSafelyAsync(stoppingToken);
    }

    private async Task SweepSafelyAsync(CancellationToken ct)
    {
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var watchLater = scope.ServiceProvider.GetRequiredService<WatchLaterReadService>();
            var notifications = scope.ServiceProvider.GetRequiredService<NotificationRepository>();
            var entries = await watchLater.ReadAllAsync(ct);
            var published = 0;
            // Only titles that came out after they were saved: telling someone a film they just saved is out is noise.
            foreach (var entry in entries.Where(entry => entry.Item.State == "available" &&
                entry.OutSince is { } outSince && outSince > entry.SavedAt))
            {
                var body = $"{entry.Item.Title} is out. Download it?";
                if (body.Length > 500) body = body[..500];
                if (await notifications.PublishAsync(new NotificationRow
                    {
                        Id = Guid.NewGuid().ToString("N"),
                        UserId = entry.UserId,
                        Kind = "watch-later.out",
                        Title = "Watchlist",
                        Body = body,
                        Link = "/title/" + Uri.EscapeDataString(entry.Item.WorkKey),
                        DedupeKey = $"watch-later:{entry.Item.WatchItemId}:out",
                        CreatedAt = DateTimeOffset.UtcNow,
                        ReadAt = null,
                        PushPending = false,
                        PushAttemptAt = null,
                        PushAttempts = 0,
                    }, ct))
                    published++;
            }
            logger.LogInformation("Watchlist sweep completed. Published {Count} notifications.", published);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning(ex, "The watchlist sweep failed. It will retry on the next daily pass.");
        }
    }
}
