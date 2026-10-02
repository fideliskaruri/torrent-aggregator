using System.Globalization;
using System.Net;

namespace TorrentFlow.Metadata.Providers;

/// <summary>
/// The one pace for every AniList request this process makes (search, by-id, browse, airing, franchise walks,
/// backfills, links): AniList allows <c>X-RateLimit-Limit</c> requests a minute (90, or 30 while degraded) per client.
/// While more than half the minute's allowance remains, requests go straight out; below that they are spaced evenly
/// over what is left of the minute. A 429 or an exhausted allowance blocks every caller until <c>Retry-After</c> (or
/// <c>X-RateLimit-Reset</c>) passes. A caller that would wait longer than it allows gets a synthetic 429 instead of a
/// request, so a rate limit is reported as one and never as "not found".
/// Two priorities share it (<see cref="TorrentFlow.Core.Contracts.Metadata.ProviderPriority"/>): foreground requests
/// (title pages, search, a grab's lookup) always go first. Background requests (backfills, links, the hunter) wait
/// <see cref="StartupGrace"/> after start, go only while no foreground request is waiting, and never spend the last
/// <see cref="Reserve"/> requests of the minute, so a restart's catch-up work never empties a title page.
/// </summary>
public sealed class AniListRateGate(TimeProvider time)
{
    private const int DefaultLimit = 90;
    /// <summary>Requests of each minute's allowance only foreground calls may spend.</summary>
    public const int Reserve = 5;
    /// <summary>How long after start background requests wait before their first one.</summary>
    public static readonly TimeSpan StartupGrace = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan Window = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan Poll = TimeSpan.FromMilliseconds(250);
    private readonly DateTimeOffset _started = time.GetUtcNow();
    private int _foregroundWaiting;
    private DateTimeOffset _remainingAt;
    private static readonly TimeSpan DefaultBlock = TimeSpan.FromSeconds(60);
    private readonly SemaphoreSlim _turn = new(1, 1);
    private readonly Lock _sync = new();
    private DateTimeOffset _next;
    private DateTimeOffset _blockedUntil;
    private int _limit = DefaultLimit;
    private int? _remaining;

    /// <summary>When AniList refuses requests until, after a 429 or an exhausted allowance; null when it doesn't.</summary>
    public DateTimeOffset? BlockedUntil
    {
        get
        {
            lock (_sync) return _blockedUntil > time.GetUtcNow() ? _blockedUntil : null;
        }
    }

    /// <summary>Why a background request must wait right now, and for about how long; null when it may go.</summary>
    public (string Reason, TimeSpan Wait)? BackgroundHold()
    {
        var now = time.GetUtcNow();
        lock (_sync)
        {
            if (now < _started + StartupGrace) return ("the first minute after start is kept for foreground requests", _started + StartupGrace - now);
            if (_blockedUntil > now) return ("AniList is rate-limiting", _blockedUntil - now);
            if (Volatile.Read(ref _foregroundWaiting) > 0) return ("a foreground request is waiting", Poll);
            if (_remaining is { } left && left <= Reserve && now - _remainingAt < Window)
                return ($"only {left} requests are left this minute, kept for foreground requests", _remainingAt + Window - now);
            return null;
        }
    }

    /// <summary>Waits until a background request may go; false when that is further off than <paramref name="deadline"/>.</summary>
    public async Task<bool> WaitBackgroundAsync(DateTimeOffset? deadline, CancellationToken ct)
    {
        while (BackgroundHold() is { } hold)
        {
            var now = time.GetUtcNow();
            var step = hold.Wait > Poll ? hold.Wait : Poll;
            if (deadline is { } end)
            {
                // A hold that outlasts the caller's patience refuses at once; a waiting foreground request is polled.
                if (now >= end || hold.Wait > Poll && now + hold.Wait > end) return false;
                if (now + step > end) step = end - now;
            }
            await Task.Delay(step, time, ct).ConfigureAwait(false);
        }
        return true;
    }

    /// <summary>
    /// Waits for this caller's turn; false (and nothing sent) when that is further off than <paramref name="maxWait"/>.
    /// A background caller also waits for <see cref="BackgroundHold"/> to clear.
    /// </summary>
    public async Task<bool> WaitTurnAsync(TimeSpan maxWait, CancellationToken ct, bool background = false)
    {
        var deadline = time.GetUtcNow() + maxWait;
        if (!background) Interlocked.Increment(ref _foregroundWaiting);
        try
        {
            while (true)
            {
                if (background && !await WaitBackgroundAsync(deadline, ct).ConfigureAwait(false)) return false;
                var left = deadline - time.GetUtcNow();
                if (left < TimeSpan.Zero || !await _turn.WaitAsync(left, ct).ConfigureAwait(false)) return false;
                // A foreground request that arrived while this background one waited for the turn goes first.
                if (background && BackgroundHold() != null) { _turn.Release(); continue; }
                try { return await TakeTurnAsync(deadline, ct).ConfigureAwait(false); }
                finally { _turn.Release(); }
            }
        }
        finally { if (!background) Interlocked.Decrement(ref _foregroundWaiting); }
    }

    private async Task<bool> TakeTurnAsync(DateTimeOffset deadline, CancellationToken ct)
    {
        DateTimeOffset at;
        TimeSpan spacing;
        lock (_sync)
        {
            at = _next > _blockedUntil ? _next : _blockedUntil;
            spacing = _remaining is { } left && left * 2 < _limit ? TimeSpan.FromSeconds(60.0 / Math.Max(_limit, 1)) : TimeSpan.Zero;
        }
        var now = time.GetUtcNow();
        if (at > deadline) return false;
        if (at > now) await Task.Delay(at - now, time, ct).ConfigureAwait(false);
        lock (_sync) _next = time.GetUtcNow() + spacing;
        return true;
    }

    /// <summary>Reads AniList's rate headers off a response; a 429 or a spent allowance blocks every caller until it resets.</summary>
    /// <returns>The new block time when this response blocks every caller, else null.</returns>
    public DateTimeOffset? Observe(HttpResponseMessage response)
    {
        var now = time.GetUtcNow();
        var limit = Header(response, "X-RateLimit-Limit");
        var remaining = Header(response, "X-RateLimit-Remaining");
        var reset = Header(response, "X-RateLimit-Reset");
        var retryAfter = response.Headers.RetryAfter is { } r
            ? r.Delta ?? (r.Date is { } date ? date - now : null)
            : Header(response, "Retry-After") is { } seconds ? TimeSpan.FromSeconds(seconds) : null;
        lock (_sync)
        {
            if (limit is > 0) _limit = limit.Value;
            if (remaining != null) { _remaining = remaining; _remainingAt = now; }
            DateTimeOffset? until = null;
            if (response.StatusCode == HttpStatusCode.TooManyRequests)
                until = now + (retryAfter is { } wait && wait > TimeSpan.Zero ? wait : reset is > 0 ? DateTimeOffset.FromUnixTimeSeconds(reset.Value) - now : DefaultBlock);
            else if (remaining == 0)
                until = reset is > 0 ? DateTimeOffset.FromUnixTimeSeconds(reset.Value) : now + DefaultBlock;
            if (until is not { } u || u <= _blockedUntil) return null;
            _blockedUntil = u > now + TimeSpan.FromMinutes(10) ? now + TimeSpan.FromMinutes(10) : u;
            return _blockedUntil;
        }
    }

    /// <summary>The 429 a caller gets instead of a request when its turn is too far off.</summary>
    public HttpResponseMessage Refused()
    {
        var response = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
        var wait = (BlockedUntil ?? time.GetUtcNow()) - time.GetUtcNow();
        response.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(wait > TimeSpan.Zero ? wait : TimeSpan.FromSeconds(1));
        return response;
    }

    private static int? Header(HttpResponseMessage response, string name) =>
        response.Headers.TryGetValues(name, out var values) && values.FirstOrDefault() is { } raw &&
        int.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) ? value : null;
}
