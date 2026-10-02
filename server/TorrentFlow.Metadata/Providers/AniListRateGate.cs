using System.Globalization;
using System.Net;

namespace TorrentFlow.Metadata.Providers;

/// <summary>
/// The one pace for every AniList request this process makes (search, by-id, browse, airing, franchise walks,
/// backfills, links). AniList allows <c>X-RateLimit-Limit</c> requests a minute (90, or 30 while degraded) per client;
/// the gate counts what this process sent in the last minute and splits that allowance into fixed shares:
/// <list type="bullet">
/// <item>foreground requests (title pages, search, a grab's lookup) may use the whole allowance and never wait behind
/// a background one;</item>
/// <item>background requests (<see cref="TorrentFlow.Core.Contracts.Metadata.ProviderPriority"/>: backfills, links,
/// the hunter) may use at most a third of it, never the last <see cref="Reserve"/> requests of the minute, and none in
/// the first <see cref="StartupGrace"/> after start. Within that share they always progress.</item>
/// </list>
/// A 429 or an exhausted allowance blocks every caller until <c>Retry-After</c> (or <c>X-RateLimit-Reset</c>) passes.
/// Only the HTTP request itself waits here. One that would wait longer than it allows gets a synthetic 429
/// (<see cref="Refused"/>) instead, so a rate limit is reported as one and never as "not found".
/// </summary>
public sealed class AniListRateGate(TimeProvider time)
{
    private const int DefaultLimit = 90;
    /// <summary>Requests of each minute's allowance only foreground requests may spend.</summary>
    public const int Reserve = 5;
    /// <summary>How long after start background requests wait before their first one.</summary>
    public static readonly TimeSpan StartupGrace = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan Window = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan Poll = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan DefaultBlock = TimeSpan.FromSeconds(60);
    private readonly DateTimeOffset _started = time.GetUtcNow();
    private readonly Lock _sync = new();
    private readonly Queue<DateTimeOffset> _sent = new();
    private readonly Queue<DateTimeOffset> _sentBackground = new();
    private DateTimeOffset _blockedUntil;
    private DateTimeOffset _remainingAt;
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

    /// <summary>The most background requests a minute may hold: a third of the allowance, and never into the reserve.</summary>
    public int BackgroundShare
    {
        get
        {
            lock (_sync) return Share(_limit);
        }
    }

    private static int Share(int limit) => Math.Max(1, Math.Min(limit / 3, limit - Reserve));

    /// <summary>
    /// Waits for this request's slot and takes it. False (and nothing may be sent) when the slot is further off than
    /// <paramref name="maxWait"/>. <c>Waited</c> says why it waited, if it did: a foreground request waits only for AniList's
    /// own block or the minute's whole allowance, never for a background request's turn or share.
    /// </summary>
    /// <returns><c>Used</c> and <c>Sent</c>: the background and all requests of the last minute, this one included when granted.</returns>
    public async Task<(bool Granted, string? Waited, int Used, int Sent)> WaitTurnAsync(TimeSpan maxWait, CancellationToken ct, bool background = false)
    {
        var deadline = time.GetUtcNow() + maxWait;
        string? waited = null;
        while (true)
        {
            var (wait, reason, used, sent) = TryTake(background);
            if (wait == null) return (true, waited, used, sent);
            waited = reason;
            var now = time.GetUtcNow();
            if (now + wait.Value > deadline) return (false, reason, used, sent);
            // Foreground waits only for the minute's allowance or a block, so it re-checks often; background sleeps its hold out.
            var step = background ? wait.Value : wait.Value < Poll ? wait.Value : Poll;
            await Task.Delay(step > TimeSpan.Zero ? step : TimeSpan.FromMilliseconds(10), time, ct).ConfigureAwait(false);
        }
    }

    /// <summary>Takes a slot now (null wait), or says how long until one may free and why.</summary>
    private (TimeSpan? Wait, string? Reason, int Used, int Sent) TryTake(bool background)
    {
        var now = time.GetUtcNow();
        lock (_sync)
        {
            Trim(_sent, now);
            Trim(_sentBackground, now);
            var (used, sent) = (_sentBackground.Count, _sent.Count);
            if (_blockedUntil > now) return (_blockedUntil - now, "AniList is rate-limiting", used, sent);
            if (sent >= _limit) return (_sent.Peek() + Window - now, $"this minute's {_limit} requests are spent ({used} by background requests)", used, sent);
            if (background)
            {
                if (now < _started + StartupGrace)
                    return (_started + StartupGrace - now, "the first minute after start is kept for foreground requests", used, sent);
                var share = Share(_limit);
                if (used >= share)
                    return (_sentBackground.Peek() + Window - now, $"the background share ({share} a minute) is spent", used, sent);
                if (sent >= _limit - Reserve)
                    return (_sent.Peek() + Window - now, $"the last {Reserve} requests of the minute are kept for foreground requests", used, sent);
                if (_remaining is { } left && left <= Reserve && now - _remainingAt < Window)
                    return (_remainingAt + Window - now, $"AniList reports {left} requests left this minute, kept for foreground requests", used, sent);
                _sentBackground.Enqueue(now);
            }
            _sent.Enqueue(now);
            return (null, null, _sentBackground.Count, _sent.Count);
        }
    }

    private static void Trim(Queue<DateTimeOffset> sent, DateTimeOffset now)
    {
        while (sent.Count > 0 && now - sent.Peek() >= Window) sent.Dequeue();
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