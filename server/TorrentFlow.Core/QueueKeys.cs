using System.Globalization;
using System.Text.RegularExpressions;

namespace TorrentFlow.Core;

/// <summary>
/// The one queue-key format: <c>sNNNNNeNNNNN</c> for an episode, with a trailing <c>p</c> for a season pack that
/// starts at that episode. Zero-padded so a plain string compare orders S2E10 after S2E9 and a pack next to its first episode.
/// </summary>
public static partial class QueueKeys
{
    [GeneratedRegex(@"^s(\d{1,5})e(\d{1,5})(p?)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Shape();

    public static string For(int season, int episode, bool pack = false) =>
        $"s{season.ToString("D5", CultureInfo.InvariantCulture)}e{episode.ToString("D5", CultureInfo.InvariantCulture)}{(pack ? "p" : "")}";

    /// <summary>Season, episode and whether the key marks a season pack; null for films, one-offs and unknown shapes.</summary>
    public static (int Season, int Episode, bool Pack)? Parse(string? key)
    {
        var match = Shape().Match(key?.Trim() ?? "");
        if (!match.Success) return null;
        return (int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture), int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture),
            match.Groups[3].Length > 0);
    }
}
