using System.Collections.Immutable;
using System.Net;
using System.Text;

namespace TorrentFlow.Core.Torrents;

/// <summary>
/// The public tracker list added to every non-private magnet and transfer. Starts from a bundled copy of ngosang's
/// trackers_best list and is refreshed at runtime (see the engine's tracker refresh service).
/// </summary>
public static class PublicTrackers
{
    public const int MaxTrackers = 30;
    public const int MinTrackers = 5;

    public static readonly ImmutableArray<string> Default =
    [
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://open.stealth.si:80/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://open.demonii.com:1337/announce",
        "udp://tracker.qu.ax:6969/announce",
        "udp://exodus.desync.com:6969/announce",
        "udp://tracker.tryhackx.org:6969/announce",
        "udp://explodie.org:6969/announce",
        "udp://tracker.bittor.pw:1337/announce",
        "udp://tracker-udp.gbitt.info:80/announce",
        "udp://tracker.ducks.party:1984/announce",
        "udp://tracker.dler.org:6969/announce",
        "http://tracker.dler.com:6969/announce",
        "udp://tracker.peerfect.org:6969/announce",
        "https://tracker.opentrackr.org:443/announce",
    ];

    private static volatile IReadOnlyList<string> _current = Default;

    public static IReadOnlyList<string> Current => _current;

    /// <summary>
    /// Replaces <see cref="Current"/> with the valid (absolute udp/http/https), de-duplicated entries, capped at
    /// <see cref="MaxTrackers"/>. A list with fewer than <see cref="MinTrackers"/> valid entries is ignored.
    /// </summary>
    /// <returns>True when the list was applied.</returns>
    public static bool Update(IEnumerable<string>? trackers)
    {
        var valid = Validate(trackers);
        if (valid.Length < MinTrackers) return false;
        _current = valid;
        return true;
    }

    /// <summary>Restores the bundled list (tests).</summary>
    public static void Reset() => _current = Default;

    internal static ImmutableArray<string> Validate(IEnumerable<string>? trackers)
    {
        if (trackers is null) return [];
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = ImmutableArray.CreateBuilder<string>();
        foreach (var raw in trackers)
        {
            var tracker = raw?.Trim();
            if (string.IsNullOrEmpty(tracker) || !IsAnnounceUrl(tracker) || !seen.Add(tracker)) continue;
            result.Add(tracker);
            if (result.Count == MaxTrackers) break;
        }
        return result.ToImmutable();
    }

    private static bool IsAnnounceUrl(string tracker) =>
        Uri.TryCreate(tracker, UriKind.Absolute, out var uri)
        && uri.Scheme is "udp" or "http" or "https"
        && !string.IsNullOrEmpty(uri.Host);

    /// <summary>Builds a magnet link; <paramref name="trackers"/> are de-duplicated in order.</summary>
    public static string BuildMagnet(string hash, string? name, IEnumerable<string>? trackers)
    {
        var sb = new StringBuilder("magnet:?xt=urn:btih:").Append(hash);
        if (!string.IsNullOrWhiteSpace(name)) sb.Append("&dn=").Append(Uri.EscapeDataString(name));
        if (trackers is null) return sb.ToString();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var tr in trackers)
            if (!string.IsNullOrWhiteSpace(tr) && seen.Add(tr)) sb.Append("&tr=").Append(Uri.EscapeDataString(tr));
        return sb.ToString();
    }

    /// <summary>
    /// Appends public trackers (default <see cref="Current"/>) without replacing the release's own. A magnet whose
    /// only trackers are local/private is left alone — widening it would leak a private swarm's hash to public trackers.
    /// </summary>
    public static string WidenMagnet(string magnet, IEnumerable<string>? trackers = null)
    {
        ArgumentNullException.ThrowIfNull(magnet);
        var existing = TrackersOf(magnet);
        if (existing.Count > 0 && existing.All(IsLocalOrPrivate)) return magnet;
        var set = existing.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var sb = new StringBuilder(magnet);
        foreach (var tr in trackers ?? Current)
            if (set.Add(tr)) sb.Append("&tr=").Append(Uri.EscapeDataString(tr));
        return sb.ToString();
    }

    /// <summary>The magnet's <c>tr</c> parameters, decoded, in order.</summary>
    public static IReadOnlyList<string> TrackersOf(string? magnet)
    {
        if (string.IsNullOrEmpty(magnet)) return [];
        var q = magnet.IndexOf('?', StringComparison.Ordinal);
        if (q < 0) return [];
        var list = new List<string>();
        foreach (var part in magnet[(q + 1)..].Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = part.IndexOf('=', StringComparison.Ordinal);
            if (eq <= 0 || part[..eq] != "tr") continue;
            list.Add(Uri.UnescapeDataString(part[(eq + 1)..]));
        }
        return list;
    }

    /// <summary>True for trackers on localhost, *.local, loopback, or RFC 1918 addresses.</summary>
    public static bool IsLocalOrPrivate(string tracker)
    {
        if (!Uri.TryCreate(tracker, UriKind.Absolute, out var uri)) return false;
        var host = uri.Host;
        if (host is "localhost" || host.EndsWith(".local", StringComparison.OrdinalIgnoreCase)) return true;
        if (!IPAddress.TryParse(host, out var ip)) return false;
        if (IPAddress.IsLoopback(ip)) return true;
        var b = ip.GetAddressBytes();
        return b.Length == 4 && (b[0] == 10 || (b[0] == 172 && b[1] is >= 16 and <= 31) || (b[0] == 192 && b[1] == 168));
    }
}
