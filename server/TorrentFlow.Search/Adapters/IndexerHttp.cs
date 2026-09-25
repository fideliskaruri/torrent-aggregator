using System.Net;
using Microsoft.Extensions.Logging;

namespace TorrentFlow.Search.Adapters;

public sealed class IndexerHttp(IHttpClientFactory clients, ILogger<IndexerHttp> logger)
{
    public const string BrowserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
    private readonly object gate = new();
    private readonly Dictionary<string, DateTimeOffset> failed = [];
    private readonly Dictionary<string, string> preferred = [];
    public async Task<string> GetAsync(string url, string agent = "TorrentFlow/1.0", int timeoutMs = 12000, string accept = "application/json", CancellationToken cancellationToken = default, bool validateApi = false)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(timeoutMs);
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("User-Agent", agent);
        request.Headers.TryAddWithoutValidation("Accept", accept);
        if (agent.Contains("Chrome/131"))
        {
            request.Headers.TryAddWithoutValidation("Accept-Language", "en-US,en;q=0.9");
            request.Headers.TryAddWithoutValidation("Cache-Control", "no-cache");
            request.Headers.TryAddWithoutValidation("Pragma", "no-cache");
            request.Headers.TryAddWithoutValidation("Upgrade-Insecure-Requests", "1");
        }
        using var client = clients.CreateClient("TorrentFlow.Indexers");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        response.EnsureSuccessStatusCode();
        var mediaType = response.Content.Headers.ContentType?.MediaType ?? "";
        if (validateApi && !mediaType.Contains("json", StringComparison.OrdinalIgnoreCase) && !mediaType.Contains("text/plain", StringComparison.OrdinalIgnoreCase))
            throw new HttpRequestException("Mirror returned a non-API response");
        if (response.Content.Headers.ContentLength > 8 * 1024 * 1024) throw new HttpRequestException("Indexer response exceeds 8 MiB");
        await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var buffer = new MemoryStream();
        var block = new byte[16384];
        int read;
        while ((read = await stream.ReadAsync(block, timeout.Token)) > 0)
        {
            if (buffer.Length + read > 8 * 1024 * 1024) throw new HttpRequestException("Indexer response exceeds 8 MiB");
            buffer.Write(block, 0, read);
        }
        return System.Text.Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
    }
    public static string[] MirrorList(string? configured, params string[] defaults) =>
        (configured ?? "").Split(',').Concat(defaults)
        .Select(h => h.Trim().TrimEnd('/')).Where(h => Uri.TryCreate(h, UriKind.Absolute, out var u) && u.Scheme is "https" or "http")
        .Distinct(StringComparer.OrdinalIgnoreCase).Take(20).ToArray();
    public async Task<string> MirrorsAsync(string key, string[] hosts, Func<string, string> url, string agent, CancellationToken token)
    {
        string[] ordered;
        lock (gate)
        {
            foreach (var h in failed.Where(x => x.Value <= DateTimeOffset.UtcNow).Select(x => x.Key).ToArray()) failed.Remove(h);
            preferred.TryGetValue(key, out var favorite);
            ordered = hosts.OrderBy(h => h == favorite ? 0 : failed.ContainsKey(key + "\0" + h) ? 2 : 1).ToArray();
        }
        Exception? last = null;
        foreach (var host in ordered)
        {
            try
            {
                var body = await GetAsync(url(host), agent, cancellationToken: token, validateApi: true);
                lock (gate)
                {
                    if (preferred.Count >= 32) preferred.Remove(preferred.Keys.First());
                    preferred[key] = host;
                    failed.Remove(key + "\0" + host);
                }
                return body;
            }
            catch (Exception e) when (!token.IsCancellationRequested && e is HttpRequestException or OperationCanceledException)
            {
                if (e is HttpRequestException { StatusCode: { } status } && status != HttpStatusCode.Forbidden && status != HttpStatusCode.TooManyRequests && (int)status < 500)
                {
                    lock (gate)
                    {
                        if (status != HttpStatusCode.NotFound || preferred.GetValueOrDefault(key) == host) throw;
                    }
                }
                last = e;
                lock (gate)
                {
                    if (failed.Count >= 128) failed.Remove(failed.Keys.First());
                    if (preferred.GetValueOrDefault(key) == host) preferred.Remove(key);
                    failed[key + "\0" + host] = DateTimeOffset.UtcNow.AddMinutes(5);
                }
                logger.LogDebug(e, "Indexer mirror {Host} failed; demoted for five minutes", host);
            }
        }
        throw new HttpRequestException($"{key}: all mirrors failed ({last?.Message})", last);
    }
}
