using System.Net;
using System.Net.Sockets;
using MonoTorrent;

namespace TorrentFlow.Engine;

internal static class TorrentMetadata
{
    internal sealed record Result(Torrent? Torrent, MagnetLink? Magnet);

    internal static async Task<Result> LoadAsync(string address, string expectedHash, CancellationToken ct)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri))
            throw new ArgumentException("Torrent metadata requires a public HTTP or HTTPS address.");
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
        const int sizeLimit = 20 * 1024 * 1024;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(6));
        using var http = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        for (var redirects = 0; ; redirects++)
        {
            if (uri.Scheme == "magnet")
            {
                if (!MagnetLink.TryParse(uri.AbsoluteUri, out var magnet) || magnet is null ||
                    !magnet.InfoHashes.Contains(InfoHash.FromHex(expectedHash)))
                    throw new InvalidDataException("Redirected magnet hash does not match the candidate.");
                return new(null, magnet);
            }
            if (uri.Scheme is not ("http" or "https") || uri.UserInfo.Length != 0)
                throw new InvalidDataException("Torrent metadata requires a public HTTP or HTTPS address.");
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.Accept.ParseAdd("application/x-bittorrent, application/octet-stream");
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            if (response.StatusCode is HttpStatusCode.MovedPermanently or HttpStatusCode.Found or
                HttpStatusCode.SeeOther or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect)
            {
                if (redirects >= 5) throw new InvalidDataException("Torrent metadata exceeded five redirects.");
                var location = response.Headers.Location ?? throw new InvalidDataException("Torrent metadata redirect has no location.");
                uri = location.IsAbsoluteUri ? location : new Uri(uri, location);
                continue;
            }
            response.EnsureSuccessStatusCode();
            var mediaType = response.Content.Headers.ContentType?.MediaType;
            if (mediaType is not null && !mediaType.Equals("application/x-bittorrent", StringComparison.OrdinalIgnoreCase) &&
                !mediaType.Equals("application/octet-stream", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("The response is not torrent metadata or an octet stream.");
            if (response.Content.Headers.ContentLength > sizeLimit)
                throw new InvalidDataException("Torrent metadata exceeds the 20 MiB limit.");
            await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
            using var bytes = new MemoryStream();
            var buffer = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, sizeLimit + 1 - (int)bytes.Length)),
                deadline.Token)) > 0)
            {
                bytes.Write(buffer, 0, read);
                if (bytes.Length > sizeLimit) throw new InvalidDataException("Torrent metadata exceeds the 20 MiB limit.");
            }
            if (!Torrent.TryLoad(bytes.ToArray(), out var torrent) || torrent is null)
                throw new InvalidDataException("The response is not valid torrent metadata.");
            if (!torrent.InfoHashes.Contains(InfoHash.FromHex(expectedHash)))
                throw new InvalidDataException("Torrent metadata hash does not match the candidate.");
            return new(torrent, null);
        }
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
