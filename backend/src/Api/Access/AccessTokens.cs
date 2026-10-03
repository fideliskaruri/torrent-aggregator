using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TorrentFlow.Domain;

namespace TorrentFlow.Api.Access;

public sealed class AccessTokens(IHttpClientFactory clients, IConfiguration configuration, IHostEnvironment environment)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private KeySet? cached;
    private DateTimeOffset lastAttempt;
    private string? lastTeam;
    private bool failed;
    private sealed record KeySet(string Team, JsonElement Keys, DateTimeOffset At);
    public sealed record Result(string? Email, bool Misconfigured);

    public async Task<Result> ValidateAsync(string token, RemoteAccessSettings options, CancellationToken ct)
    {
        if (options.TeamDomain is null || options.Audience is null || options.OwnerEmails.IsEmpty) return new(null, true);
        if (string.IsNullOrWhiteSpace(token) || token.Length > 16384) return new(null, false);
        try
        {
            var parts = token.Split('.');
            if (parts.Length != 3) return new(null, false);
            using var header = JsonDocument.Parse(Decode(parts[0]));
            using var payload = JsonDocument.Parse(Decode(parts[1]));
            if (header.RootElement.GetProperty("alg").GetString() != "RS256") return new(null, false);
            var kid = header.RootElement.TryGetProperty("kid", out var keyId) ? keyId.GetString() : null;
            JsonElement keys;
            try { keys = await FetchKeysAsync(options.TeamDomain, kid, ct); }
            catch (Exception ex) when (ex is HttpRequestException or IOException or JsonException or InvalidOperationException
                || ex is OperationCanceledException && !ct.IsCancellationRequested) { return new(null, true); }
            var signature = Decode(parts[2]);
            var signed = Encoding.ASCII.GetBytes(parts[0] + "." + parts[1]);
            var valid = false;
            foreach (var key in keys.EnumerateArray())
            {
                if (key.GetProperty("kty").GetString() != "RSA") continue;
                if (kid is not null && (!key.TryGetProperty("kid", out var id) || id.GetString() != kid)) continue;
                if (key.TryGetProperty("use", out var use) && use.GetString() != "sig") continue;
                if (key.TryGetProperty("alg", out var alg) && alg.GetString() != "RS256") continue;
                using var rsa = RSA.Create();
                rsa.ImportParameters(new RSAParameters { Modulus = Decode(key.GetProperty("n").GetString()!),
                    Exponent = Decode(key.GetProperty("e").GetString()!) });
                if (rsa.KeySize >= 2048 && rsa.VerifyData(signed, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))
                { valid = true; break; }
            }
            if (!valid) return new(null, false);
            var claims = payload.RootElement;
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            if (claims.GetProperty("iss").GetString() != $"https://{options.TeamDomain}.cloudflareaccess.com") return new(null, false);
            var aud = claims.GetProperty("aud");
            if (!(aud.ValueKind == JsonValueKind.String && aud.GetString() == options.Audience)
                && !(aud.ValueKind == JsonValueKind.Array && aud.EnumerateArray().Any(x => x.ValueKind == JsonValueKind.String && x.GetString() == options.Audience)))
                return new(null, false);
            if (!claims.GetProperty("exp").TryGetInt64(out var expires) || expires < now - 60) return new(null, false);
            if (claims.TryGetProperty("nbf", out var nbf) && (!nbf.TryGetInt64(out var starts) || starts > now + 60 || starts > expires))
                return new(null, false);
            var email = claims.TryGetProperty("email", out var raw) && raw.ValueKind == JsonValueKind.String
                ? raw.GetString()?.Trim().ToLowerInvariant() : null;
            return new(string.IsNullOrWhiteSpace(email) ? null : email, false);
        }
        catch (Exception ex) when (ex is JsonException or FormatException or KeyNotFoundException or InvalidOperationException
            or ArgumentException or CryptographicException) { return new(null, false); }
    }

    public async Task<JsonElement> FetchKeysAsync(string team, string? kid, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var now = DateTimeOffset.UtcNow;
            var prior = cached is { } entry && entry.Team == team && now - entry.At < TimeSpan.FromHours(24) ? entry : null;
            if (prior is not null && now - prior.At < TimeSpan.FromHours(1)
                && (kid is null || prior.Keys.EnumerateArray().Any(x => x.TryGetProperty("kid", out var k) && k.GetString() == kid)))
                return prior.Keys;
            var backoff = prior is null && failed ? TimeSpan.FromSeconds(30) : TimeSpan.FromMinutes(5);
            if (lastTeam == team && now - lastAttempt < backoff)
                return prior?.Keys ?? throw new InvalidOperationException("Cloudflare Access signing keys could not be fetched recently; retrying shortly.");
            lastTeam = team;
            lastAttempt = now;
            try
            {
                string text;
                var file = configuration["TorrentFlow:RemoteAccess:DevJwksPath"];
                if (environment.IsDevelopment() && !string.IsNullOrWhiteSpace(file))
                    text = await File.ReadAllTextAsync(file, ct);
                else
                {
                    using var client = clients.CreateClient("access");
                    text = await client.GetStringAsync($"https://{team}.cloudflareaccess.com/cdn-cgi/access/certs", ct);
                }
                using var doc = JsonDocument.Parse(text);
                var keys = doc.RootElement.GetProperty("keys").Clone();
                if (keys.ValueKind != JsonValueKind.Array || !keys.EnumerateArray().Any(k =>
                        k.TryGetProperty("kty", out var type) && type.GetString() == "RSA"))
                    throw new InvalidOperationException("Cloudflare Access returned no RSA signing keys.");
                cached = new(team, keys, now);
                failed = false;
                return keys;
            }
            catch (Exception) when (!ct.IsCancellationRequested)
            {
                failed = true;
                if (prior is not null) return prior.Keys;
                throw;
            }
        }
        finally { gate.Release(); }
    }

    private static byte[] Decode(string value) => Convert.FromBase64String(
        value.Replace('-', '+').Replace('_', '/') + new string('=', (4 - value.Length % 4) % 4));
}
