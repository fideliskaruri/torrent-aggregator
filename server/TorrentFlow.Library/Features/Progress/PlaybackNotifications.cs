using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Library;

namespace TorrentFlow.Library.Features.Progress;

public sealed class PlaybackNotifications(ILibraryPlaybackObserver observer, ILogger<PlaybackNotifications> logger) : BackgroundService
{
    private readonly Channel<LibraryPlaybackUpdate> queue = Channel.CreateBounded<LibraryPlaybackUpdate>(
        new BoundedChannelOptions(32) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
    public void Publish(LibraryPlaybackUpdate update) => queue.Writer.TryWrite(update);
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var update in queue.Reader.ReadAllAsync(stoppingToken))
        {
            try { await observer.OnProgressAsync(update, stoppingToken); }
            catch (Exception error) when (!stoppingToken.IsCancellationRequested) { logger.LogWarning(error, "Playback observer failed"); }
        }
    }
}

internal sealed class DefaultPlaybackObserver : ILibraryPlaybackObserver
{
    public Task OnProgressAsync(LibraryPlaybackUpdate update, CancellationToken cancellationToken) => Task.CompletedTask;
}
