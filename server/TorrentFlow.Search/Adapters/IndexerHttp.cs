using System.Net;
using Microsoft.Extensions.Logging;

namespace TorrentFlow.Search.Adapters;

public sealed class IndexerHttp(IHttpClientFactory clients, ILogger<IndexerHttp> logger)
{
    public const string BrowserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
    /// <summary>Default cool-down when a site rate-limits without a usable Retry-After.</summary>
    public const int DefaultCoolDownSeconds = 30;
    /// <summary>Hard cap on per-site cool-down after 429 / 503+Retry-After.</summary>
    public const int MaxCoolDownSeconds = 300;
    private readonly object gate = new();
    private readonly Dictionary<string, DateTimeOffset> failed = [];
    private readonly Dictionary<string, string> preferred = [];
    /// <summary>Host → UTC time until which that site is skipped after a real 429/503+Retry-After.</summary>
    private readonly Dictionary<string, DateTimeOffset> coolDownUntil = new(StringComparer.OrdinalIgnoreCase);

    public async Task<string> GetAsync(string url, string agent = "TorrentFlow/1.0", int timeoutMs = 12000, string accept = "application/json", CancellationToken cancellationToken = default, bool validateApi = false, string? bearerToken = null)
    {
        ThrowIfCoolingDown(url);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(timeoutMs);
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("User-Agent", agent);
        request.Headers.TryAddWithoutValidation("Accept", accept);
        if (bearerToken is not null) request.Headers.Authorization = new("Bearer", bearerToken);
        if (agent.Contains("Chrome/131"))
        {
            request.Headers.TryAddWithoutValidation("Accept-Language", "en-US,en;q=0.9");
            request.Headers.TryAddWithoutValidation("Cache-Control", "no-cache");
            request.Headers.TryAddWithoutValidation("Pragma", "no-cache");
            request.Headers.TryAddWithoutValidation("Upgrade-Insecure-Requests", "1");
        }
        using var client = clients.CreateClient("TorrentFlow.Indexers");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        if (ShouldCoolDown(response))
        {
            NoteCoolDown(url, response);
            throw new HttpRequestException($"Indexer rate limited ({(int)response.StatusCode})", null, response.StatusCode);
        }
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
        (TorrentFlow.Core.Sources.SourceExecution.Current is { } source ? new[] { source.BaseUrl }.Concat(source.Mirrors) : (configured ?? "").Split(',').Concat(defaults))
        .Select(h => h.Trim().TrimEnd('/')).Where(h => Uri.TryCreate(h, UriKind.Absolute, out var u) && u.Scheme is "https" or "http")
        .Distinct(StringComparer.OrdinalIgnoreCase).Take(20).ToArray();

    public async Task<string> MirrorsAsync(string key, string[] hosts, Func<string, string> url, string agent, CancellationToken token)
    {
        string[] ordered;
        lock (gate)
        {
            foreach (var h in failed.Where(x => x.Value <= DateTimeOffset.UtcNow).Select(x => x.Key).ToArray()) failed.Remove(h);
            foreach (var h in coolDownUntil.Where(x => x.Value <= DateTimeOffset.UtcNow).Select(x => x.Key).ToArray()) coolDownUntil.Remove(h);
            preferred.TryGetValue(key, out var favorite);
            ordered = hosts
                .Where(h => !IsCoolingDown(HostKey(url(h))))
                .OrderBy(h => h == favorite ? 0 : failed.ContainsKey(key + "\0" + h) ? 2 : 1)
                .ToArray();
        }
        Exception? last = null;
        if (ordered.Length == 0)
        {
            // Every mirror is cooling down after a real site rate-limit signal.
            last = new HttpRequestException($"{key}: all mirrors are cooling down after rate limiting", null, HttpStatusCode.TooManyRequests);
            throw last;
        }
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
                        if (status != HttpStatusCode.NotFound || preferred.GetValueOrDefault(key) == host)
                        {
                            if (!preferred.ContainsKey(key) && preferred.Count >= 32) preferred.Remove(preferred.Keys.First());
                            preferred[key] = host;
                            throw;
                        }
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

    /// <summary>HTTP 429 always cools the site; 503 only when Retry-After is present.</summary>
    internal static bool ShouldCoolDown(HttpResponseMessage response) =>
        response.StatusCode == HttpStatusCode.TooManyRequests
        || (response.StatusCode == HttpStatusCode.ServiceUnavailable && RetryAfterSeconds(response) is not null);

    internal static int CoolDownSeconds(HttpResponseMessage response) =>
        Math.Clamp(RetryAfterSeconds(response) ?? DefaultCoolDownSeconds, 1, MaxCoolDownSeconds);

    internal static int? RetryAfterSeconds(HttpResponseMessage response)
    {
        if (response.Headers.RetryAfter?.Delta is { } delta) return Math.Max(1, (int)Math.Ceiling(delta.TotalSeconds));
        if (response.Headers.RetryAfter?.Date is { } date)
        {
            var seconds = (int)Math.Ceiling((date - DateTimeOffset.UtcNow).TotalSeconds);
            return seconds > 0 ? seconds : null;
        }
        return null;
    }

    private void ThrowIfCoolingDown(string url)
    {
        var host = HostKey(url);
        if (host.Length == 0) return;
        lock (gate)
        {
            if (!IsCoolingDown(host)) return;
            var wait = Math.Max(1, (int)Math.Ceiling((coolDownUntil[host] - DateTimeOffset.UtcNow).TotalSeconds));
            throw new HttpRequestException($"{host} is cooling down after rate limiting; retry after {wait}s", null, HttpStatusCode.TooManyRequests);
        }
    }

    private void NoteCoolDown(string url, HttpResponseMessage response)
    {
        var host = HostKey(url);
        if (host.Length == 0) return;
        var seconds = CoolDownSeconds(response);
        lock (gate)
        {
            if (coolDownUntil.Count >= 128)
                foreach (var stale in coolDownUntil.Where(x => x.Value <= DateTimeOffset.UtcNow).Select(x => x.Key).ToArray())
                    coolDownUntil.Remove(stale);
            if (coolDownUntil.Count >= 128) coolDownUntil.Remove(coolDownUntil.Keys.First());
            coolDownUntil[host] = DateTimeOffset.UtcNow.AddSeconds(seconds);
        }
        logger.LogInformation("Indexer {Host} cooling down for {Seconds}s after HTTP {Status}", host, seconds, (int)response.StatusCode);
    }

    private bool IsCoolingDown(string host)
    {
        if (host.Length == 0 || !coolDownUntil.TryGetValue(host, out var until)) return false;
        if (until > DateTimeOffset.UtcNow) return true;
        coolDownUntil.Remove(host);
        return false;
    }

    private static string HostKey(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.IdnHost.ToLowerInvariant() : "";
}
