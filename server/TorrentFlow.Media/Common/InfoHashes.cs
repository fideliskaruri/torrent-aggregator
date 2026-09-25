using System.Text;
using System.Text.RegularExpressions;

namespace TorrentFlow.Media.Common;

/// <summary>Port of src/lib/torrents/infohash.ts.</summary>
internal static partial class InfoHashes
{
    private const string Base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    public static string? Base32ToHex(string value)
    {
        if (value.Length != 32) return null;
        var bits = new StringBuilder(160);
        foreach (var ch in value.ToUpperInvariant())
        {
            var idx = Base32Alphabet.IndexOf(ch);
            if (idx < 0) return null;
            bits.Append(Convert.ToString(idx, 2).PadLeft(5, '0'));
        }
        var hex = new StringBuilder(40);
        for (var i = 0; i + 4 <= bits.Length && hex.Length < 40; i += 4)
            hex.Append(Convert.ToInt32(bits.ToString(i, 4), 2).ToString("x"));
        return hex.Length == 40 ? hex.ToString() : null;
    }

    public static string? Normalize(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        var value = raw.Trim();
        if (HexRe().IsMatch(value)) return value.ToLowerInvariant();
        if (Base32Re().IsMatch(value)) return Base32ToHex(value);
        return null;
    }

    public static string? FromMagnet(string? magnet)
    {
        if (string.IsNullOrEmpty(magnet)) return null;
        foreach (Match m in XtRe().Matches(magnet))
        {
            string decoded;
            try { decoded = Uri.UnescapeDataString(m.Groups[1].Value); }
            catch (UriFormatException) { continue; }
            var candidate = Normalize(BtihPrefixRe().Replace(decoded, ""));
            if (candidate is not null) return candidate;
        }
        return null;
    }

    /// <summary>The canonical hash for a release: its own infoHash when valid, else the magnet's btih.</summary>
    public static string? OfRelease(string? infoHash, string? magnet) => Normalize(infoHash) ?? FromMagnet(magnet);

    [GeneratedRegex("^[0-9a-f]{40}$", RegexOptions.IgnoreCase)] private static partial Regex HexRe();
    [GeneratedRegex("^[a-z2-7]{32}$", RegexOptions.IgnoreCase)] private static partial Regex Base32Re();
    [GeneratedRegex("[?&]xt=([^&]+)", RegexOptions.IgnoreCase)] private static partial Regex XtRe();
    [GeneratedRegex("^urn:btih:", RegexOptions.IgnoreCase)] private static partial Regex BtihPrefixRe();
}
