using TorrentFlow.Core.Contracts.Metadata;

namespace TorrentFlow.Core.Contracts.Library;

/// <summary>
/// Optional anime catalog search used by Library's guarded alias recovery for episode grabs.
/// Library's default returns nothing; Metadata overrides it with AniList.
/// </summary>
public interface ILibraryAnimeLookup
{
    Task<IReadOnlyList<MediaMetadata>> SearchAsync(string title, int limit, CancellationToken cancellationToken);
}
