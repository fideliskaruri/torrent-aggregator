using System.Text.RegularExpressions;
using TorrentFlow.Metadata.Caching;

namespace TorrentFlow.Metadata.Search;

/// <summary>Port of normalizeError (src/lib/observability/logging.ts): stable, non-leaky error code + message.</summary>
public static partial class SafeErrors
{
    public sealed record SafeError(string Code, string Message);

    [GeneratedRegex(@"\b(401|403|unauthori[sz]ed|authentication|login failed)\b")] private static partial Regex Auth();
    [GeneratedRegex(@"\b(prisma|sqlite|database|sql_|p1001|p1008)\b")] private static partial Regex Db();
    [GeneratedRegex(@"\b(timeout|timed out|etimedout|aborterror)\b")] private static partial Regex Timeout();
    [GeneratedRegex(@"\b(econnrefused|econnreset|enotfound|enetunreach|ehostunreach|fetch failed|networkerror|unreachable|not listening|cannot reach)\b")] private static partial Regex Net();
    [GeneratedRegex(@"\b(enoent|not found|missing)\b")] private static partial Regex NotFound();
    [GeneratedRegex(@"\b(syntaxerror|invalid|malformed|validation)\b")] private static partial Regex Input();

    public static SafeError Normalize(Exception? error)
    {
        var text = error == null ? "" : $"{error.GetType().Name} {error.Message} {error.InnerException?.Message}".ToLowerInvariant();
        if (error is OperationCanceledException or TimeoutException) text += " timeout";
        if (error is HttpRequestException { StatusCode: null }) text += " fetch failed";
        if (text.Length > 2000) text = text[..2000];
        if (Auth().IsMatch(text)) return new("AUTHENTICATION_FAILED", "Authentication failed.");
        if (Db().IsMatch(text)) return new("DATABASE_UNAVAILABLE", "The database is unavailable.");
        if (Timeout().IsMatch(text)) return new("OPERATION_TIMEOUT", "The operation timed out.");
        if (Net().IsMatch(text)) return new("UPSTREAM_UNAVAILABLE", "A required service is unavailable.");
        if (NotFound().IsMatch(text)) return new("NOT_FOUND", "The requested resource was not found.");
        if (Input().IsMatch(text)) return new("INVALID_INPUT", "The request could not be processed.");
        return new("INTERNAL_ERROR", "The operation could not be completed.");
    }
}

/// <summary>Port of rateLimit (src/lib/torrents/search-cache.ts): fixed 60s window per key, bounded bucket table.</summary>
public sealed class RateLimiter(TimeProvider time)
{
    internal const int MaxBuckets = 10_000;
    private readonly Lock _gate = new();
    private readonly Dictionary<string, (int Count, DateTimeOffset Reset)> _buckets = new(StringComparer.Ordinal);
    internal int BucketCount { get { lock (_gate) return _buckets.Count; } }

    public bool Allow(string key, int max = 40)
    {
        var now = time.GetUtcNow();
        lock (_gate)
        {
            if (!_buckets.TryGetValue(key, out var bucket) || bucket.Reset < now)
            {
                if (!_buckets.ContainsKey(key) && _buckets.Count >= MaxBuckets)
                {
                    foreach (var stale in _buckets.Where(b => b.Value.Reset < now).Select(b => b.Key).ToArray()) _buckets.Remove(stale);
                    if (_buckets.Count >= MaxBuckets) _buckets.Remove(_buckets.Keys.First());
                }
                _buckets[key] = (1, now.AddMinutes(1));
                return true;
            }
            if (bucket.Count >= max) return false;
            _buckets[key] = (bucket.Count + 1, bucket.Reset);
            return true;
        }
    }

    public static string ClientKey(Microsoft.AspNetCore.Http.HttpRequest request)
    {
        var forwarded = request.Headers["x-forwarded-for"].ToString();
        var first = forwarded.Split(',')[0].Trim();
        return first.Length > 0 ? first : "local";
    }
}

public sealed class AllProvidersFailedException(IReadOnlyList<string> failed, Exception? cause)
    : Exception("All title providers failed", cause)
{
    public IReadOnlyList<string> Failed { get; } = failed;
}
