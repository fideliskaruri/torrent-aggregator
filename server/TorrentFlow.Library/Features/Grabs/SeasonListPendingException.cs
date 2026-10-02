namespace TorrentFlow.Library.Features.Grabs;

/// <summary>
/// An anime episode whose show, season and episode the sequel chain cannot confidently say yet (AniList cut the walk
/// short or did not answer): it must not be sent, or it would land in the entry's own folder under the wrong season.
/// </summary>
public sealed class SeasonListPendingException(string message, Exception? inner = null) : Exception(message, inner);
