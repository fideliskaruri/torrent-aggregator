using System.Diagnostics;
using TorrentFlow.Core.Contracts.Engine;

namespace TorrentFlow.Api.Desktop;

/// <summary>Tray icon for the Windows desktop app: Open, Pause all, Resume all, Quit.</summary>
public sealed class DesktopShellService(
    DesktopEnvironment desktop,
    ITorrentEngine engine,
    IHostApplicationLifetime lifetime,
    ILogger<DesktopShellService> logger) : IHostedService
{
    private IDisposable? _tray;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (!desktop.IsDesktop || !OperatingSystem.IsWindows()) return;
        var tray = new TrayIcon(
            "TorrentFlow",
            [
                new TrayIcon.MenuItem("Open TorrentFlow", Open, IsDefault: true),
                null,
                new TrayIcon.MenuItem("Pause all downloads", () => Run(PauseAllAsync)),
                new TrayIcon.MenuItem("Resume all downloads", () => Run(ResumeAllAsync)),
                null,
                new TrayIcon.MenuItem("Quit TorrentFlow", Quit),
            ],
            Open,
            Quit,
            logger);
        _tray = tray;
        try
        {
            await tray.StartAsync().WaitAsync(TimeSpan.FromSeconds(10), cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // No tray (e.g. no interactive desktop) must not stop the server.
            logger.LogWarning("Running without a tray icon: {Message}", ex.Message);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _tray?.Dispose();
        _tray = null;
        return Task.CompletedTask;
    }

    private void Open()
    {
        try { Process.Start(new ProcessStartInfo(desktop.BrowserUrl) { UseShellExecute = true })?.Dispose(); }
        catch (Exception ex) { logger.LogWarning("Could not open the browser: {Message}", ex.Message); }
    }

    private void Quit()
    {
        logger.LogInformation("Quit requested from the tray.");
        lifetime.StopApplication();
    }

    private void Run(Func<CancellationToken, Task<int>> action) =>
        _ = Task.Run(async () =>
        {
            try
            {
                var count = await action(lifetime.ApplicationStopping);
                logger.LogInformation("Tray action changed {Count} download(s).", count);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Tray action failed");
            }
        });

    /// <summary>Kept downloads that are transferring or waiting; streams/prewarm caches and finished files are left alone.</summary>
    internal static bool CanPause(EngineTorrentInfo t) =>
        t.RetentionState is not ("stream" or "prewarm") && t.State is not ("paused" or "downloaded" or "error");

    internal static bool CanResume(EngineTorrentInfo t) => t.RetentionState is not ("stream" or "prewarm") && t.State == "paused";

    internal async Task<int> PauseAllAsync(CancellationToken ct)
    {
        var changed = 0;
        foreach (var t in (await engine.ListAsync(ct)).Where(CanPause))
            if ((await engine.PauseAsync(t.Hash, ct)).Ok) changed++;
        return changed;
    }

    internal async Task<int> ResumeAllAsync(CancellationToken ct)
    {
        var changed = 0;
        foreach (var t in (await engine.ListAsync(ct)).Where(CanResume))
            if ((await engine.ResumeAsync(t.Hash, ct)).Ok) changed++;
        return changed;
    }
}
