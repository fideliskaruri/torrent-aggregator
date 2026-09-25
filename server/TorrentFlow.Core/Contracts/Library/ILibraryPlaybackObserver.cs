namespace TorrentFlow.Core.Contracts.Library;

/// <summary>Optional Media hook. Library progress writes never depend on speculative playback work.</summary>
public interface ILibraryPlaybackObserver
{
    Task OnProgressAsync(LibraryPlaybackUpdate update, CancellationToken cancellationToken);
}

public sealed record LibraryPlaybackUpdate(string UserId, string InfoHash, string Title, int? Season,
    int? Episode, string? WatchListItemId, double PositionSec, double DurationSec);
