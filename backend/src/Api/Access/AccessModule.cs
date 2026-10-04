using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Api.Access;

public static class AccessModule
{
    public static IServiceCollection AddAccess(this IServiceCollection services)
    {
        services.AddSingleton<AccessState>();
        services.AddSingleton<AccessTokens>();
        services.AddHttpClient("access", client => client.Timeout = TimeSpan.FromSeconds(10));
        return services;
    }

    public static async Task UseAccessAsync(this WebApplication app)
    {
        await app.Services.GetRequiredService<AccessState>().InitializeAsync(app);
        app.UseMiddleware<AccessMiddleware>();
        app.UseMiddleware<RequesterCatalogGuard>();
        app.MapGet("/api/me", async (HttpContext http, TorrentFlowDbContext db, CancellationToken ct) =>
        {
            var requester = AccessIdentity.Role(http) == "requester";
            var userId = AccessIdentity.UserId(http);
            int? pending = null;
            int? unread = null;
            try
            {
                unread = await db.Notifications.CountAsync(n => n.UserId == userId && n.ReadAt == null, ct);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                app.Logger.LogWarning(ex, "Could not count session notifications.");
            }
            if (!requester)
            {
                try { pending = await db.Requests.CountAsync(r => r.Decision == RequestDecision.Pending, ct); }
                catch (Exception ex) when (!ct.IsCancellationRequested)
                { app.Logger.LogWarning(ex, "Could not count pending requests."); }
            }
            return Reply(new { role = AccessIdentity.Role(http), via = AccessIdentity.Via(http),
                email = http.User.FindFirst("email")?.Value, pendingRequests = pending, unreadNotifications = unread });
        });
        app.MapGet("/api/features", (HttpContext http, IConfiguration configuration) => Reply(new
        {
            runningInContainer = AccessIdentity.InContainer,
            openFolder = !AccessIdentity.InContainer && AccessIdentity.Via(http) == "local" && AccessIdentity.Role(http) == "owner",
            displayPathMappings = configuration.GetSection("TorrentFlow:DisplayPathMappings").GetChildren()
                .Select(x => new { containerPath = x["ContainerPath"], hostPath = x["HostPath"] })
                .Where(x => !string.IsNullOrWhiteSpace(x.containerPath) && !string.IsNullOrWhiteSpace(x.hostPath)).ToArray(),
        }));
        app.MapGet("/api/settings/remote-access", (HttpContext http, AccessState state) => Reply(Describe(state, http)));
        app.MapPut("/api/settings/remote-access", SaveAsync);
        app.MapGet("/api/settings/remote-access/check", CheckAsync);
        // The unchanged SPA signs out at Cloudflare, not at an application session endpoint.
        app.MapGet("/cdn-cgi/access/logout", (HttpContext http, AccessState state) =>
        {
            if (AccessIdentity.Via(http) != "tunnel" || state.Current.TeamDomain is null)
                return Results.Redirect("/");
            http.Response.Cookies.Delete("CF_Authorization");
            return Results.Redirect($"https://{state.Current.TeamDomain}.cloudflareaccess.com/cdn-cgi/access/logout");
        });
    }

    private static IResult Reply(object body, int status = 200) => Results.Json(body, AccessState.Json, statusCode: status);
    private static IResult Error(int status, string message) => Reply(new { error = message }, status);

    private static object Describe(AccessState state, HttpContext http)
    {
        var current = state.Current;
        var startup = state.Startup;
        return new
        {
            current.Enabled, current.TunnelPort, current.TunnelBindAddress, current.TeamDomain, current.Audience,
            current.OwnerEmails, current.AllowRequesters, state.RestartRequired,
            running = new { startup.Enabled, startup.TunnelPort, startup.TunnelBindAddress,
                listening = state.Listening, tunnelUrl = AccessState.Url(startup) },
            ownerPorts = state.OwnerPorts, editable = AccessIdentity.Via(http) == "local",
            via = AccessIdentity.Via(http), warnings = Array.Empty<string>(),
        };
    }

    private static async Task<IResult> SaveAsync(HttpContext http, AccessState state, CancellationToken ct)
    {
        if (AccessIdentity.Via(http) == "tunnel")
            return Error(403, "Remote access settings can only be changed on the computer running TorrentFlow.");
        if (http.Request.ContentType?.Contains("json", StringComparison.OrdinalIgnoreCase) != true)
            return Error(415, "Content-Type must be application/json");
        const int max = 16384;
        if (http.Request.ContentLength > max) return Error(413, $"JSON body exceeds the {max}-byte limit");
        var buffer = new byte[max + 1];
        var length = 0;
        try
        {
            int read;
            while (length < buffer.Length && (read = await http.Request.Body.ReadAsync(buffer.AsMemory(length), ct)) > 0)
                length += read;
            if (length > max) return Error(413, $"JSON body exceeds the {max}-byte limit");
            if (length == 0) return Error(400, "JSON body is required");
            using var doc = JsonDocument.Parse(buffer.AsMemory(0, length));
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return Error(400, "JSON body must be an object");
            var next = state.Current;
            foreach (var p in doc.RootElement.EnumerateObject())
            {
                var v = p.Value;
                switch (p.Name)
                {
                    case "enabled":
                    case "allowRequesters":
                        if (v.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return Error(400, $"{p.Name} must be a boolean");
                        next = p.Name == "enabled" ? next with { Enabled = v.GetBoolean() } : next with { AllowRequesters = v.GetBoolean() };
                        break;
                    case "tunnelPort":
                        if (!v.TryGetInt32(out var port)) return Error(400, "tunnelPort must be an integer");
                        next = next with { TunnelPort = port };
                        break;
                    case "tunnelBindAddress":
                        if (v.ValueKind != JsonValueKind.String) return Error(400, "tunnelBindAddress must be an IP address such as 127.0.0.1");
                        next = next with { TunnelBindAddress = v.GetString()!.Trim() };
                        break;
                    case "teamDomain":
                    case "audience":
                        if (v.ValueKind is not (JsonValueKind.Null or JsonValueKind.String)) return Error(400, $"{p.Name} must be a string");
                        next = p.Name == "teamDomain" ? next with { TeamDomain = v.GetString() } : next with { Audience = v.GetString() };
                        break;
                    case "ownerEmails":
                        if (v.ValueKind != JsonValueKind.Array || v.EnumerateArray().Any(x => x.ValueKind != JsonValueKind.String))
                            return Error(400, "ownerEmails must be an array of email addresses");
                        next = next with { OwnerEmails = [.. v.EnumerateArray().Select(x => x.GetString()!).Where(x => !string.IsNullOrWhiteSpace(x))] };
                        break;
                    default: return Error(400, $"Unknown field `{p.Name}`");
                }
            }
            var problem = AccessState.Validate(ref next);
            if (problem is not null) return Error(400, problem);
            if (state.OwnerPorts.Contains(next.TunnelPort))
                return Error(400, $"tunnelPort {next.TunnelPort} is the port TorrentFlow already uses on this computer; pick another one");
            if (next.Enabled && (next.TeamDomain is null || next.Audience is null || next.OwnerEmails.IsEmpty))
                return Error(400, "To turn on remote access, fill in the team domain, the AUD tag and at least one owner email");
            if (!await state.SaveAsync(next, ct))
                return Error(409, "The settings changed while saving. Reload Settings and try again.");
            return Reply(Describe(state, http));
        }
        catch (JsonException) { return Error(400, "Request body is not valid JSON"); }
        catch (InvalidOperationException) { return Error(400, "Request body contains an invalid field type"); }
        catch (Exception ex) when (ex is IOException or BadHttpRequestException && !ct.IsCancellationRequested)
        { return Error(400, "The request body could not be read"); }
    }

    private static async Task<IResult> CheckAsync(HttpContext http, AccessState state, AccessTokens tokens, CancellationToken ct)
    {
        var options = state.Current;
        List<string> problems = [];
        if (!options.Enabled) problems.Add("Remote access is turned off.");
        else if (state.RestartRequired) problems.Add("Restart TorrentFlow to apply the listener settings.");
        else if (!state.Listening) problems.Add($"TorrentFlow is not listening on the tunnel port ({AccessState.Url(state.Startup)}). A Kestrel:Endpoints setting may be overriding it; check the log.");
        if (options.TeamDomain is null) problems.Add("Add your Cloudflare team domain.");
        if (options.Audience is null) problems.Add("Add the Access application's AUD tag.");
        if (options.OwnerEmails.IsEmpty) problems.Add("Add at least one owner email.");
        int? keyCount = null;
        string? keysError = null;
        if (options.TeamDomain is not null)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            try { keyCount = (await tokens.FetchKeysAsync(options.TeamDomain, null, timeout.Token)).GetArrayLength(); }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                keysError = ex is OperationCanceledException ? "Timed out reaching Cloudflare." : ex.Message;
                problems.Add($"Could not fetch the team's signing keys from https://{options.TeamDomain}.cloudflareaccess.com/cdn-cgi/access/certs.");
            }
        }
        return Reply(new { ok = problems.Count == 0, listening = state.Listening,
            tunnelUrl = state.Listening ? AccessState.Url(state.Startup) : null,
            issuer = options.TeamDomain is null ? null : $"https://{options.TeamDomain}.cloudflareaccess.com",
            keyCount, keysError, problems });
    }
}
