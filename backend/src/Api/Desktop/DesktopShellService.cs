using System.Diagnostics;
using TorrentFlow.Domain;
using TorrentFlow.Targets;

namespace TorrentFlow.Api.Desktop;

public sealed class DesktopShellService(DesktopEnvironment desktop, TargetPipeline targets,
    IHostApplicationLifetime lifetime, ILogger<DesktopShellService> logger) : IHostedService
{
    private TrayIcon? tray;
    public async Task StartAsync(CancellationToken ct)
    {
        if (!desktop.IsDesktop || !OperatingSystem.IsWindows()) return;
        tray = new TrayIcon("TorrentFlow",
            [new("Open TorrentFlow", Open, true), null,
                new("Pause all downloads", () => Run(TargetAction.Pause)),
                new("Resume all downloads", () => Run(TargetAction.Resume)),
                null, new("Quit TorrentFlow", lifetime.StopApplication)],
            Open, lifetime.StopApplication, logger);
        try { await tray.StartAsync().WaitAsync(TimeSpan.FromSeconds(10), ct); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        { logger.LogWarning(ex, "Running without a tray icon."); }
    }

    public Task StopAsync(CancellationToken ct)
    {
        if (OperatingSystem.IsWindows()) tray?.Dispose();
        tray = null;
        return Task.CompletedTask;
    }

    private void Open()
    {
        try { Process.Start(new ProcessStartInfo(desktop.BrowserUrl) { UseShellExecute = true })?.Dispose(); }
        catch (Exception ex) { logger.LogWarning(ex, "Could not open the browser."); }
    }

    private void Run(TargetAction action) => _ = Task.Run(async () =>
    {
        try
        {
            await targets.BulkActionAsync(action, lifetime.ApplicationStopping);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        { logger.LogWarning(ex, "Tray action failed."); }
    });
}
