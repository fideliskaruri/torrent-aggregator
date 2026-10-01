using System.Globalization;
using TorrentFlow.Core.Contracts.Library;

namespace TorrentFlow.Metadata.Artwork;

/// <summary>Library title-page fallback backed by the shared artwork resolver (TS resolveArtworkBestEffort's inner call).</summary>
internal sealed class LibraryArtworkResolver(ArtworkResolver resolver) : ILibraryArtworkResolver
{
    public async Task<LibraryArtwork> ResolveAsync(string title, int? year, string? mediaType, CancellationToken cancellationToken)
    {
        var result = await resolver.ResolveAsync(new ArtworkQuery(title, year, mediaType), cancellationToken).ConfigureAwait(false);
        return new LibraryArtwork(result.PosterUrl, result.BackdropUrl);
    }

    /// <summary>The same TMDB match the title page's details use (TitleExtrasService), so the id and what the page shows agree.</summary>
    public async Task<(string Provider, string ProviderId)?> ResolveIdentityAsync(string title, int? year, string mediaType, CancellationToken cancellationToken) =>
        await resolver.ResolveTmdbRefAsync(new ArtworkQuery(title, year, mediaType), cancellationToken).ConfigureAwait(false) is { } found &&
        found.MediaType == mediaType
            ? ("tmdb", found.Id.ToString(CultureInfo.InvariantCulture))
            : null;
}
