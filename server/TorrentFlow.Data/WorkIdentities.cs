using System.Globalization;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Data;

/// <summary>What two sets of catalog ids say about two records: the same work, different works, or nothing either way.</summary>
public enum IdentityMatch { Unknown, Same, Different }

/// <summary>
/// The one test of whether a catalog record is a stored work. A work is known by its own provider id, its canonical ids
/// (<see cref="Work.IdsJson"/>) and its verified, unrejected links; search and the title POST both decide with
/// <see cref="Compare"/>, so a card, a page and a download never disagree about which work a record is.
/// </summary>
public static class WorkIdentities
{
    /// <summary>One id as "provider:id"; Cinemeta's ids are IMDb's.</summary>
    public static string Id(string provider, string id)
    {
        var name = provider.Trim().ToLowerInvariant();
        return $"{(name == "cinemeta" ? "imdb" : name)}:{id.Trim().ToLowerInvariant()}";
    }

    /// <summary>Every id of a record: its own provider id, its canonical ids and the given verified links.</summary>
    public static HashSet<string> Of(WorkIds? ids, string? provider = null, string? providerId = null, IEnumerable<WorkLink>? links = null)
    {
        static string S(int n) => n.ToString(CultureInfo.InvariantCulture);
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (!string.IsNullOrWhiteSpace(provider) && !string.IsNullOrWhiteSpace(providerId)) set.Add(Id(provider, providerId));
        if (ids?.Tmdb is { } tmdb) set.Add(Id("tmdb", S(tmdb)));
        if (ids?.AniList is { } anilist) set.Add(Id("anilist", S(anilist)));
        if (ids?.Mal is { } mal) set.Add(Id("mal", S(mal)));
        if (ids?.Imdb is { Length: > 0 } imdb) set.Add(Id("imdb", imdb));
        foreach (var link in links ?? [])
            if (link.Verified && !link.Rejected && !string.IsNullOrWhiteSpace(link.ExternalId)) set.Add(Id(link.Provider, link.ExternalId));
        return set;
    }

    /// <summary>A stored work's ids, its loaded links included.</summary>
    public static HashSet<string> Of(Work work) => Of(work.ReadIds(), work.Provider, work.ProviderId, work.Links);

    /// <summary>
    /// Same when any id is shared; different when both carry an id from one catalog and none is shared (tmdb:100 is not
    /// tmdb:200); unknown when no catalog is common to both.
    /// </summary>
    public static IdentityMatch Compare(IReadOnlySet<string> stored, IReadOnlySet<string> claim)
    {
        if (stored.Overlaps(claim)) return IdentityMatch.Same;
        var catalogs = stored.Select(Catalog).ToHashSet(StringComparer.OrdinalIgnoreCase);
        return claim.Any(c => catalogs.Contains(Catalog(c))) ? IdentityMatch.Different : IdentityMatch.Unknown;
    }

    private static string Catalog(string id) => id[..Math.Max(0, id.IndexOf(':'))];
}
