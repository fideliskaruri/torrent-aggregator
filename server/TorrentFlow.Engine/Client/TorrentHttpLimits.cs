namespace TorrentFlow.Engine.Client;

internal static class TorrentHttpLimits
{
    public const int MaxMetadataBytes = 20 * 1024 * 1024;
    public const int MaxBufferedResponseBytes = 32 * 1024 * 1024;

    public static HttpClient Configure(HttpClient client, int maxBufferedResponseBytes = MaxBufferedResponseBytes)
    {
        // MonoTorrent 3.0.2's webseed SendAsync buffers the response, including an entire file
        // when a server ignores Range. Its default HttpClient limit is nearly 2 GiB.
        client.MaxResponseContentBufferSize = maxBufferedResponseBytes;
        return client;
    }

    public static async Task<byte[]> ReadMetadataAsync(HttpContent content, CancellationToken ct)
    {
        // Content-Length is optional and cannot be trusted as the only size check.
        await content.LoadIntoBufferAsync(MaxMetadataBytes, ct);
        var bytes = await content.ReadAsByteArrayAsync(ct);
        if (bytes.Length == 0 || bytes[0] != (byte)'d') throw new InvalidDataException("Not a .torrent file");
        return bytes;
    }
}
