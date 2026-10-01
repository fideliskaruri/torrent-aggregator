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
    /// The one folder layout, Jellyfin style, one flat library per top-level folder: &lt;root&gt;/&lt;category&gt;/&lt;show&gt;/Season NN
    /// for series and &lt;root&gt;/&lt;category&gt;/&lt;Title (Year)&gt; for films. Anime takes "Anime Series" or "Anime Movies" in
    /// place of its category folder, so a film never sits in a series library or the other way round. An empty category
    /// means the root is already the category's own folder.
    /// </summary>
    public static string Path(string root, string category, string kind, bool film, string? show, int? year, string? season, string sep)
    {
        var parts = new List<string>();
        if ((root ?? "").TrimEnd('/', '\\') is { Length: > 0 } top) parts.Add(top);
        var cat = (category ?? "").Trim('/', '\\');
        if (kind == "anime") parts.Add(film ? AnimeMovies : AnimeSeries);
        else if (cat.Length > 0) parts.Add(cat);
        if (!string.IsNullOrEmpty(show))
        {
            parts.Add(film && year is { } y && !show.Contains($"({y})", StringComparison.Ordinal) ? $"{show} ({y})" : show);
            if (!film && !string.IsNullOrEmpty(season)) parts.Add(season);
        }
        return string.Join(sep, parts);
    }

    /// <summary>A film folder's year: the catalog's, otherwise the first 19xx/20xx token in the release name.</summary>
    public static int? FilmYear(string? title, int? catalogYear)
    {
        if (catalogYear is int y && y is >= 1870 and <= 2100) return y;
        if (string.IsNullOrWhiteSpace(title)) return null;
        var m = System.Text.RegularExpressions.Regex.Match(title, @"\b((?:19|20)\d{2})\b");
        return m.Success && int.TryParse(m.Groups[1].Value, out var year) && year is >= 1870 and <= 2100 ? year : null;
    }

    /// <summary>
    /// Where the anime libraries go: flat under the download root, beside Movies and TV, never inside another library.
    /// With no download root, beside the Anime path rule's folder.
    /// </summary>
    public static string? AnimeRoot(string? downloadRoot, string? animeRule)
    {
        if (downloadRoot?.Trim() is { Length: > 0 } root) return root;
        var rule = animeRule?.Trim().TrimEnd('/', '\\');
        var cut = rule?.LastIndexOfAny(['/', '\\']) ?? -1;
        return cut > 0 ? rule![..cut] : null;
    }

    /// <summary>A title made safe as one Windows folder name: invalid characters dropped, spaces collapsed, no trailing dot.</summary>
    public static string Name(string title)
    {
        var cleaned = System.Text.RegularExpressions.Regex.Replace(title ?? "", @"[<>:""/\\|?*\x00-\x1f]", " ");
        cleaned = System.Text.RegularExpressions.Regex.Replace(cleaned, @"\s+", " ").Trim().TrimEnd('.', ' ');
        return cleaned[..Math.Min(120, cleaned.Length)].Trim();
    }
}
