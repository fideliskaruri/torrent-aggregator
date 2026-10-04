using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using TorrentFlow.Domain;

namespace TorrentFlow.Api.Access;

public static class AccessIdentity
{
    public static string Role(HttpContext http) => http.User.FindFirst("tf:role")?.Value ?? "owner";
    public static string Via(HttpContext http) => http.User.FindFirst("tf:via")?.Value ?? "local";
    public static string UserId(HttpContext http) => http.User.FindFirst("tf:uid")?.Value ?? "local";
    public static Actor Actor(HttpContext http) => new(UserId(http),
        Role(http) == "requester" ? UserRole.Requester : UserRole.Owner, Via(http) == "local", InContainer);
    public static bool InContainer => Environment.GetEnvironmentVariable("DOTNET_RUNNING_IN_CONTAINER") == "true";
}

public sealed class AccessMiddleware(RequestDelegate next, AccessState state, AccessTokens tokens)
{
    public async Task InvokeAsync(HttpContext http)
    {
        http.Response.Headers.CacheControl = "no-store";
        var tunnel = state.Startup.Enabled && http.Connection.LocalPort == state.Startup.TunnelPort;
        var headers = http.Request.Headers;
        var cloudflare = headers.ContainsKey("Cf-Ray") || headers.ContainsKey("Cf-Connecting-Ip")
            || headers.ContainsKey("Cf-Access-Jwt-Assertion")
            || headers["Cdn-Loop"].Any(x => x?.Contains("cloudflare", StringComparison.OrdinalIgnoreCase) == true);
        if (!tunnel)
        {
            if (cloudflare)
            {
                await Error(http, 421, "misrouted_tunnel",
                    $"This request came through Cloudflare but reached TorrentFlow's local listener. Point the tunnel at the tunnel port ({AccessState.Url(state.Current)}) and turn on Remote access in Settings.");
                return;
            }
            SetIdentity(http, "owner", "local", null, "local");
        }
        else
        {
            if (!state.Current.Enabled)
            {
                http.Response.Headers["X-TorrentFlow-Auth"] = "misconfigured";
                await Error(http, 401, "remote_access_off", "Remote access is turned off on the computer running TorrentFlow.");
                return;
            }
            var result = await tokens.ValidateAsync(headers["Cf-Access-Jwt-Assertion"].ToString(), state.Current, http.RequestAborted);
            if (result.Email is null)
            {
                http.Response.Headers["X-TorrentFlow-Auth"] = result.Misconfigured ? "misconfigured" : "required";
                await Error(http, 401, result.Misconfigured ? "remote_access_misconfigured" : "remote_sign_in_required",
                    result.Misconfigured
                    ? "Remote access isn't set up correctly on the computer running TorrentFlow. Open Settings there and run Check setup."
                    : "Sign in through Cloudflare Access to use TorrentFlow remotely. Reload the page to sign in again.");
                return;
            }
            var owner = state.Current.OwnerEmails.Contains(result.Email, StringComparer.Ordinal);
            if (!owner && !state.Current.AllowRequesters)
            {
                await Error(http, 403, "remote_access_not_enabled", "Your account is signed in, but access for people other than the owner is not enabled yet.");
                return;
            }
            if (!owner && !RequesterAllowed(http.Request.Method, http.Request.Path))
            {
                await Error(http, 403, "requester_forbidden", "This part of TorrentFlow is only available to its owner.");
                return;
            }
            var store = http.RequestServices.GetRequiredService<IStore>();
            // Hash-derived IDs make concurrent first sign-ins converge without an unbounded email scan.
            var id = owner ? "local" : "remote-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(result.Email))).ToLowerInvariant();
            if (!owner)
            {
                if ((await store.ReadAsync<UserRow>(AccessState.Query(id), http.RequestAborted)).IsEmpty)
                {
                    var existing = (await AccessState.AllAsync<UserRow>(store, http.RequestAborted))
                        .SingleOrDefault(x => x.NormalizedEmail == result.Email);
                    if (existing is not null) id = existing.Id;
                }
                if (id == "local") throw new InvalidOperationException("A requester email resolved to the local owner row.");
                await AccessState.EnsureUserAsync(store, id, result.Email, UserRole.Requester, http.RequestAborted);
            }
            SetIdentity(http, owner ? "owner" : "requester", "tunnel", result.Email, id);
            var segments = (http.Request.Path.Value ?? "").Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (http.Request.Path.Equals("/api/settings/open-folder", StringComparison.OrdinalIgnoreCase))
            {
                await Write(http, 409, new { error = "Folder opening is unavailable through remote access.", openFolderDisabled = true });
                return;
            }
            if (segments.Length >= 3 && segments[0].Equals("api", StringComparison.OrdinalIgnoreCase)
                && segments[1].Equals("downloads", StringComparison.OrdinalIgnoreCase)
                && segments[^1].Equals("open", StringComparison.OrdinalIgnoreCase))
            {
                await Write(http, 409, new { ok = false, reason = "remote", openFolderDisabled = true,
                    error = "Files can't be opened through remote access.",
                    message = "Open the file on the computer running TorrentFlow, or copy its path." });
                return;
            }
        }
        if (!SafeMethod(http.Request.Method) && !SafeOrigin(http.Request))
        {
            await Write(http, 403, new { error = http.Request.Headers["Sec-Fetch-Site"] == "cross-site"
                ? "Cross-site browser requests are not allowed" : "Browser request origin does not match this application" });
            return;
        }
        await next(http);
    }

    private static void SetIdentity(HttpContext http, string role, string via, string? email, string id)
    {
        List<Claim> claims = [new("tf:role", role), new("tf:via", via), new("tf:uid", id)];
        if (email is not null) claims.Add(new("email", email));
        http.User = new(new ClaimsIdentity(claims, via == "local" ? "Local" : "CloudflareAccess", "email", "tf:role"));
    }

    private static bool SafeMethod(string method) => method is "GET" or "HEAD" or "OPTIONS" or "TRACE";
    private static bool SafeOrigin(HttpRequest request)
    {
        var site = request.Headers["Sec-Fetch-Site"].ToString().Trim().ToLowerInvariant();
        if (site is "none" or "same-origin") return true;
        if (site == "" && !request.Headers.ContainsKey("Origin")) return true;
        if (site is not ("" or "same-site")) return false;
        return Uri.TryCreate(request.Headers.Origin.ToString(), UriKind.Absolute, out var origin)
            && string.Equals(origin.Authority, request.Host.Value, StringComparison.OrdinalIgnoreCase);
    }

    internal static bool RequesterAllowed(string method, PathString path)
    {
        var parts = (path.Value ?? "").Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return true;
        if (parts[0].Contains('%') || parts[0].Contains('\\')) return false;
        if (!parts[0].TrimEnd('.', ' ').Equals("api", StringComparison.OrdinalIgnoreCase)) return true;
        if (!parts[0].Equals("api", StringComparison.OrdinalIgnoreCase) || parts.Length < 2) return false;
        var p = string.Join('/', parts).ToLowerInvariant();
        if (p == "api/requester" || p.StartsWith("api/requester/", StringComparison.Ordinal)
            || p == "api/notifications" || p.StartsWith("api/notifications/", StringComparison.Ordinal)) return true;
        if (method == "POST" && p == "api/artwork") return true;
        if (method is not ("GET" or "HEAD")) return false;
        if (p is "api/me" or "api/health" or "api/features" or "api/search/titles" or "api/suggest" or "api/browse" or "api/recommendations") return true;
        return parts[1].Equals("title", StringComparison.OrdinalIgnoreCase)
            && (parts.Length == 3 || parts.Length == 4 && parts[3].Equals("extras", StringComparison.OrdinalIgnoreCase));
    }

    internal static Task Error(HttpContext http, int status, string code, string error) => Write(http, status, new { error, code });
    internal static Task Write(HttpContext http, int status, object body)
    {
        http.Response.StatusCode = status;
        return http.Response.WriteAsJsonAsync(body, AccessState.Json, http.RequestAborted);
    }
}
