using System.Collections.Concurrent;
using System.Net;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace TorrentFlow.Search.Adapters;

/// <summary>A site was left out of one request because it is cooling down or its line is full; retrying at once is pointless.</summary>
public sealed class SourceBusyException(string message) : HttpRequestException(message, null, HttpStatusCode.TooManyRequests);

public sealed class IndexerHttp(IHttpClientFactory clients, ILogger<IndexerHttp> logger, IOptions<SearchModuleOptions>? options = null)
{
    /// <summary>How long an interactive search waits for a cooling site before it skips that site.</summary>
    public static readonly TimeSpan InteractiveCoolDownWait = TimeSpan.FromSeconds(2);
    /// <summary>
    /// How long a download search waits out a site's cool-down. A site that keeps answering 429 gets longer cool-downs;
    /// past this wait it is left out of that one search (never counted as a miss; the wanted queue retries soon), so one
    /// blocked site never stalls every episode that other sites can supply.
    /// </summary>
    public static readonly TimeSpan PatientCoolDownWait = TimeSpan.FromSeconds(DefaultCoolDownSeconds);
    private readonly ConcurrentDictionary<string, HostGate> gates = new(StringComparer.OrdinalIgnoreCase);
    public const string BrowserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
    /// <summary>Default cool-down when a site rate-limits without a usable Retry-After.</summary>
    public const int DefaultCoolDownSeconds = 30;
    /// <summary>Hard cap on per-site cool-down after 429 / 503+Retry-After.</summary>
    public const int MaxCoolDownSeconds = 300;
    /// <summary>Upper bound for a site's gap between requests after it keeps answering 429.</summary>
    public const int MaxAdaptiveSpacingMs = 15000;
    private readonly object gate = new();
    private readonly Dictionary<string, DateTimeOffset> failed = [];
    private readonly Dictionary<string, string> preferred = [];
    /// <summary>Host → UTC time until which that site is skipped after a real 429/503+Retry-After.</summary>
    private readonly Dictionary<string, DateTimeOffset> coolDownUntil = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>Host → 429s in a row; each one without a Retry-After doubles the cool-down, a success clears it.</summary>
    private readonly Dictionary<string, int> strikes = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// How long a search reuses a site's answer to the exact same request. A season asks the same site the same thing many
    /// times (the same query in several categories that map to one site request, the relaxed rung, the show lookup every
    /// episode shares, a quick retry); each distinct request is sent once and every other asker shares its answer.
    /// </summary>
    public static readonly TimeSpan AnswerReuse = TimeSpan.FromMinutes(5);
    private static readonly AsyncLocal<SearchScope?> ambient = new();
    private readonly ConcurrentDictionary<string, Answer> answers = new(StringComparer.Ordinal);
    private sealed record Answer(DateTimeOffset At, Task<string> Body);

    /// <summary>
    /// What a search's requests share while <see cref="Use"/> is in effect: identical requests are sent once, and each
    /// request that really goes out waits its turn at its site (<see cref="EnterAsync"/>) for at most <paramref name="LineWait"/>,
    /// then takes a <paramref name="Slot"/> and calls <paramref name="Started"/> (so a per-attempt deadline counts only the site's own time).
    /// <paramref name="Urgent"/> requests (an owner's click) go first in each site's line even when <paramref name="Patient"/>.
    /// </summary>
    public sealed record SearchScope(bool Patient, TimeSpan LineWait, Func<CancellationToken, Task<IDisposable>>? Slot = null, Action? Started = null, bool Urgent = false);

    public static IDisposable Use(SearchScope scope)
    {
        var previous = ambient.Value;
        ambient.Value = scope;
        return new Restore(() => ambient.Value = previous);
    }

    /// <summary>True inside a search's <see cref="Use"/>: requests are paced per site and each one is timed on its own.</summary>
    public static bool Scoped => ambient.Value != null;

    private sealed class Restore(Action undo) : IDisposable
    {
        public void Dispose() => undo();
    }

    public Task<string> GetAsync(string url, string agent = "TorrentFlow/1.0", int timeoutMs = 12000, string accept = "application/json", CancellationToken cancellationToken = default, bool validateApi = false, string? bearerToken = null, string? jsonBody = null)
    {
        if (ambient.Value is not { } scope) return SendAsync(url, agent, timeoutMs, accept, cancellationToken, validateApi, bearerToken, jsonBody);
        var key = $"{url}\n{accept}\n{validateApi}\n{bearerToken}\n{jsonBody}";
        var now = DateTimeOffset.UtcNow;
        if (answers.TryGetValue(key, out var known) && now - known.At < AnswerReuse && !known.Body.IsFaulted && !known.Body.IsCanceled)
            return known.Body.WaitAsync(cancellationToken);
        if (answers.Count > 1024)
            foreach (var stale in answers.Where(a => now - a.Value.At >= AnswerReuse).Select(a => a.Key).ToArray()) answers.TryRemove(stale, out _);
        var fresh = new Answer(now, SendScopedAsync(scope, url, agent, timeoutMs, accept, cancellationToken, validateApi, bearerToken, jsonBody));
        var shared = known == null ? answers.GetOrAdd(key, fresh) : answers.TryUpdate(key, fresh, known) ? fresh : answers.GetValueOrDefault(key) ?? fresh;
        if (!ReferenceEquals(shared, fresh))
        {
            fresh.Body.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);
            return shared.Body.WaitAsync(cancellationToken);
        }
        // A failed or cancelled request is never shared: the next asker sends its own.
        fresh.Body.ContinueWith(_ => answers.TryRemove(new KeyValuePair<string, Answer>(key, fresh)), CancellationToken.None,
            TaskContinuationOptions.NotOnRanToCompletion | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        return fresh.Body;
    }

    private async Task<string> SendScopedAsync(SearchScope scope, string url, string agent, int timeoutMs, string accept, CancellationToken ct, bool validateApi, string? bearerToken, string? jsonBody)
    {
        IDisposable? turn = null, slot = null;
        try
        {
            using (var bounded = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                bounded.CancelAfter(scope.LineWait);
                try { turn = await EnterAsync(url, scope.Patient, bounded.Token, scope.Urgent || !scope.Patient); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    throw new SourceBusyException($"{HostKey(url)} is busy; skipped for now");
                }
            }
            if (scope.Slot != null) slot = await scope.Slot(ct);
            scope.Started?.Invoke();
            var budget = TorrentFlow.Core.Sources.SourceExecution.Current?.TimeoutMs is int configured ? Math.Min(configured, timeoutMs) : timeoutMs;
            return await SendAsync(url, agent, budget, accept, ct, validateApi, bearerToken, jsonBody);
        }
        finally
        {
            slot?.Dispose();
            turn?.Dispose();
        }
    }

    private async Task<string> SendAsync(string url, string agent, int timeoutMs, string accept, CancellationToken cancellationToken, bool validateApi, string? bearerToken, string? jsonBody = null)
    {
        ThrowIfCoolingDown(url);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(timeoutMs);
        using var request = new HttpRequestMessage(jsonBody is null ? HttpMethod.Get : HttpMethod.Post, url)
            { Content = jsonBody is null ? null : new StringContent(jsonBody, System.Text.Encoding.UTF8, "application/json") };
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
        logger.LogDebug("Indexer request {Host} answered {Status}: {Url}", HostKey(url), (int)response.StatusCode, url);
        if (ShouldCoolDown(response))
        {
            NoteCoolDown(url, response);
            throw new HttpRequestException($"Indexer rate limited ({(int)response.StatusCode})", null, response.StatusCode);
        }
        response.EnsureSuccessStatusCode();
        if (gates.TryGetValue(HostKey(url), out var paced))
        {
            paced.Faster();
            lock (gate) strikes.Remove(HostKey(url));
        }
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
        int seconds;
        lock (gate)
        {
            var strike = strikes.GetValueOrDefault(host);
            if (strikes.Count >= 128 && strike == 0) strikes.Remove(strikes.Keys.First());
            strikes[host] = Math.Min(strike + 1, 8);
            seconds = RetryAfterSeconds(response) is { } after ? Math.Clamp(after, 1, MaxCoolDownSeconds)
                : Math.Min(MaxCoolDownSeconds, DefaultCoolDownSeconds << Math.Min(strike, 4));
            if (coolDownUntil.Count >= 128)
                foreach (var stale in coolDownUntil.Where(x => x.Value <= DateTimeOffset.UtcNow).Select(x => x.Key).ToArray())
                    coolDownUntil.Remove(stale);
            if (coolDownUntil.Count >= 128) coolDownUntil.Remove(coolDownUntil.Keys.First());
            coolDownUntil[host] = DateTimeOffset.UtcNow.AddSeconds(seconds);
        }
        var spacing = 0;
        if (gates.TryGetValue(host, out var line))
        {
            line.Slower();
            spacing = line.SpacingMs;
        }
        logger.LogInformation("Indexer {Host} cooling down for {Seconds}s after HTTP {Status}; requests now {Spacing}ms apart", host, seconds, (int)response.StatusCode, spacing);
    }

    private bool IsCoolingDown(string host)
    {
        if (host.Length == 0 || !coolDownUntil.TryGetValue(host, out var until)) return false;
        if (until > DateTimeOffset.UtcNow) return true;
        coolDownUntil.Remove(host);
        return false;
    }

    /// <summary>The site of <paramref name="url"/> is cooling down after a real 429, or a 503 with Retry-After: busy, not down.</summary>
    internal bool CoolingDown(string url)
    {
        lock (gate) return IsCoolingDown(HostKey(url));
    }

    private static string HostKey(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.IdnHost.ToLowerInvariant() : "";

    /// <summary>
    /// Takes a turn at one site: at most the site's concurrency open at once, request starts spaced by its pacing, and
    /// nothing sent while the site is cooling down after a real 429/503. <paramref name="patient"/> callers (downloads,
    /// the wanted queue) wait for a cool-down of up to <see cref="PatientCoolDownWait"/>, bounded by their token;
    /// interactive callers wait at most <see cref="InteractiveCoolDownWait"/>. Past that the site is skipped for this
    /// request with a 429, which never counts as a miss. <paramref name="urgent"/> callers (interactive searches and an
    /// owner's click) go first in the line, so a season's searches never hold up a click; it defaults to !patient.
    /// Dispose the returned turn when the request is done.
    /// </summary>
    public async Task<IDisposable> EnterAsync(string url, bool patient, CancellationToken ct, bool? urgent = null)
    {
        var host = HostKey(url);
        if (host.Length == 0) return NoTurn.Instance;
        var pacing = PacingFor(host);
        var bound = patient ? PatientCoolDownWait : InteractiveCoolDownWait;
        ThrowIfBusy(host, bound);
        var line = gates.GetOrAdd(host, _ => new HostGate(pacing.Concurrency, pacing.SpacingMs));
        if (!patient)
            lock (line)
                if (line.NextStart - DateTimeOffset.UtcNow > bound) throw new SourceBusyException($"{host} is busy; skipped for now");
        await line.AcquireAsync(urgent: urgent ?? !patient, ct);
        try
        {
            while (true)
            {
                TimeSpan wait;
                bool reserved;
                lock (line)
                {
                    var now = DateTimeOffset.UtcNow;
                    DateTimeOffset cool;
                    lock (gate) cool = coolDownUntil.GetValueOrDefault(host);
                    if (cool > now)
                    {
                        if (cool - now > bound)
                            throw new SourceBusyException($"{host} is busy after rate limiting; skipped for now");
                        wait = cool - now;
                        reserved = false;
                    }
                    else
                    {
                        var start = line.NextStart > now ? line.NextStart : now;
                        if (!patient && start - now > bound) throw new SourceBusyException($"{host} is busy; skipped for now");
                        line.NextStart = start.AddMilliseconds(line.SpacingMs);
                        wait = start - now;
                        reserved = true;
                    }
                }
                if (wait > TimeSpan.Zero) await Task.Delay(wait, ct);
                if (reserved) return new Turn(line);
            }
        }
        catch
        {
            line.Release();
            throw;
        }
    }

    private void ThrowIfBusy(string host, TimeSpan bound)
    {
        lock (gate)
        {
            if (coolDownUntil.TryGetValue(host, out var until) && until - DateTimeOffset.UtcNow > bound)
                throw new SourceBusyException($"{host} is busy after rate limiting; skipped for now");
        }
    }

    private SourcePacing PacingFor(string host)
    {
        var configured = options?.Value;
        if (configured == null) return new SourcePacing { Concurrency = 2, SpacingMs = 0 };
        return configured.Pacing.TryGetValue(host, out var exact) ? exact
            : configured.Pacing.FirstOrDefault(p => host.EndsWith("." + p.Key, StringComparison.OrdinalIgnoreCase)).Value ?? configured.DefaultPacing;
    }

    private sealed class NoTurn : IDisposable
    {
        public static readonly NoTurn Instance = new();
        public void Dispose() { }
    }

    private sealed class Turn(HostGate gate) : IDisposable
    {
        private int disposed;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) == 0) gate.Release();
        }
    }

    /// <summary>A small per-site line: urgent (interactive) waiters are served before patient (background) ones.</summary>
    private sealed class HostGate(int concurrency, int spacingMs)
    {
        /// <summary>Current gap between request starts: doubles on every real 429 and eases back to the configured gap on success.</summary>
        public int SpacingMs { get; private set; } = spacingMs;
        private readonly int configuredSpacingMs = spacingMs;
        private DateTimeOffset slowedAt;
        public void Slower()
        {
            lock (this)
            {
                // Requests already in flight answer 429 together; count that burst once.
                if (DateTimeOffset.UtcNow - slowedAt < TimeSpan.FromSeconds(5)) return;
                slowedAt = DateTimeOffset.UtcNow;
                SpacingMs = Math.Min(MaxAdaptiveSpacingMs, Math.Max(1000, SpacingMs * 2));
            }
        }
        public void Faster() { lock (this) SpacingMs = Math.Max(configuredSpacingMs, SpacingMs - SpacingMs / 10); }

        private readonly LinkedList<TaskCompletionSource> urgent = new();
        private readonly LinkedList<TaskCompletionSource> patient = new();
        private int active;
        public DateTimeOffset NextStart;

        public async Task AcquireAsync(bool urgent, CancellationToken ct)
        {
            TaskCompletionSource waiter;
            LinkedListNode<TaskCompletionSource> node;
            lock (this)
            {
                if (active < Math.Max(1, concurrency) && this.urgent.Count == 0 && patient.Count == 0)
                {
                    active++;
                    return;
                }
                waiter = new(TaskCreationOptions.RunContinuationsAsynchronously);
                node = (urgent ? this.urgent : patient).AddLast(waiter);
            }
            using var registration = ct.Register(() =>
            {
                lock (this)
                {
                    if (node.List == null) return;
                    node.List.Remove(node);
                }
                waiter.TrySetCanceled(ct);
            });
            await waiter.Task;
        }

        public void Release()
        {
            TaskCompletionSource? next;
            lock (this)
            {
                var line = urgent.Count > 0 ? urgent : patient;
                next = line.First?.Value;
                if (next != null) line.RemoveFirst();
                else active--;
            }
            next?.TrySetResult();
        }
    }
}
