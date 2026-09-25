using TorrentFlow.Core.Contracts.Library;

namespace TorrentFlow.Library.Features.Titles;

internal sealed class DefaultArtworkResolver : ILibraryArtworkResolver
{
    public Task<LibraryArtwork> ResolveAsync(string title, int? year, string? mediaType, CancellationToken cancellationToken) =>
        Task.FromResult(new LibraryArtwork(null, null));
}
