using System.Globalization;
using System.Text.RegularExpressions;

namespace TorrentFlow.Core;

/// <summary>
/// The one queue-key format: <c>sNNNNNeNNNNN</c> for an episode. Zero-padded so a plain string compare orders S2E10 after S2E9.
/// </summary>
public static partial class QueueKeys
{
    [GeneratedRegex(@"^s(\d{1,5})e(\d{1,5})$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Shape();

    public static string For(int season, int episode) =>
        $"s{season.ToString("D5", CultureInfo.InvariantCulture)}e{episode.ToString("D5", CultureInfo.InvariantCulture)}";

    /// <summary>Season and episode; null for films, one-offs and unknown shapes.</summary>
    public static (int Season, int Episode)? Parse(string? key)
    {
        var match = Shape().Match(key?.Trim() ?? "");
        if (!match.Success) return null;
        return (int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture), int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture));
    }
}
