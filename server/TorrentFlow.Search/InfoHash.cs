using System.Text.RegularExpressions;

namespace TorrentFlow.Search;

public static class InfoHash
{
    public static string? Normalize(string? raw)
    {
        var value = raw?.Trim();
        if (value == null) return null;
        if (Regex.IsMatch(value, "^[0-9a-fA-F]{40}$")) return value.ToLowerInvariant();
        if (!Regex.IsMatch(value, "^[a-zA-Z2-7]{32}$")) return null;
        const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        Span<byte> bytes = stackalloc byte[20];
        uint buffer = 0;
        int bits = 0, index = 0;
        foreach (var c in value.ToUpperInvariant())
        {
            buffer = (buffer << 5) | (uint)alphabet.IndexOf(c);
            bits += 5;
            if (bits >= 8) { bits -= 8; bytes[index++] = (byte)(buffer >> bits); }
        }
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
    public static string? FromMagnet(string? magnet)
    {
        foreach (Match m in Regex.Matches(magnet ?? "", @"[?&]xt=([^&]+)", RegexOptions.IgnoreCase))
        {
            var value = Uri.UnescapeDataString(m.Groups[1].Value);
            value = Regex.Replace(value, "^urn:btih:", "", RegexOptions.IgnoreCase);
            if (Normalize(value) is { } hash) return hash;
        }
        return null;
    }
}
