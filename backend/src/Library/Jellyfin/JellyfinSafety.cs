using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Library.Jellyfin;

public interface IJellyfinOwnedStateReader
{
    Task<JellyfinTitleState?> ReadAsync(WorkSnapshot work, ImmutableArray<MediaFileRow> files,
        CancellationToken ct);
}

public enum JellyfinPlaybackReadStatus { NotConfigured, Available, NotAdmin, Unavailable }

public sealed record JellyfinPlaybackRead(JellyfinPlaybackReadStatus Status,
    ImmutableArray<string> PlayingPaths);

public interface IJellyfinPlaybackGuard
{
    Task<JellyfinPlaybackRead> ReadAsync(CancellationToken ct);
}

public sealed class JellyfinDeleteRefusedException(string message, string reason) : Exception(message)
{
    /// <summary>"playing" can never be overridden; "playback-unknown" can, with an explicit confirmation.</summary>
    public string Reason { get; } = reason;
}
