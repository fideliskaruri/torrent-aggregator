using System.Net.Http.Json;
using System.Text.Json;

namespace TorrentFlow.Core.Http;

/// <summary>Bounds upstream payloads even when Content-Length is absent or inaccurate.</summary>
public static class BoundedHttpContent
{
    public const int DefaultMaxBytes = 8 * 1024 * 1024;

    public static async Task<JsonDocument> ReadJsonAsync(HttpContent content, CancellationToken cancellationToken = default)
    {
        await BufferAsync(content, cancellationToken).ConfigureAwait(false);
        await using var stream = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        return await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    public static async Task<JsonElement> ReadJsonElementAsync(HttpContent content, CancellationToken cancellationToken = default)
    {
        await BufferAsync(content, cancellationToken).ConfigureAwait(false);
        return await content.ReadFromJsonAsync<JsonElement>(cancellationToken).ConfigureAwait(false);
    }

    private static Task BufferAsync(HttpContent content, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(content);
        cancellationToken.ThrowIfCancellationRequested();
        return content.LoadIntoBufferAsync(DefaultMaxBytes, cancellationToken);
    }
}
