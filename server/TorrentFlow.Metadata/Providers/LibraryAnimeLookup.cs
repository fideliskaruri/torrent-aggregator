using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Metadata;

namespace TorrentFlow.Metadata.Providers;

/// <summary>AniList search for Library's guarded episode alias recovery (TS searchAniList(title, 5)).</summary>
internal sealed class LibraryAnimeLookup(AniListClient anilist) : ILibraryAnimeLookup
{
    public async Task<IReadOnlyList<MediaMetadata>> SearchAsync(string title, int limit, CancellationToken cancellationToken) =>
        await anilist.SearchAsync(title, limit, cancellationToken).ConfigureAwait(false);
}
