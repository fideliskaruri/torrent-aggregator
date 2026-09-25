using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace TorrentFlow.Media.Streaming;

/// <summary>Port of serveFileRange: streams a file on disk honouring Range, never buffering it.</summary>
public sealed class FileRangeResult(string absolutePath, string filename, string cacheControl) : IActionResult
{
    public async Task ExecuteResultAsync(ActionContext context)
    {
        var http = context.HttpContext;
        var request = http.Request;
        var response = http.Response;
        long size;
        try
        {
            var info = new FileInfo(absolutePath);
            if (!info.Exists) throw new FileNotFoundException();
            size = info.Length;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            response.StatusCode = 404;
            response.ContentType = "application/json";
            await response.WriteAsync("{\"error\":\"Not found\"}", http.RequestAborted);
            return;
        }

        var range = HttpRanges.ParseSegmentRange(request.Headers.Range.ToString(), size, out var unsatisfiable);
        if (unsatisfiable)
        {
            response.StatusCode = 416;
            response.Headers.AcceptRanges = "bytes";
            response.Headers.ContentRange = $"bytes */{size}";
            return;
        }
        var start = range?.Start ?? 0;
        var end = range?.End ?? Math.Max(0, size - 1);
        var length = size == 0 ? 0 : end - start + 1;
        response.StatusCode = range is null ? 200 : 206;
        response.ContentType = HttpRanges.ContentTypeForSegment(filename);
        response.ContentLength = length;
        response.Headers.AcceptRanges = "bytes";
        response.Headers.CacheControl = cacheControl;
        if (range is not null) response.Headers.ContentRange = $"bytes {start}-{end}/{size}";
        if (HttpMethods.IsHead(request.Method) || size == 0) return;
        await using var file = new FileStream(absolutePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024, useAsync: true);
        file.Seek(start, SeekOrigin.Begin);
        await StreamCopy.CopyExactlyAsync(file, response.Body, length, null, http.RequestAborted);
    }
}

internal static class StreamCopy
{
    /// <summary>Copies exactly <paramref name="count"/> bytes (or until EOF), invoking <paramref name="onChunk"/> per chunk.</summary>
    public static async Task<long> CopyExactlyAsync(Stream source, Stream destination, long count, Action<int>? onChunk, CancellationToken ct)
    {
        var buffer = new byte[Math.Min(256 * 1024, Math.Max(1, count))];
        long remaining = count;
        while (remaining > 0)
        {
            var n = await source.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)), ct);
            if (n == 0) break;
            await destination.WriteAsync(buffer.AsMemory(0, n), ct);
            remaining -= n;
            onChunk?.Invoke(n);
        }
        return count - remaining;
    }
}
