using System.Threading.Channels;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;

namespace TorrentFlow.Api.Notifications;

public sealed class DownloadNotificationWatcher(ITorrentEngine engine, NotificationService notifications) : BackgroundService
{
    private readonly Channel<(string Kind, string Title, string Body)> _events =
        Channel.CreateUnbounded<(string Kind, string Title, string Body)>(new UnboundedChannelOptions { SingleReader = true });

    public override Task StartAsync(CancellationToken cancellationToken)
    {
        engine.TorrentCompleted += Completed;
        engine.TorrentFailed += Failed;
        return base.StartAsync(cancellationToken);
    }

    private void Completed(object? sender, EngineTorrentCompletedEventArgs e)
    {
        if (e.Origin == TorrentOrigin.User) _events.Writer.TryWrite((NotificationKind.DownloadCompleted, "Download completed", e.Name));
    }

    private void Failed(object? sender, EngineTorrentFailedEventArgs e)
    {
        if (e.Origin == TorrentOrigin.User) _events.Writer.TryWrite((NotificationKind.DownloadFailed, "Download failed", e.Name));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var e in _events.Reader.ReadAllAsync(stoppingToken))
                await notifications.TryPublishAsync(LocalUser.Id, e.Kind, e.Title, e.Body, "/downloads");
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally
        {
            engine.TorrentCompleted -= Completed;
            engine.TorrentFailed -= Failed;
            _events.Writer.TryComplete();
        }
    }
}
