using TorrentFlow.Core;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Search;
using static TorrentFlow.Search.EpisodeParser;

namespace TorrentFlow.Search;

public sealed record WorkMatchTarget(string Title, int? Year = null, bool IsSeries = false);

public static class WorkIdentityParser
{
    public static bool CatalogAgrees(string releaseName, string catalogTitle)
    {
        var a = ReleaseNames.NormalizeKey(releaseName); var b = ReleaseNames.NormalizeKey(catalogTitle);
        if (a.Length == 0 || b.Length == 0) return false;
        if (a == b) return true;
        if (!b.Contains(a)) return false;
        return ReleaseNames.NormalizeKey(Regex.Split(catalogTitle, @":\s*|\s+[-–—]\s+")[0]) != a;
    }
    public static bool MetadataAgrees(string releaseName, MediaMetadata? metadata)
    {
        if (string.IsNullOrWhiteSpace(metadata?.Title)) return false;
        if (CatalogAgrees(releaseName, metadata.Title)) return true;
        var release = ReleaseNames.NormalizeKey(releaseName);
        if (metadata.Aliases?.Any(alias => ReleaseNames.NormalizeKey(alias) == release) == true) return true;
        if (!AnimeIdentity.IsAnime(metadata) || string.IsNullOrWhiteSpace(metadata.ExternalId) || metadata.ExternalId.Trim() == "0" || ReleaseEpisodeParser.SpecialType(releaseName) != null || release.Split(' ').Length < 4) return false;
        string[] stop = ["the", "that", "this", "with", "from", "season", "series", "part"];
        var tokens = release.Split(' ').Where(t => t.Length >= 5 && !stop.Contains(t)).ToHashSet();
        return ReleaseNames.NormalizeKey(metadata.Title).Split(' ').Any(t => t.Length >= 5 && !stop.Contains(t) && tokens.Contains(t));
    }
    /// <summary>workIdentity(title, metadata): the release's identity, named and keyed by the catalog title when it agrees.</summary>
    public static ReleaseIdentity Parse(string title, MediaMetadata? metadata = null)
    {
        var identity = ReleaseNames.WorkIdentity(title);
        return MetadataAgrees(identity.Name, metadata) ? identity.Renamed(metadata!.Title.Trim()) : identity;
    }
    public static bool Matches(string releaseTitle, WorkMatchTarget target)
    {
        if (string.IsNullOrWhiteSpace(target.Title) || target.IsSeries || string.IsNullOrWhiteSpace(releaseTitle)) return true;
        var identity = Parse(releaseTitle.Trim());
        if (identity.IsSeries) return false;
        if (target.Year is >= 1900 and <= 2200 && identity.Year != null && Math.Abs(identity.Year.Value - target.Year.Value) > 1) return false;
        if (CatalogAgrees(identity.Name, target.Title)) return true;
        var a = ReleaseNames.NormalizeKey(identity.Name); var b = ReleaseNames.NormalizeKey(target.Title);
        if (a.Length == 0 || b.Length == 0 || !a.StartsWith(b)) return false;
        if (a.Length == b.Length) return true;
        var rest = identity.Name.Trim()[Math.Min(target.Title.Trim().Length, identity.Name.Trim().Length)..];
        return (rest.Length == 0 || Match(rest, @"^[\s:._\-–—]").Success) && !Match(rest, @"^\s*(?::|[-–—]\s)").Success;
    }
}
