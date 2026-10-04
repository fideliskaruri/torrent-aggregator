using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Api.Notifications;

internal sealed class NotificationWorker(ITargetEvents events, IServiceScopeFactory scopes,
    ILogger<NotificationWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await using var reader = events.ReadAllAsync(stoppingToken).GetAsyncEnumerator(stoppingToken);
        var next = reader.MoveNextAsync().AsTask();
        // Persisted pending deliveries survive restarts; one notification worker owns both paths.
        var tick = Task.Delay(TimeSpan.Zero, stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            var ready = await Task.WhenAny(next, tick);
            System.Collections.Immutable.ImmutableArray<StoreRow> changes = [];
            if (ready == next)
            {
                if (!await next) return;
                changes = reader.Current;
                next = reader.MoveNextAsync().AsTask();
            }
            else tick = Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<NotificationRepository>();
                var works = await db.AllAsync<WorkRow>(stoppingToken);
                foreach (var target in changes.OfType<TargetRow>())
                {
                    var completed = target.State == TargetState.Done;
                    var failed = target.State == TargetState.Waiting && target.ReasonCode == WaitReason.OwnerPickRequired;
                    if (!completed && !failed) continue;
                    var work = works.SingleOrDefault(w => w.Id == target.WorkId);
                    var title = work is null ? "Your download" :
                        NotificationReadModels.Title(work, await db.AllAsync<WorkNameRow>(stoppingToken));
                    var n = new NotificationRow { Id = Guid.NewGuid().ToString("N"), UserId = target.CreatedBy, Kind = completed ? "download.completed" : "download.failed", Title = completed ? $"{title} is ready" : $"Pick a release for {title}", Body = completed ? title : target.ReasonText ?? "No working release was found. Pick a release yourself.", Link = work is null ? "/downloads" : "/title/" + Uri.EscapeDataString(work.WorkKey), DedupeKey = $"{target.Id}:{(completed ? "done" : "help")}:{target.ClickedAt:O}", CreatedAt = DateTimeOffset.UtcNow, ReadAt = null, PushPending = true, PushAttemptAt = null, PushAttempts = 0 };
                    await db.PublishAsync(n with { Title = Clip(n.Title, 200)!, Body = Clip(n.Body, 500) }, stoppingToken);
                }
                foreach (var download in changes.OfType<DownloadRow>().Where(d => d.FinishedAt is not null))
                {
                    var links = await db.AllAsync<DownloadTargetRow>(stoppingToken);
                    if (links.Any(l => l.DownloadId == download.Id)) continue;
                    var release = (await db.AllAsync<ReleaseRow>(stoppingToken)).SingleOrDefault(r => r.Id == download.Hash);
                    await db.PublishAsync(new NotificationRow
                    {
                        Id = Guid.NewGuid().ToString("N"),
                        UserId = "local",
                        Kind = "download.completed",
                        Title = "Download ready",
                        Body = Clip(NotificationReadModels.ReleaseTitle(release), 500),
                        Link = "/downloads?hash=" + download.Hash,
                        DedupeKey = "download:" + download.Id,
                        CreatedAt = DateTimeOffset.UtcNow,
                        ReadAt = null,
                        PushPending = true,
                        PushAttemptAt = null,
                        PushAttempts = 0,
                    }, stoppingToken);
                }
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            { logger.LogWarning(ex, "Could not publish target notifications."); }
        }
    }

    private static string? Clip(string? value, int max) => value is null || value.Length <= max ? value : value[..max];
}
