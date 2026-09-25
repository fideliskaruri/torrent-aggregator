using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace TorrentFlow.Engine;

/// <summary>Rehydrates the queue at startup, then persists progress / finalises completions on a fixed cadence.</summary>
internal sealed class EngineMonitorService(TorrentEngineService engine, IOptionsMonitor<EngineOptions> options, ILogger<EngineMonitorService> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await engine.RehydrateAsync(stoppingToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "Engine rehydrate failed");
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(options.CurrentValue.MonitorIntervalSeconds), stoppingToken);
                await engine.TickAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Engine monitor tick failed");
            }
        }
    }
}
