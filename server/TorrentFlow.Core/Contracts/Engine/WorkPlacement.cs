using TorrentFlow.Core;

namespace TorrentFlow.Core.Contracts.Engine;

/// <summary>
/// The catalog work a download belongs to. When a send names its work, the folder is built from this (the English
/// catalog title and the catalog's own season), never from the torrent's name.
/// </summary>
/// <param name="Title">The title the UI shows for the work.</param>
/// <param name="Season">The catalog season (an AniList "2nd Season" entry is season 2 of its show); null for films.</param>
public sealed record WorkPlacement(string Title, int? Year, bool Anime, bool Film, int? Season);

/// <summary>Folder names shared by every save path.</summary>
public static class MediaFolders
{
    /// <summary>Anime splits into two flat libraries under the download root, series and films, never nested.</summary>
    public const string AnimeSeries = "Anime Series";
    public const string AnimeMovies = "Anime Movies";

    public static string Season(int season) => $"Season {season:00}";

    /// <summary>
    /// The library folder a kind lands in, Jellyfin style, one flat library per top-level folder: a category's path rule,
    /// else &lt;download root&gt;/&lt;category&gt;. Anime splits into "Anime Series" and "Anime Movies" flat under the download root
    /// (beside an Anime path rule's folder when there is no root), so a film never sits in a series library or the other
    /// way round. Null when nothing is configured. Every save path (catalog grabs, smart sends, the search preview and
    /// plain category sends) starts here.
    /// </summary>
    public static string? Library(string? downloadRoot, string? categoryRule, string? category, string kind, bool film)
    {
        var root = Blank(downloadRoot);
        var rule = Blank(categoryRule)?.TrimEnd('/', '\\');
        if (kind == "anime")
        {
            var cut = rule?.LastIndexOfAny(['/', '\\']) ?? -1;
            var top = root ?? (cut > 0 ? rule![..cut] : rule);
            return top is null ? null : Join(top, LibraryName(category, kind, film));
        }
        if (rule is not null) return rule;
        return root is null ? null : Join(root, LibraryName(category, kind, film));
    }

    /// <summary>The library's own folder name: "Anime Series" / "Anime Movies" for anime, else the category.</summary>
    public static string LibraryName(string? category, string kind, bool film) =>
        kind == "anime" ? film ? AnimeMovies : AnimeSeries : (category ?? "").Trim().Trim('/', '\\');

    /// <summary>A title's folder inside its library: &lt;Title (Year)&gt; for films, &lt;Show&gt;/Season NN for series.</summary>
    public static string Item(string library, bool film, string? show, int? year, string? season)
    {
        if (string.IsNullOrEmpty(show)) return library;
        var path = Join(library, film && year is { } y && !show.Contains($"({y})", StringComparison.Ordinal) ? $"{show} ({y})" : show);
        return !film && !string.IsNullOrEmpty(season) ? Join(path, season) : path;
    }

    /// <summary>The one save path: <see cref="Library"/> then <see cref="Item"/>; null when no folder is configured.</summary>
    public static string? SavePath(string? downloadRoot, string? categoryRule, string? category, string kind, bool film, string? show, int? year, string? season) =>
        Library(downloadRoot, categoryRule, category, kind, film) is { } library ? Item(library, film, show, year, season) : null;

    /// <summary>Joins with the separator the parent already uses (backslash for Windows paths, else slash).</summary>
    public static string Join(string parent, string child)
    {
        var p = parent.TrimEnd('/', '\\'); var c = child.Trim('/', '\\');
        if (p.Length == 0) return c;
        if (c.Length == 0) return p;
        return $"{p}{(p.Contains('\\') ? '\\' : '/')}{c}";
    }

    /// <summary>A film folder's year: the catalog's, otherwise the release name's (<see cref="ReleaseNames.ReleaseYear"/>).</summary>
    public static int? FilmYear(string? title, int? catalogYear) =>
        catalogYear is int y && y is >= 1870 and <= 2100 ? y : string.IsNullOrWhiteSpace(title) ? null : ReleaseNames.ReleaseYear(title);

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>A title made safe as one Windows folder name: invalid characters dropped, spaces collapsed, no trailing dot.</summary>
    public static string Name(string title)
    {
        var cleaned = System.Text.RegularExpressions.Regex.Replace(title ?? "", @"[<>:""/\\|?*\x00-\x1f]", " ");
        cleaned = System.Text.RegularExpressions.Regex.Replace(cleaned, @"\s+", " ").Trim().TrimEnd('.', ' ');
        return cleaned[..Math.Min(120, cleaned.Length)].Trim();
    }
}
