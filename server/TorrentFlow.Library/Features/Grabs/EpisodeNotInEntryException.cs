namespace TorrentFlow.Library.Features.Grabs;

/// <summary>
/// An episode a later anime entry does not have, by its confirmed season shape (the one after Attack on Titan Season 3
/// Part 2's last, Season 3 episode 23). Nothing is searched: the grab reads as not found, so the library hunter backs
/// off as it does for any episode that is not out, instead of holding it as if the season list were unknown.
/// </summary>
public sealed class EpisodeNotInEntryException(string message) : Exception(message);
