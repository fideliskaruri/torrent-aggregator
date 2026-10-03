using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed record ProviderAnswer(JsonElement? Json, bool Stale, bool Complete, Failure? Failure);

internal sealed class ProviderHttp(CatalogStore store) : IDisposable
{
    internal static readonly AsyncLocal<bool> Background = new();
    private readonly long startedAt = Stopwatch.GetTimestamp();
    private sealed class Gate(int concurrency, int spacing)
    {
        internal readonly SemaphoreSlim Slots = new(concurrency);
        internal readonly SemaphoreSlim Starts = new(1);
        internal readonly SemaphoreSlim BackgroundSlots = new(Math.Max(1, concurrency - 1));
        internal readonly int Spacing = spacing;
        internal long LastStart;
        internal DateTimeOffset? Cooldown;
        internal int Strikes;
        internal int Pending;
    }

    private readonly HttpClient client = new(new SocketsHttpHandler
    {
        AutomaticDecompression = DecompressionMethods.All, ConnectTimeout = TimeSpan.FromSeconds(4),
        PooledConnectionLifetime = TimeSpan.FromMinutes(10),
    }) { Timeout = Timeout.InfiniteTimeSpan };
    private readonly ConcurrentDictionary<string, Lazy<Task<ProviderAnswer>>> flights = new();
    private readonly ConcurrentDictionary<string, MetadataCacheRow> memory = new();
    private readonly ConcurrentDictionary<string, (ProviderAnswer Answer, DateTimeOffset Until)> misses = new();
    private readonly Dictionary<string, Gate> gates = new(StringComparer.Ordinal)
    {
        ["tmdb"] = new(4, 50), ["anilist"] = new(2, 700), ["cinemeta"] = new(4, 100),
        ["imdb"] = new(2, 100), ["tvmaze"] = new(2, 200), ["itunes"] = new(2, 200), ["fribb"] = new(1, 0),
    };

    internal async Task<ProviderAnswer> FetchAsync(string provider, string key, Func<HttpRequestMessage> request,
        TimeSpan ttl, CancellationToken ct, int timeoutSeconds = 10, int maxBytes = 8 * 1024 * 1024,
        bool force = false, CacheKind kind = CacheKind.ProviderDetail, Func<JsonElement, bool>? validate = null)
    {
        var id = Id(provider + ":" + key);
        if (!force && misses.TryGetValue(id, out var missing) && missing.Until > DateTimeOffset.UtcNow)
            return missing.Answer;
        var previous = memory.GetValueOrDefault(id)
            ?? (await store.ReadAsync<MetadataCacheRow>(CatalogStore.Query(id), ct)).FirstOrDefault();
        if (!force && previous is { Complete: true } && previous.ExpiresAt > DateTimeOffset.UtcNow)
            return new(previous.Payload, false, true, null);
        var flight = flights.GetOrAdd(id, _ => new Lazy<Task<ProviderAnswer>>(
            () => SendAsync(provider, key, id, request, ttl, previous, timeoutSeconds, maxBytes, kind, validate),
            LazyThreadSafetyMode.ExecutionAndPublication));
        try { return await flight.Value.WaitAsync(ct); }
        finally
        {
            if (flight.IsValueCreated && flight.Value.IsCompleted)
                flights.TryRemove(new KeyValuePair<string, Lazy<Task<ProviderAnswer>>>(id, flight));
            else _ = flight.Value.ContinueWith(_ => flights.TryRemove(
                new KeyValuePair<string, Lazy<Task<ProviderAnswer>>>(id, flight)),
                CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        }
    }

    private async Task<ProviderAnswer> SendAsync(string provider, string key, string id,
        Func<HttpRequestMessage> create, TimeSpan ttl, MetadataCacheRow? previous,
        int timeoutSeconds, int maxBytes, CacheKind kind, Func<JsonElement, bool>? validate)
    {
        var gate = gates[provider];
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));
        var ct = deadline.Token;
        var entered = false;
        var backgroundEntered = false;
        Interlocked.Increment(ref gate.Pending);
        try
        {
            if (Volatile.Read(ref gate.Pending) > 64)
                return Failed("provider_busy", "The catalog is busy. Try again shortly.", DateTimeOffset.UtcNow.AddSeconds(10));
            var enabled = (await store.SettingsAsync(ct)).EnabledProviders;
            if (provider != "fribb" && !enabled.Contains(provider == "imdb" ? "cinemeta" : provider))
                return Failed("provider_disabled", "This catalog is disabled in Settings.", null);
            if (gate.Cooldown is { } due && due > DateTimeOffset.UtcNow)
                return Failed("rate_limited", "The catalog is busy. Try again after its cooldown.", due);
            if (Background.Value)
            {
                await gate.BackgroundSlots.WaitAsync(ct);
                backgroundEntered = true;
            }
            await gate.Slots.WaitAsync(ct);
            entered = true;
            await gate.Starts.WaitAsync(ct);
            try
            {
                if (provider == "anilist" && Background.Value &&
                    Stopwatch.GetElapsedTime(startedAt) < TimeSpan.FromSeconds(60))
                    return Failed("provider_busy", "Catalog maintenance will resume after startup.", DateTimeOffset.UtcNow.AddMinutes(1));
                if (gate.Cooldown is { } blocked && blocked > DateTimeOffset.UtcNow)
                    return Failed("rate_limited", "The catalog is busy. Try again after its cooldown.", blocked);
                var wait = gate.Spacing - Stopwatch.GetElapsedTime(gate.LastStart).TotalMilliseconds;
                if (wait > 0) await Task.Delay(TimeSpan.FromMilliseconds(wait), ct);
                gate.LastStart = Stopwatch.GetTimestamp();
            }
            finally { gate.Starts.Release(); }
            using var request = create();
            request.Headers.UserAgent.ParseAdd("TorrentFlow/0.2");
            if (previous?.Etag is { } etag) request.Headers.TryAddWithoutValidation("If-None-Match", etag);
            if (previous?.LastModified is { } modified) request.Headers.TryAddWithoutValidation("If-Modified-Since", modified);
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            var now = DateTimeOffset.UtcNow;
            if (response.StatusCode == HttpStatusCode.TooManyRequests ||
                response.StatusCode == HttpStatusCode.ServiceUnavailable && response.Headers.RetryAfter is not null)
            {
                var retry = response.Headers.RetryAfter;
                gate.Cooldown = retry?.Date ?? now + (retry?.Delta ??
                    TimeSpan.FromSeconds(Math.Min(300, 30 * Math.Pow(2, Math.Min(gate.Strikes++, 4)))));
                return Failed("rate_limited", "The catalog is busy. Try again after its cooldown.", gate.Cooldown);
            }
            JsonElement payload;
            if (response.StatusCode == HttpStatusCode.NotModified && previous is not null)
                payload = previous.Payload;
            else
            {
                if (response.StatusCode == HttpStatusCode.NotFound)
                {
                    var absent = new ProviderAnswer(null, false, true,
                        new("not_found", "This catalog entry was not found.", null, false));
                    if (misses.Count >= 500) misses.TryRemove(misses.MinBy(p => p.Value.Until).Key, out _);
                    misses[id] = (absent, now.AddMinutes(3));
                    return absent;
                }
                if (!response.IsSuccessStatusCode)
                    return Failed("provider_failed", "The catalog did not answer. Try again later.", null);
                if (response.Content.Headers.ContentLength > maxBytes) throw new InvalidDataException("Catalog response is too large.");
                await using var stream = await response.Content.ReadAsStreamAsync(ct);
                using var buffer = new MemoryStream();
                var chunk = new byte[81920];
                int count;
                while ((count = await stream.ReadAsync(chunk, ct)) != 0)
                {
                    if (buffer.Length + count > maxBytes) throw new InvalidDataException("Catalog response is too large.");
                    buffer.Write(chunk, 0, count);
                }
                buffer.Position = 0;
                using var document = await JsonDocument.ParseAsync(buffer, cancellationToken: ct);
                payload = document.RootElement.Clone();
                if (validate is not null && !validate(payload))
                    return Failed("invalid_catalog", "The catalog returned incomplete data. Try again later.", null);
                if (payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("errors", out var errors)
                    && errors.ValueKind == JsonValueKind.Array && errors.GetArrayLength() > 0)
                    return Failed("provider_failed", "The catalog could not complete this lookup. Try again later.", null);
            }
            gate.Strikes = 0;
            var row = new MetadataCacheRow(id, kind, provider + ":" + key, payload, now, now + ttl,
                response.Headers.ETag?.ToString() ?? previous?.Etag,
                response.Content.Headers.LastModified?.ToString("R") ?? previous?.LastModified, true, provider);
            var commit = await store.CommitAsync([new(row, null, previous)], null, ct);
            if (commit.Applied)
            {
                if (memory.Count >= 500) memory.TryRemove(memory.MinBy(p => p.Value.FetchedAt).Key, out _);
                memory[id] = row;
            }
            return new(payload, false, true, null);
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or JsonException
            or IOException)
        {
            return Failed("provider_unavailable", "The catalog could not be reached. Try again later.", null);
        }
        finally
        {
            if (entered) gate.Slots.Release();
            if (backgroundEntered) gate.BackgroundSlots.Release();
            Interlocked.Decrement(ref gate.Pending);
        }

        ProviderAnswer Failed(string code, string message, DateTimeOffset? retry)
        {
            var stale = previous is not null && (previous.Kind != CacheKind.TitleSearch ||
                previous.FetchedAt > DateTimeOffset.UtcNow.AddDays(-1)) ? previous : null;
            return new(stale?.Payload, stale is not null, false, new(code, message, retry, false));
        }
    }

    internal static string Id(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    public void Dispose()
    {
        client.Dispose();
        foreach (var gate in gates.Values) { gate.Slots.Dispose(); gate.Starts.Dispose(); gate.BackgroundSlots.Dispose(); }
    }
}
