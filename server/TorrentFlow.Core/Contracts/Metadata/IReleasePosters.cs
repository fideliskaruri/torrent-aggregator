namespace TorrentFlow.Core.Contracts.Metadata;

/// <summary>
/// Posters for things known only by a release name (a transfer or notification with no linked work). The one server
/// place that turns a release name into a poster, so the web does not look art up itself.
/// </summary>
public interface IReleasePosters
{
    /// <summary>Poster per release name (names with no art are absent). Values are a media-type hint or null.</summary>
    Task<IReadOnlyDictionary<string, string>> ForReleasesAsync(IReadOnlyDictionary<string, string?> releases, CancellationToken ct = default);
}