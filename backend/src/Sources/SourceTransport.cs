using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using TorrentFlow.Domain;

namespace TorrentFlow.Sources;

internal sealed class SourceTransport : IDisposable
{
    private readonly ConcurrentDictionary<string, PriorityGate> sites = new(StringComparer.OrdinalIgnoreCase);
    private readonly PriorityGate global = new(8);
    private readonly HttpClient client = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        AutomaticDecompression = DecompressionMethods.All,
        MaxConnectionsPerServer = 24,
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        ConnectTimeout = TimeSpan.FromSeconds(6)
    }) { Timeout = Timeout.InfiniteTimeSpan };

    internal PriorityGate Site(Uri uri) => sites.GetOrAdd(uri.IdnHost, _ => new());

    internal async Task<string> ReadAsync(Uri uri, string? body, SourceSettings settings,
        SourceQuery query, CallTrace trace, CancellationToken ct)
    {
        for (var redirects = 0; redirects <= 3; redirects++)
        {
            if (uri.Scheme is not ("http" or "https") ||
                uri.Scheme == "http" && !uri.IsLoopback)
                throw new SourceException("InvalidEndpoint", "Sources require HTTPS; HTTP is only allowed for loopback verification.");
            var site = Site(uri);
            if (site.Cooldown is { } due) throw new SourceException("CoolingDown", "The site is cooling down.", due);
            var queued = Stopwatch.GetTimestamp();
            IDisposable? admission = null;
            IDisposable? lease = null;
            try
            {
                admission = await global.EnterAsync(query.Lane, "global", 24, 0, ct).ConfigureAwait(false);
                lease = await site.EnterAsync(query.Lane, settings.Id, settings.Concurrency, settings.StartSpacingMilliseconds, ct).ConfigureAwait(false);
            }
            catch
            {
                admission?.Dispose();
                throw;
            }
            finally { trace.QueueWait += Stopwatch.GetElapsedTime(queued); }
            using var globalLease = admission;
            using var hostLease = lease;
            ct.ThrowIfCancellationRequested();
            // A response can impose cooldown while this call is waiting for courtesy spacing.
            if (site.Cooldown is { } next) throw new SourceException("CoolingDown", "The site is cooling down.", next);
            using var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Post, uri);
            request.Headers.UserAgent.ParseAdd("TorrentFlow/0.3 (+source-search)");
            request.Headers.Accept.ParseAdd("application/json, application/rss+xml, application/xml;q=0.9, */*;q=0.5");
            if (body is not null) request.Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
            trace.StartedAt ??= DateTimeOffset.UtcNow;
            trace.Requests++;
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            trace.HttpStatus = (int)response.StatusCode;
            var retry = response.Headers.RetryAfter;
            TimeSpan? delay = retry?.Delta ?? (retry?.Date is { } date ? date - DateTimeOffset.UtcNow : null);
            site.Observe(trace.HttpStatus.Value, delay);
            if (trace.HttpStatus is 429 or 503)
                throw new SourceException("SourceFailure", $"The site returned HTTP {trace.HttpStatus}.", site.Cooldown);
            if (trace.HttpStatus is >= 300 and < 400 && response.Headers.Location is { } location)
            {
                uri = location.IsAbsoluteUri ? location : new Uri(uri, location);
                if (uri.Scheme == "http") throw new SourceException("InvalidRedirect", "An insecure redirect was refused.");
                continue;
            }
            if (!response.IsSuccessStatusCode)
                throw new SourceException("SourceFailure", $"The site returned HTTP {trace.HttpStatus}.");
            const int cap = 8 * 1024 * 1024;
            if (response.Content.Headers.ContentLength > cap)
                throw new SourceException("SourceFailure", "The response exceeds the 8 MiB source limit.");
            await using var input = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var output = new MemoryStream();
            var buffer = new byte[16384];
            while (true)
            {
                var read = await input.ReadAsync(buffer, ct).ConfigureAwait(false);
                if (read == 0) break;
                if (output.Length + read > cap)
                    throw new SourceException("SourceFailure", "The response exceeds the 8 MiB source limit.");
                output.Write(buffer, 0, read);
            }
            return System.Text.Encoding.UTF8.GetString(output.GetBuffer(), 0, (int)output.Length);
        }
        throw new SourceException("SourceFailure", "Too many source redirects.");
    }

    public void Dispose() => client.Dispose();
}

internal sealed class CallTrace
{
    internal TimeSpan QueueWait { get; set; }
    internal DateTimeOffset? StartedAt { get; set; }
    internal int Requests { get; set; }
    internal int? HttpStatus { get; set; }
}

internal sealed class SourceException(string code, string message, DateTimeOffset? retryAt = null)
    : Exception(message)
{
    internal string Code { get; } = code;
    internal DateTimeOffset? RetryAt { get; } = retryAt;
}
