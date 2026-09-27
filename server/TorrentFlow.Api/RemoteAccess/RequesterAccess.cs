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
    public const string RequesterPrefix = "requester";

    /// <summary>Path-only overload (GET). Prefer <see cref="IsAllowed(string, PathString)"/> when the method is known.</summary>
    public static bool IsAllowed(PathString path) => IsAllowed(HttpMethods.Get, path);

    /// <summary>
    /// Anything outside <c>/api</c> is a static asset or the SPA fallback; inside it, only method+path pairs from
    /// <see cref="RequesterAllowList"/>. Empty segments are ignored so <c>//api/x</c> cannot slip past, and casing
    /// never matters. Wrong methods on an otherwise-listed path are refused here.
    /// </summary>
    public static bool IsAllowed(string method, PathString path) => RequesterAllowList.IsAllowed(method, path);
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
