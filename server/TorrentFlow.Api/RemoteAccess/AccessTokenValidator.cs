using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace TorrentFlow.Api.RemoteAccess;

/// <summary>Fetches a Cloudflare Access team's signing keys. Tests replace this with in-memory keys.</summary>
public interface IAccessKeySource
{
    Task<IReadOnlyList<SecurityKey>> FetchSigningKeysAsync(string teamDomain, CancellationToken ct);
}

public sealed class HttpAccessKeySource(IHttpClientFactory httpClientFactory) : IAccessKeySource
{
    public const string HttpClientName = "cloudflare-access";

    public static string CertsUrl(string teamDomain) => $"https://{teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs";

    public async Task<IReadOnlyList<SecurityKey>> FetchSigningKeysAsync(string teamDomain, CancellationToken ct)
    {
        using var client = httpClientFactory.CreateClient(HttpClientName);
        using var response = await client.GetAsync(CertsUrl(teamDomain), ct);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"Cloudflare Access certs answered {(int)response.StatusCode}.", null, response.StatusCode);
        var json = await response.Content.ReadAsStringAsync(ct);
        var keys = new JsonWebKeySet(json).GetSigningKeys()
            .Where(k => k is not JsonWebKey jwk || string.Equals(jwk.Kty, "RSA", StringComparison.Ordinal))
            .ToList();
        if (keys.Count == 0) throw new InvalidOperationException("Cloudflare Access returned no RSA signing keys.");
        return keys;
    }
}

/// <summary>
/// Caches signing keys for an hour. A token signed with an unknown key id triggers a refetch, at most once every
/// five minutes, so a flood of forged key ids cannot turn into a flood of requests to Cloudflare.
/// </summary>
public sealed class AccessKeyCache(IAccessKeySource source, TimeProvider time, ILogger<AccessKeyCache> logger)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(1);
    public static readonly TimeSpan UnknownKeyRefetchInterval = TimeSpan.FromMinutes(5);
    /// <summary>Back-off after a failed fetch when there are no keys at all to fall back on.</summary>
    public static readonly TimeSpan FailedFetchBackoff = TimeSpan.FromSeconds(30);
    /// <summary>Last-good keys cover a Cloudflare outage for at most this long; older keys are not trusted.</summary>
    public static readonly TimeSpan MaxStaleAge = TimeSpan.FromHours(24);

    private readonly SemaphoreSlim _gate = new(1, 1);
    private Entry? _entry;
    private (string Team, DateTimeOffset At, bool Failed)? _lastAttempt;

    private sealed record Entry(string Team, IReadOnlyList<SecurityKey> Keys, DateTimeOffset FetchedAt);

    public async Task<IReadOnlyList<SecurityKey>> GetAsync(string teamDomain, string? keyId, CancellationToken ct)
    {
        var entry = Volatile.Read(ref _entry);
        if (IsUsable(entry, teamDomain, keyId, time.GetUtcNow())) return entry!.Keys;

        await _gate.WaitAsync(ct);
        try
        {
            entry = _entry;
            var now = time.GetUtcNow();
            if (IsUsable(entry, teamDomain, keyId, now)) return entry!.Keys;
            var cached = entry is not null && entry.Team == teamDomain && now - entry.FetchedAt < MaxStaleAge ? entry.Keys : null;
            var attempt = _lastAttempt is { } last && last.Team == teamDomain ? _lastAttempt : null;
            if (attempt is { } previous)
            {
                // Unknown kid (or stale keys after a failure): refetch at most once per interval.
                var wait = cached is null && previous.Failed ? FailedFetchBackoff : UnknownKeyRefetchInterval;
                if (now - previous.At < wait)
                {
                    if (cached is not null) return cached;
                    throw new InvalidOperationException("Cloudflare Access signing keys could not be fetched recently; retrying shortly.");
                }
            }
            try
            {
                var keys = await source.FetchSigningKeysAsync(teamDomain, ct);
                _entry = new Entry(teamDomain, keys, now);
                _lastAttempt = (teamDomain, now, false);
                return keys;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                _lastAttempt = (teamDomain, now, true);
                logger.LogWarning(ex, "Could not fetch Cloudflare Access signing keys for team {Team}.", teamDomain);
                if (cached is not null) return cached;
                throw;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    private static bool IsUsable(Entry? entry, string team, string? keyId, DateTimeOffset now) =>
        entry is not null && entry.Team == team && now - entry.FetchedAt < Lifetime
        && (keyId is null || entry.Keys.Any(k => string.Equals(k.KeyId, keyId, StringComparison.Ordinal)));
}

/// <summary><see cref="Misconfigured"/> marks failures that signing in again cannot fix (settings or a key outage).</summary>
public sealed record AccessTokenResult(bool Success, string? Email, string? Failure, bool Misconfigured = false)
{
    public static AccessTokenResult Fail(string reason) => new(false, null, reason);

    public static AccessTokenResult ConfigFail(string reason) => new(false, null, reason, Misconfigured: true);
}

/// <summary>Validates the <c>Cf-Access-Jwt-Assertion</c> token that Cloudflare Access adds to proxied requests.</summary>
public sealed class AccessTokenValidator(AccessKeyCache keys)
{
    public static readonly TimeSpan ClockSkew = TimeSpan.FromSeconds(60);
    private const int MaxTokenLength = 16 * 1024;

    private readonly JsonWebTokenHandler _handler = new() { MapInboundClaims = false, MaximumTokenSizeInBytes = MaxTokenLength };

    public async Task<AccessTokenResult> ValidateAsync(string? token, RemoteAccessOptions options, CancellationToken ct)
    {
        if (!options.IsConfigured || options.Issuer is null || options.Audience is null)
            return AccessTokenResult.ConfigFail("remote access is not configured (team domain, audience and owner emails are required)");
        if (string.IsNullOrWhiteSpace(token)) return AccessTokenResult.Fail("no Cf-Access-Jwt-Assertion header");
        if (token.Length > MaxTokenLength || !_handler.CanReadToken(token)) return AccessTokenResult.Fail("malformed token");

        JsonWebToken parsed;
        try { parsed = _handler.ReadJsonWebToken(token); }
        catch (Exception ex) when (ex is ArgumentException or SecurityTokenException) { return AccessTokenResult.Fail("malformed token"); }
        // Decided before any key lookup: alg "none", HS256 (key confusion) and everything else is refused.
        if (!string.Equals(parsed.Alg, SecurityAlgorithms.RsaSha256, StringComparison.Ordinal))
            return AccessTokenResult.Fail($"unsupported alg '{parsed.Alg}'");

        IReadOnlyList<SecurityKey> signingKeys;
        try { signingKeys = await keys.GetAsync(options.TeamDomain!, string.IsNullOrEmpty(parsed.Kid) ? null : parsed.Kid, ct); }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return AccessTokenResult.ConfigFail($"signing keys unavailable: {ex.Message}");
        }

        var parameters = new TokenValidationParameters
        {
            ValidIssuer = options.Issuer,
            ValidateIssuer = true,
            ValidAudience = options.Audience,
            ValidateAudience = true,
            IssuerSigningKeys = signingKeys,
            ValidateIssuerSigningKey = false,
            ValidAlgorithms = [SecurityAlgorithms.RsaSha256],
            RequireSignedTokens = true,
            RequireExpirationTime = true,
            ValidateLifetime = true,
            ClockSkew = ClockSkew,
            TryAllIssuerSigningKeys = string.IsNullOrEmpty(parsed.Kid),
        };
        var result = await _handler.ValidateTokenAsync(token, parameters);
        if (!result.IsValid)
            return AccessTokenResult.Fail(result.Exception?.GetType().Name + ": " + result.Exception?.Message);

        // Service tokens carry no email; they are machines, never the owner.
        var email = parsed.TryGetPayloadValue<string>("email", out var raw) ? raw?.Trim().ToLowerInvariant() : null;
        if (string.IsNullOrEmpty(email)) return AccessTokenResult.Fail("token has no email claim (service tokens are not accepted)");
        return new AccessTokenResult(true, email, null);
    }
}
