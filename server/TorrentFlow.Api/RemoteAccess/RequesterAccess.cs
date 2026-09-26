using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Api.RemoteAccess;

/// <summary>
/// Endpoint metadata: the endpoint may be reached by a requester. Everything without it is owner-only, so a new
/// endpoint is safe by default.
/// </summary>
public sealed class RequesterAccess
{
    public static readonly RequesterAccess Allowed = new();

    private RequesterAccess() { }
}

public static class RequesterAccessExtensions
{
    public static TBuilder AllowRequesters<TBuilder>(this TBuilder builder) where TBuilder : IEndpointConventionBuilder =>
        builder.WithMetadata(RequesterAccess.Allowed);
}

/// <summary>The requester allow-list checked before routing, so no <c>/api</c> path is ever resolved for a requester unless listed.</summary>
public static class RequesterPaths
{
    private static readonly string[] ExactApi = ["me", "health", "features"];
    public const string RequesterPrefix = "requester";

    /// <summary>
    /// Anything outside <c>/api</c> is a static asset or the SPA fallback (both public shell files); inside it,
    /// only <c>/api/me</c>, <c>/api/health</c>, <c>/api/features</c> and <c>/api/requester/**</c>. Empty segments
    /// are ignored so <c>//api/x</c> cannot slip past, and casing never matters.
    /// </summary>
    public static bool IsAllowed(PathString path)
    {
        var segments = (path.Value ?? "").Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0) return true;
        if (!IsApiSegment(segments[0])) return true;
        if (segments.Length < 2) return false;
        if (string.Equals(segments[1], RequesterPrefix, StringComparison.OrdinalIgnoreCase)) return true;
        return segments.Length == 2 && ExactApi.Any(e => string.Equals(segments[1], e, StringComparison.OrdinalIgnoreCase));
    }

    // "api" with trailing dots/spaces is treated as api too; Windows-style trimming must not create a bypass.
    private static bool IsApiSegment(string segment) =>
        string.Equals(segment.TrimEnd('.', ' '), "api", StringComparison.OrdinalIgnoreCase)
        || segment.Contains('%') || segment.Contains('\\');
}

/// <summary>
/// Runs after routing: a requester may only reach an endpoint carrying <see cref="RequesterAccess"/>. This is the
/// authoritative check; <see cref="RequesterPaths"/> is the cheaper one before static files.
/// </summary>
public sealed class RequesterAuthorizationMiddleware(RequestDelegate next, ILogger<RequesterAuthorizationMiddleware> logger)
{
    public Task InvokeAsync(HttpContext context)
    {
        if (!RemoteAccessClaims.IsRequester(context.User)) return next(context);
        var endpoint = context.GetEndpoint();
        if (endpoint is null || endpoint.Metadata.GetMetadata<RequesterAccess>() is not null) return next(context);
        logger.LogInformation("Refused a requester request to {Endpoint}.", endpoint.DisplayName);
        return RemoteAccessMiddleware.WriteRequesterForbidden(context);
    }
}

/// <summary>Maps a signed-in requester email to a <see cref="User"/> row, creating it on first sight.</summary>
public sealed class RequesterDirectory(IDbContextFactory<TorrentFlowDbContext> factory, TimeProvider time)
{
    private const int MaxCached = 1_000;
    private readonly ConcurrentDictionary<string, string> _ids = new(StringComparer.Ordinal);

    public async Task<string> GetOrCreateUserIdAsync(string email, CancellationToken ct)
    {
        var normalized = email.Trim().ToLowerInvariant();
        if (_ids.TryGetValue(normalized, out var cached)) return cached;
        await using var db = await factory.CreateDbContextAsync(ct);
        var id = await db.Users.Where(u => u.Email == normalized).Select(u => u.Id).FirstOrDefaultAsync(ct);
        if (id is null)
        {
            var now = time.GetUtcNow().UtcDateTime;
            var user = new User { Id = Ids.New(), Email = normalized, CreatedAt = now, UpdatedAt = now };
            db.Users.Add(user);
            try
            {
                await db.SaveChangesAsync(ct);
                id = user.Id;
            }
            catch (DbUpdateException)
            {
                // Two first requests raced on the unique email index; the other one's row wins.
                db.ChangeTracker.Clear();
                id = await db.Users.Where(u => u.Email == normalized).Select(u => u.Id).FirstAsync(ct);
            }
        }
        if (id == LocalUser.Id) throw new InvalidOperationException("A requester email resolved to the local owner row.");
        if (_ids.Count >= MaxCached) _ids.Clear();
        _ids[normalized] = id;
        return id;
    }
}
