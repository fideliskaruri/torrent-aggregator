namespace TorrentFlow.Core.Contracts.Library;

/// <summary>Optional bounded artwork fallback for title pages. Metadata may override Library's empty default.</summary>
public interface ILibraryArtworkResolver
{
    Task<LibraryArtwork> ResolveAsync(string title, int? year, string? mediaType, CancellationToken cancellationToken);
}

public sealed record LibraryArtwork(string? PosterUrl, string? BackdropUrl);
