using MonoTorrent;
using TorrentFlow.Core.Torrents;

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

    public static string BuildMagnet(string hash, string? name, IEnumerable<string> trackers) =>
        PublicTrackers.BuildMagnet(hash, name, trackers);

    /// <summary>
    /// Appends public trackers without replacing the release's own. A magnet whose only trackers are
    /// local/private is left alone — widening it would leak a private swarm's hash to public trackers.
    /// </summary>
    public static string WidenTrackers(string magnet, IEnumerable<string> trackers) =>
        PublicTrackers.WidenMagnet(magnet, trackers);
}
