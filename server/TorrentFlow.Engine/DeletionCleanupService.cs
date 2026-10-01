using Microsoft.Extensions.Hosting;

namespace TorrentFlow.Engine;

/// <summary>Runs the deletion cleanup worker: deletes left from before a restart first, then each new delete.</summary>
internal sealed class DeletionCleanupService(TorrentEngineService engine) : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken) => engine.RunDeletionCleanupAsync(stoppingToken);
}
