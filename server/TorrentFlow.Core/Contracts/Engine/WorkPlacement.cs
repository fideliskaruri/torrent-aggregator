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
    /// <summary>Anime splits under the download root (or the Anime path rule) into series and films.</summary>
    public const string AnimeSeries = "Anime Series";
    public const string AnimeMovies = "Anime Movies";

    public static string Season(int season) => $"Season {season:00}";

    /// <summary>A title made safe as one Windows folder name: invalid characters dropped, spaces collapsed, no trailing dot.</summary>
    public static string Name(string title)
    {
        var cleaned = System.Text.RegularExpressions.Regex.Replace(title ?? "", @"[<>:""/\\|?*\x00-\x1f]", " ");
        cleaned = System.Text.RegularExpressions.Regex.Replace(cleaned, @"\s+", " ").Trim().TrimEnd('.', ' ');
        return cleaned[..Math.Min(120, cleaned.Length)].Trim();
    }
}
