using TorrentFlow.Core.Contracts.Library;

namespace TorrentFlow.Media.Features.Prewarm;

/// <summary>
/// Library's playback hook (TS progress route → <c>onPlaybackProgress</c>). Library publishes after the progress row is
/// written and drains the queue off the request path, so prewarm never delays or fails a progress ping.
/// </summary>
internal sealed class PrewarmPlaybackObserver(PrewarmService prewarm) : ILibraryPlaybackObserver
{
    public Task OnProgressAsync(LibraryPlaybackUpdate update, CancellationToken cancellationToken) =>
        prewarm.OnPlaybackProgressAsync(new PrewarmService.PlaybackContext
        {
            UserId = update.UserId, InfoHash = update.InfoHash, Title = update.Title, Season = update.Season, Episode = update.Episode,
            WatchListItemId = update.WatchListItemId, PositionSec = update.PositionSec, DurationSec = update.DurationSec,
        }, ct: cancellationToken);
}
