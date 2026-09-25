using System.Security.Claims;

namespace TorrentFlow.Api.RemoteAccess;

public static class RemoteAccessClaims
{
    public const string Email = "email";
    public const string Role = "tf:role";
    public const string Via = "tf:via";
    public const string OwnerRole = "owner";
    public const string ViaLocal = "local";
    public const string ViaTunnel = "tunnel";
    public const string TokenHeader = "Cf-Access-Jwt-Assertion";

    public static string ViaOf(ClaimsPrincipal user) => user.FindFirst(Via)?.Value ?? ViaLocal;

    public static bool IsTunnel(HttpContext context) => ViaOf(context.User) == ViaTunnel;
}

/// <summary>
/// Decides trust by the connection's local port, never by Host or X-Forwarded-*: requests on the tunnel port need a
/// valid Cloudflare Access token from an owner email; everything else is the trusted local listener. Runs before
/// static files, the SPA fallback and every endpoint.
/// </summary>
public sealed class RemoteAccessMiddleware(RequestDelegate next, RemoteAccessStore store, AccessTokenValidator validator, ILogger<RemoteAccessMiddleware> logger)
{
    private static readonly string[] StreamingRoutes = ["/api/stream", "/api/playback", "/api/prewarm", "/api/subtitles"];
    public const string AuthHeader = "X-TorrentFlow-Auth";

    public async Task InvokeAsync(HttpContext context)
    {
        if (store.ActiveTunnelPort is { } tunnelPort && context.Connection.LocalPort == tunnelPort)
            await HandleTunnelAsync(context);
        else
            await HandleLocalAsync(context);
    }

    private async Task HandleLocalAsync(HttpContext context)
    {
        if (CameThroughCloudflare(context.Request.Headers))
        {
            logger.LogWarning("Refused a Cloudflare-proxied request on the local listener (port {Port}); the tunnel must point at the tunnel port.", context.Connection.LocalPort);
            var tunnelUrl = (store.Startup.Enabled ? store.Startup : store.Current).TunnelUrl;
            await WriteJson(context, StatusCodes.Status421MisdirectedRequest, new
            {
                error = $"This request came through Cloudflare but reached TorrentFlow's local listener. Point the tunnel at the tunnel port ({tunnelUrl}) and turn on Remote access in Settings.",
                code = "misrouted_tunnel",
            });
            return;
        }
        context.User = Principal(RemoteAccessClaims.ViaLocal, email: null, "Local");
        await next(context);
    }

    private async Task HandleTunnelAsync(HttpContext context)
    {
        var options = store.Current;
        if (!options.Enabled)
        {
            // Saved as off: refuse now rather than waiting for the restart that closes the listener.
            logger.LogInformation("Refused a tunnel request to {Path}: remote access is turned off.", context.Request.Path);
            context.Response.Headers[AuthHeader] = "misconfigured";
            await WriteJson(context, StatusCodes.Status401Unauthorized, new
            {
                error = "Remote access is turned off on the computer running TorrentFlow.",
                code = "remote_access_off",
            });
            return;
        }
        var result = await validator.ValidateAsync(context.Request.Headers[RemoteAccessClaims.TokenHeader].ToString(), options, context.RequestAborted);
        if (!result.Success)
        {
            logger.LogWarning("Refused a tunnel request to {Path}: {Reason}", context.Request.Path, result.Failure);
            if (result.Misconfigured)
            {
                // Reloading cannot fix this, so the SPA must not treat it as an expired session.
                context.Response.Headers[AuthHeader] = "misconfigured";
                await WriteJson(context, StatusCodes.Status401Unauthorized, new
                {
                    error = "Remote access isn't set up correctly on the computer running TorrentFlow. Open Settings there and run Check setup.",
                    code = "remote_access_misconfigured",
                });
                return;
            }
            context.Response.Headers[AuthHeader] = "required";
            await WriteJson(context, StatusCodes.Status401Unauthorized, new
            {
                error = "Sign in through Cloudflare Access to use TorrentFlow remotely. Reload the page to sign in again.",
                code = "remote_sign_in_required",
            });
            return;
        }
        if (!options.IsOwner(result.Email!))
        {
            logger.LogInformation("Refused a signed-in non-owner ({Email}) on the tunnel.", MaskEmail(result.Email!));
            await WriteJson(context, StatusCodes.Status403Forbidden, new
            {
                error = "Your account is signed in, but access for people other than the owner is not enabled yet.",
                code = "remote_access_not_enabled",
            });
            return;
        }

        context.User = Principal(RemoteAccessClaims.ViaTunnel, result.Email, "CloudflareAccess");

        // Cloudflare's terms and its 100 s proxy timeout rule out video over the tunnel.
        var path = context.Request.Path;
        if (StreamingRoutes.Any(r => path.StartsWithSegments(r, StringComparison.OrdinalIgnoreCase)))
        {
            await WriteJson(context, StatusCodes.Status404NotFound, new { error = "Streaming isn't available through remote access.", streamingDisabled = true });
            return;
        }
        await next(context);
    }

    /// <summary>j***@example.com: enough to recognise a typo in the owner list without logging the full address.</summary>
    internal static string MaskEmail(string email)
    {
        var at = email.IndexOf('@');
        return at <= 0 ? "***" : email[0] + "***" + email[at..];
    }

    internal static bool CameThroughCloudflare(IHeaderDictionary headers) =>
        headers.ContainsKey("Cf-Ray")
        || headers.ContainsKey("Cf-Connecting-Ip")
        || headers.ContainsKey(RemoteAccessClaims.TokenHeader)
        || headers["Cdn-Loop"].Any(v => v?.Contains("cloudflare", StringComparison.OrdinalIgnoreCase) == true);

    private static ClaimsPrincipal Principal(string via, string? email, string authenticationType)
    {
        var claims = new List<Claim>
        {
            new(RemoteAccessClaims.Role, RemoteAccessClaims.OwnerRole),
            new(RemoteAccessClaims.Via, via),
        };
        if (email is not null) claims.Add(new Claim(RemoteAccessClaims.Email, email));
        return new ClaimsPrincipal(new ClaimsIdentity(claims, authenticationType, RemoteAccessClaims.Email, RemoteAccessClaims.Role));
    }

    private static Task WriteJson(HttpContext context, int status, object body)
    {
        context.Response.StatusCode = status;
        context.Response.Headers.CacheControl = "no-store";
        return context.Response.WriteAsJsonAsync(body);
    }
}

/// <summary>
/// Refuses browser-originated writes from other sites on both listeners. Origin is compared to Host only: behind
/// the tunnel the browser uses https while the request reaches Kestrel as http.
/// </summary>
public sealed class UnsafeMethodGuardMiddleware(RequestDelegate next)
{
    public Task InvokeAsync(HttpContext context)
    {
        var request = context.Request;
        if (HttpMethods.IsGet(request.Method) || HttpMethods.IsHead(request.Method) || HttpMethods.IsOptions(request.Method) || HttpMethods.IsTrace(request.Method))
            return next(context);

        var site = request.Headers["Sec-Fetch-Site"].ToString().Trim().ToLowerInvariant();
        // Without Sec-Fetch-Site (older browsers, non-browser clients) an Origin, when sent, must still be this host.
        if (site == "" && (!request.Headers.ContainsKey("Origin") || OriginMatchesHost(request))) return next(context);
        if (site is "none" or "same-origin") return next(context);
        if (site == "same-site" && OriginMatchesHost(request)) return next(context);

        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        context.Response.Headers.CacheControl = "no-store";
        return context.Response.WriteAsJsonAsync(new
        {
            error = site == "cross-site" ? "Cross-site browser requests are not allowed"
                : site is "same-site" or "" ? "Browser request origin does not match this application"
                : "Unrecognised browser request origin",
        });
    }

    private static bool OriginMatchesHost(HttpRequest request)
    {
        var origin = request.Headers.Origin.ToString();
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) || !request.Host.HasValue) return false;
        return string.Equals(uri.Authority, request.Host.Value, StringComparison.OrdinalIgnoreCase);
    }
}
