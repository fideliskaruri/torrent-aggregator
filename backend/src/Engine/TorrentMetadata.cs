using System.Net;
using System.Net.Sockets;
using MonoTorrent;

namespace TorrentFlow.Engine;

internal static class TorrentMetadata
{
    internal static async Task<Torrent> LoadAsync(string address, string expectedHash, CancellationToken ct)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") ||
            uri.UserInfo.Length != 0) throw new ArgumentException("Torrent metadata requires a public HTTP or HTTPS address.");
        using var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            ConnectCallback = async (context, token) =>
            {
                var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, token);
                if (addresses.Length == 0 || addresses.Any(IsPrivate)) throw new IOException("Private metadata addresses are not allowed.");
                var socket = new Socket(SocketType.Stream, ProtocolType.Tcp);
                try
                {
                    await socket.ConnectAsync(addresses, context.DnsEndPoint.Port, token);
                    return new NetworkStream(socket, true);
                }
                catch { socket.Dispose(); throw; }
            },
        };
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(6), MaxResponseContentBufferSize = 20 * 1024 * 1024 };
        using var response = await http.GetAsync(uri, ct);
        response.EnsureSuccessStatusCode();
        var bytes = await response.Content.ReadAsByteArrayAsync(ct);
        if (!Torrent.TryLoad(bytes, out var torrent) || torrent is null)
            throw new InvalidDataException("The response is not valid torrent metadata.");
        if (!torrent.InfoHashes.Contains(InfoHash.FromHex(expectedHash))) throw new InvalidDataException("Torrent metadata hash does not match the candidate.");
        return torrent;
    }

    private static bool IsPrivate(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip) || ip.Equals(IPAddress.Any) || ip.Equals(IPAddress.IPv6Any) ||
            ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal || ip.IsIPv6Multicast) return true;
        var bytes = ip.GetAddressBytes();
        return bytes.Length == 4
            ? bytes[0] is 0 or 10 or 127 || bytes[0] >= 224 || bytes[0] == 169 && bytes[1] == 254 ||
                bytes[0] == 172 && bytes[1] is >= 16 and <= 31 || bytes[0] == 192 && bytes[1] == 168
            : (bytes[0] & 0xfe) == 0xfc;
    }
}
