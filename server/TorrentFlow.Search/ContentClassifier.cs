using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Metadata;

namespace TorrentFlow.Search;

/// <summary>Search-side naming over the Core rules: the user category label for a kind, and a release's show folder.</summary>
public static class ContentClassifier
{
    public static string CategoryLabel(string kind, string[]? categories)
    {
        string[] aliases = kind switch
        {
            "anime" => ["Anime", "アニメ", "animation"], "movies" => ["Movies", "Movie", "Films", "Film", "Cinema"],
            "tv" => ["TV", "Television", "Series", "Shows", "TV Shows"], "music" => ["Music", "Audio", "FLAC", "MP3", "Albums"],
            "games" => ["Games", "Gaming", "PC Games", "Nintendo", "Xbox", "PS4", "PS5"], "software" => ["Software", "Apps", "Applications", "Programs"],
            "books" => ["Books", "eBooks", "Ebook", "Comics", "Manga"], _ => ["Other", "Misc", "General"]
        };
        foreach (var alias in aliases)
            if (categories?.FirstOrDefault(c => c.Equals(alias, StringComparison.OrdinalIgnoreCase)) is { } exact) return exact;
        foreach (var alias in aliases)
            if (categories?.FirstOrDefault(c => c.Contains(alias, StringComparison.OrdinalIgnoreCase)) is { } partial) return partial;
        return aliases[0];
    }
    /// <summary>
    /// A show folder read from a release name (Core <see cref="ReleaseNames.ShowFolder"/>, keeping a "Part N" or "Cour N"),
    /// named by the enriched catalog title when it is the same show. Catalog grabs name the folder from the work instead.
    /// </summary>
    public static string ShowFolder(string title, MediaMetadata? metadata = null)
    {
        var clean = ReleaseNames.ShowFolder(title, keepPartNumber: true);
        if (!string.IsNullOrWhiteSpace(metadata?.Title))
        {
            var metaFolder = ReleaseNames.SanitizeFolderName(metadata.Title);
            var a = ContentKinds.MatchKey(clean.Length > 0 ? clean : ReleaseNames.CutAtStructure(title)); var b = ContentKinds.MatchKey(metaFolder);
            if (a.Length > 0 && b.Length > 0 && (a == b || a.Contains(b) || b.Contains(a) || WorkIdentityParser.MetadataAgrees(clean, metadata))) return metaFolder;
        }
        return clean;
    }
}
