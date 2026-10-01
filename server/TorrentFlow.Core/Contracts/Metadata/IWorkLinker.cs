namespace TorrentFlow.Core.Contracts.Metadata;

/// <summary>One crosswalk row of a work as the title page lists it.</summary>
public sealed record WorkLinkView(string Provider, string ExternalId, string? MediaType, int? Season, string Source,
    double Confidence, bool Verified, bool Rejected, bool GivesNames, IReadOnlyList<string> Names, string? Url);

/// <summary>
/// Links a work to its records at other providers (AniList, TMDB, MAL, IMDb) through the crosswalk, and lets the owner
/// undo a link. Linking runs once per work and again only when the anime-lists map changes; it never throws for a
/// provider or map failure.
/// </summary>
public interface IWorkLinker
{
    /// <summary>Links this work unless it was already linked against the current map. Cancel to bound it.</summary>
    Task LinkAsync(string workKey, CancellationToken ct);

    /// <summary>This work's links, rejected ones included; null when there is no such work.</summary>
    Task<IReadOnlyList<WorkLinkView>?> ListAsync(string workKey, CancellationToken ct);

    /// <summary>Rejects a link for good and removes its ids and names. False when there is no such link.</summary>
    Task<bool> UnlinkAsync(string workKey, string provider, string externalId, CancellationToken ct);
}
