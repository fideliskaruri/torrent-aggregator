using System.Text;
using MonoTorrent;

namespace TorrentFlow.Engine.Client;

/// <summary>Info-hash and magnet helpers shared by the engine and the send route.</summary>
public static class TorrentSource
{
    /// <summary>Lowercase hex v1 hash from a 40-char hex or 32-char base32 hash, or null.</summary>
    public static string? NormalizeInfoHash(string? raw)
    {
        raw = raw?.Trim();
        if (string.IsNullOrEmpty(raw)) return null;
        if (raw.Length == 40 && raw.All(Uri.IsHexDigit)) return raw.ToLowerInvariant();
        if (raw.Length == 32)
        {
            try { return InfoHash.FromBase32(raw.ToUpperInvariant()).ToHex().ToLowerInvariant(); }
            catch (Exception ex) when (ex is ArgumentException or FormatException) { return null; }
        }
        return null;
    }

    public static string? HashFromMagnet(string? magnet)
    {
        if (string.IsNullOrWhiteSpace(magnet)) return null;
        try
        {
            return MagnetLink.TryParse(magnet.Trim(), out var link) && link is not null
                ? link.InfoHashes.V1OrV2.ToHex().ToLowerInvariant()
                : null;
        }
        catch (Exception ex) when (ex is FormatException or ArgumentException or UriFormatException) { return null; }
    }

    public static string? HashFromTorrent(byte[] bytes)
    {
        try { return Torrent.Load(bytes).InfoHashes.V1OrV2.ToHex().ToLowerInvariant(); }
        catch (Exception ex) when (ex is TorrentException or FormatException or ArgumentException or InvalidOperationException) { return null; }
    }

    public static string BuildMagnet(string hash, string? name, IEnumerable<string> trackers)
    {
        var sb = new StringBuilder("magnet:?xt=urn:btih:").Append(hash);
        if (!string.IsNullOrWhiteSpace(name)) sb.Append("&dn=").Append(Uri.EscapeDataString(name));
        foreach (var tr in trackers) sb.Append("&tr=").Append(Uri.EscapeDataString(tr));
        return sb.ToString();
    }

    /// <summary>
    /// Appends public trackers without replacing the release's own. A magnet whose only trackers are
    /// local/private is left alone — widening it would leak a private swarm's hash to public trackers.
    /// </summary>
    public static string WidenTrackers(string magnet, IEnumerable<string> trackers)
    {
        var existing = ParseQuery(magnet).Where(kv => kv.Key == "tr").Select(kv => kv.Value).ToList();
        if (existing.Count > 0 && existing.All(IsLocalOrPrivate)) return magnet;
        var set = existing.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var sb = new StringBuilder(magnet);
        foreach (var tr in trackers)
            if (set.Add(tr)) sb.Append("&tr=").Append(Uri.EscapeDataString(tr));
        return sb.ToString();
    }

    private static bool IsLocalOrPrivate(string tracker)
    {
        if (!Uri.TryCreate(tracker, UriKind.Absolute, out var uri)) return false;
        var host = uri.Host;
        if (host is "localhost" || host.EndsWith(".local", StringComparison.OrdinalIgnoreCase)) return true;
        if (!System.Net.IPAddress.TryParse(host, out var ip)) return false;
        if (System.Net.IPAddress.IsLoopback(ip)) return true;
        var b = ip.GetAddressBytes();
        return b.Length == 4 && (b[0] == 10 || (b[0] == 172 && b[1] is >= 16 and <= 31) || (b[0] == 192 && b[1] == 168));
    }

    private static IEnumerable<KeyValuePair<string, string>> ParseQuery(string magnet)
    {
        var q = magnet.IndexOf('?');
        if (q < 0) yield break;
        foreach (var part in magnet[(q + 1)..].Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = part.IndexOf('=');
            if (eq <= 0) continue;
            yield return new(part[..eq], Uri.UnescapeDataString(part[(eq + 1)..]));
        }
    }
}
