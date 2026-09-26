using TorrentFlow.Api.Requests;
using System.Text.Json;

namespace TorrentFlow.Api.RemoteAccess;

public static class RemoteAccessEndpoints
{
    private const int MaxBodyBytes = 16 * 1024;

    public static IEndpointRouteBuilder MapRemoteAccessEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/me", async (HttpContext http, MediaRequestService requests, ILoggerFactory loggers) =>
        {
            http.Response.Headers.CacheControl = "no-store";
            var user = http.User;
            var role = RemoteAccessClaims.RoleOf(user);
            int? pendingRequests = null;
            if (role == RemoteAccessClaims.OwnerRole)
            {
                // The SPA picks its shell from this answer; a failed count must not fail the whole session check.
                try { pendingRequests = await requests.PendingCountAsync(http.RequestAborted); }
                catch (Exception ex) when (!http.RequestAborted.IsCancellationRequested)
                {
                    loggers.CreateLogger("TorrentFlow.Api.RemoteAccess").LogWarning(ex, "Could not count pending requests for /api/me");
                }
            }
            return Results.Json(new
            {
                role,
                via = RemoteAccessClaims.ViaOf(user),
                email = user.FindFirst(RemoteAccessClaims.Email)?.Value,
                pendingRequests,
            });
        }).AllowRequesters();

        app.MapGet("/api/settings/remote-access", (HttpContext http, RemoteAccessStore store) =>
        {
            http.Response.Headers.CacheControl = "no-store";
            return Results.Json(Describe(store, http));
        });

        app.MapPut("/api/settings/remote-access", async (HttpContext http, RemoteAccessStore store, ILoggerFactory loggers) =>
        {
            http.Response.Headers.CacheControl = "no-store";
            if (RemoteAccessClaims.IsTunnel(http))
                return Error(403, "Remote access settings can only be changed on the computer running TorrentFlow.");
            if (http.Request.ContentType?.Contains("json", StringComparison.OrdinalIgnoreCase) != true)
                return Error(415, "Content-Type must be application/json");
            if (http.Request.ContentLength > MaxBodyBytes) return Error(413, $"JSON body exceeds the {MaxBodyBytes}-byte limit");

            JsonElement body;
            try
            {
                // Bounded read: stop one byte past the limit instead of buffering whatever a client sends.
                var buffer = new byte[MaxBodyBytes + 1];
                var length = 0;
                int read;
                while (length < buffer.Length && (read = await http.Request.Body.ReadAsync(buffer.AsMemory(length), http.RequestAborted)) > 0)
                    length += read;
                if (length > MaxBodyBytes) return Error(413, $"JSON body exceeds the {MaxBodyBytes}-byte limit");
                if (length == 0) return Error(400, "JSON body is required");
                using var doc = JsonDocument.Parse(buffer.AsMemory(0, length));
                body = doc.RootElement.Clone();
            }
            catch (JsonException) { return Error(400, "Request body is not valid JSON"); }
            catch (Exception ex) when (ex is IOException or BadHttpRequestException && !http.RequestAborted.IsCancellationRequested)
            {
                return Error(400, "The request body could not be read");
            }
            if (body.ValueKind != JsonValueKind.Object) return Error(400, "JSON body must be an object");

            var (next, problem) = Parse(body, store);
            if (problem is not null) return Error(400, problem);
            var logger = loggers.CreateLogger("TorrentFlow.RemoteAccess");
            try
            {
                await store.SaveAsync(next!, http.RequestAborted);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                logger.LogError(ex, "Could not save {Path}.", store.FilePath);
                return Error(500, $"The settings could not be saved to {store.FilePath}: {ex.Message}");
            }
            logger.LogInformation(
                "Remote access settings saved (enabled {Enabled}, port {Port}, {Owners} owner email(s)).", next!.Enabled, next.TunnelPort, next.OwnerEmails.Count);
            return Results.Json(Describe(store, http));
        });

        app.MapGet("/api/settings/remote-access/check", async (HttpContext http, RemoteAccessStore store, IAccessKeySource keys) =>
        {
            http.Response.Headers.CacheControl = "no-store";
            var options = store.Current;
            var problems = new List<string>();
            if (!options.Enabled) problems.Add("Remote access is turned off.");
            else if (store.RestartRequired) problems.Add("Restart TorrentFlow to apply the listener settings.");
            else if (!store.TunnelListening)
                problems.Add($"TorrentFlow is not listening on the tunnel port ({store.Startup.TunnelUrl}). A Kestrel:Endpoints setting may be overriding it; check the log.");
            if (options.TeamDomain is null) problems.Add("Add your Cloudflare team domain.");
            if (options.Audience is null) problems.Add("Add the Access application's AUD tag.");
            if (options.OwnerEmails.Count == 0) problems.Add("Add at least one owner email.");

            int? keyCount = null;
            string? keysError = null;
            if (options.TeamDomain is not null)
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(http.RequestAborted);
                timeout.CancelAfter(TimeSpan.FromSeconds(10));
                try { keyCount = (await keys.FetchSigningKeysAsync(options.TeamDomain, timeout.Token)).Count; }
                catch (Exception ex) when (!http.RequestAborted.IsCancellationRequested)
                {
                    keysError = ex is OperationCanceledException ? "Timed out reaching Cloudflare." : ex.Message;
                    problems.Add($"Could not fetch the team's signing keys from {HttpAccessKeySource.CertsUrl(options.TeamDomain)}.");
                }
            }
            return Results.Json(new
            {
                ok = problems.Count == 0,
                listening = store.TunnelListening,
                tunnelUrl = store.TunnelListening ? store.Startup.TunnelUrl : null,
                issuer = options.Issuer,
                keyCount,
                keysError,
                problems,
            });
        });

        return app;
    }

    private static object Describe(RemoteAccessStore store, HttpContext http)
    {
        var current = store.Current;
        var via = RemoteAccessClaims.ViaOf(http.User);
        return new
        {
            enabled = current.Enabled,
            tunnelPort = current.TunnelPort,
            tunnelBindAddress = current.TunnelBindAddress,
            teamDomain = current.TeamDomain,
            audience = current.Audience,
            ownerEmails = current.OwnerEmails,
            allowRequesters = current.AllowRequesters,
            restartRequired = store.RestartRequired,
            running = new
            {
                enabled = store.Startup.Enabled,
                tunnelPort = store.Startup.TunnelPort,
                tunnelBindAddress = store.Startup.TunnelBindAddress,
                listening = store.TunnelListening,
                tunnelUrl = store.Startup.TunnelUrl,
            },
            ownerPorts = store.OwnerPorts,
            editable = via == RemoteAccessClaims.ViaLocal,
            via,
            warnings = store.LoadWarnings,
        };
    }

    private static (RemoteAccessOptions? Options, string? Problem) Parse(JsonElement body, RemoteAccessStore store)
    {
        var current = store.Current;
        var next = current;
        foreach (var property in body.EnumerateObject())
        {
            var value = property.Value;
            switch (property.Name)
            {
                case "enabled":
                    if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return (null, "enabled must be a boolean");
                    next = next with { Enabled = value.GetBoolean() };
                    break;
                case "allowRequesters":
                    if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return (null, "allowRequesters must be a boolean");
                    next = next with { AllowRequesters = value.GetBoolean() };
                    break;
                case "tunnelPort":
                    if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var port)) return (null, "tunnelPort must be an integer");
                    if (port is < RemoteAccessRules.MinPort or > RemoteAccessRules.MaxPort)
                        return (null, $"tunnelPort must be between {RemoteAccessRules.MinPort} and {RemoteAccessRules.MaxPort}");
                    next = next with { TunnelPort = port };
                    break;
                case "tunnelBindAddress":
                    if (value.ValueKind != JsonValueKind.String || !RemoteAccessRules.IsValidBindAddress(value.GetString()!.Trim()))
                        return (null, "tunnelBindAddress must be an IP address such as 127.0.0.1");
                    next = next with { TunnelBindAddress = value.GetString()!.Trim() };
                    break;
                case "teamDomain":
                    if (value.ValueKind == JsonValueKind.Null || (value.ValueKind == JsonValueKind.String && string.IsNullOrWhiteSpace(value.GetString())))
                    {
                        next = next with { TeamDomain = null };
                        break;
                    }
                    var team = value.ValueKind == JsonValueKind.String ? RemoteAccessRules.NormalizeTeamDomain(value.GetString()) : null;
                    if (team is null) return (null, "teamDomain must be your Cloudflare team name, such as myteam or myteam.cloudflareaccess.com");
                    next = next with { TeamDomain = team };
                    break;
                case "audience":
                    if (value.ValueKind == JsonValueKind.Null || (value.ValueKind == JsonValueKind.String && string.IsNullOrWhiteSpace(value.GetString())))
                    {
                        next = next with { Audience = null };
                        break;
                    }
                    var audience = value.ValueKind == JsonValueKind.String ? value.GetString()!.Trim() : null;
                    if (audience is null || !RemoteAccessRules.IsValidAudience(audience))
                        return (null, "audience must be the Access application's AUD tag (letters and digits)");
                    next = next with { Audience = audience };
                    break;
                case "ownerEmails":
                    if (value.ValueKind != JsonValueKind.Array) return (null, "ownerEmails must be an array of email addresses");
                    var emails = new List<string>();
                    foreach (var item in value.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.String) return (null, "ownerEmails must contain only email address strings");
                        var raw = item.GetString();
                        if (string.IsNullOrWhiteSpace(raw)) continue;
                        var email = RemoteAccessRules.NormalizeEmail(raw);
                        if (email is null) return (null, $"'{Truncate(raw)}' is not a valid email address");
                        if (!emails.Contains(email)) emails.Add(email);
                    }
                    if (emails.Count > RemoteAccessRules.MaxOwnerEmails) return (null, $"At most {RemoteAccessRules.MaxOwnerEmails} owner emails are allowed");
                    next = next with { OwnerEmails = emails };
                    break;
                default:
                    return (null, $"Unknown field `{property.Name}`");
            }
        }
        if (store.OwnerPorts.Contains(next.TunnelPort))
            return (null, $"tunnelPort {next.TunnelPort} is the port TorrentFlow already uses on this computer; pick another one");
        if (next.Enabled && !next.IsConfigured)
            return (null, "To turn on remote access, fill in the team domain, the AUD tag and at least one owner email");
        return (next, null);
    }

    private static string Truncate(string value) => value.Length <= 80 ? value : value[..80] + "…";

    private static IResult Error(int status, string message) => Results.Json(new { error = message }, statusCode: status);
}
