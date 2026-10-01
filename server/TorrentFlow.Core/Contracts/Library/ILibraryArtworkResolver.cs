namespace TorrentFlow.Core.Contracts.Library;

/// <summary>Optional bounded artwork fallback for title pages. Metadata may override Library's empty default.</summary>
public interface ILibraryArtworkResolver
{
    Task<LibraryArtwork> ResolveAsync(string title, int? year, string? mediaType, CancellationToken cancellationToken);

    /// <summary>
    /// The provider title the page's artwork and details come from (a TMDB match by title and year), or null without a
    /// confident match. Unverified: the caller checks the provider's own record before naming a title by it.
    /// </summary>
    Task<(string Provider, string ProviderId)?> ResolveIdentityAsync(string title, int? year, string mediaType, CancellationToken cancellationToken) =>
        Task.FromResult<(string, string)?>(null);
}

public sealed record LibraryArtwork(string? PosterUrl, string? BackdropUrl);
