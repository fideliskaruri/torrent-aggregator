using System.Collections.Immutable;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Api.Access;

public sealed partial class AccessState(IConfiguration configuration, IDbContextFactory<TorrentFlowDbContext> contexts)
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly SemaphoreSlim gate = new(1, 1);
    private RemoteAccessSettings current = new(false, 3939, null, null, [], true);
    public RemoteAccessSettings Current => Volatile.Read(ref current);
    public RemoteAccessSettings Startup { get; private set; } = new(false, 3939, null, null, [], true);
    public int[] OwnerPorts { get; private set; } = [];
    public bool Listening { get; private set; }
    public bool RestartRequired => !ListenerEquals(Current, Startup);
    public static string Url(RemoteAccessSettings value) =>
        $"http://{(IPAddress.Parse(value.TunnelBindAddress).AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 ? $"[{value.TunnelBindAddress}]" : value.TunnelBindAddress)}:{value.TunnelPort}";
    private static bool ListenerEquals(RemoteAccessSettings a, RemoteAccessSettings b) =>
        a.Enabled == b.Enabled && a.TunnelPort == b.TunnelPort && a.TunnelBindAddress == b.TunnelBindAddress;

    public async Task InitializeAsync(WebApplication app, CancellationToken ct = default)
    {
        await using var db = await contexts.CreateDbContextAsync(ct);
        current = SettingsCatalog.Read<RemoteAccessSettings>(
            await db.Settings.AsNoTracking().SingleAsync(s => s.Id == "remoteAccess", ct));
        var section = configuration.GetSection("TorrentFlow:RemoteAccess");
        // Explicit host configuration is a startup overlay, never a caller-controlled identity.
        if (section.Exists())
        {
            var configured = current;
            if (bool.TryParse(section["Enabled"], out var enabled)) configured = configured with { Enabled = enabled };
            if (int.TryParse(section["TunnelPort"], out var port)) configured = configured with { TunnelPort = port };
            if (section["TunnelBindAddress"] is { } bind) configured = configured with { TunnelBindAddress = bind };
            if (section["TeamDomain"] is { } team) configured = configured with { TeamDomain = team };
            if (section["Audience"] is { } audience) configured = configured with { Audience = audience };
            if (bool.TryParse(section["AllowRequesters"], out var allow)) configured = configured with { AllowRequesters = allow };
            var emails = section.GetSection("OwnerEmails").GetChildren().Select(x => x.Value).OfType<string>().ToArray();
            if (emails.Length == 0 && section["OwnerEmails"] is { } list)
                emails = list.Split([',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (emails.Length > 0) configured = configured with { OwnerEmails = [.. emails] };
            var problem = Validate(ref configured);
            if (problem is not null) throw new InvalidOperationException(problem);
            current = configured;
        }
        var invalid = Validate(ref current);
        if (invalid is not null) throw new InvalidOperationException(invalid);
        Startup = current;
        var urls = configuration["urls"] ?? "http://127.0.0.1:3940";
        OwnerPorts = urls.Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Select(x => new Uri(x.Replace("://*", "://localhost", StringComparison.Ordinal)
                .Replace("://+", "://localhost", StringComparison.Ordinal)).Port).Distinct().ToArray();
        if (Startup.Enabled)
        {
            if (OwnerPorts.Contains(Startup.TunnelPort))
                throw new InvalidOperationException("The tunnel port must not share an owner port.");
            foreach (var ownerUrl in urls.Split(';', StringSplitOptions.RemoveEmptyEntries))
                app.Urls.Add(ownerUrl);
            app.Urls.Add(Url(Startup));
        }
        app.Lifetime.ApplicationStarted.Register(() => Listening = Startup.Enabled &&
            app.Urls.Any(x => Uri.TryCreate(x, UriKind.Absolute, out var uri) && uri.Port == Startup.TunnelPort));
        await EnsureUserAsync(db, "local", null, UserRole.Owner, ct);
    }

    public async Task<bool> SaveAsync(RemoteAccessSettings next, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(ct);
            var row = await db.Settings.SingleAsync(s => s.Id == "remoteAccess", ct);
            var updated = row with { Value = JsonSerializer.SerializeToElement(next, Json),
                Revision = row.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
            SettingsCatalog.Validate(updated);
            db.Entry(row).CurrentValues.SetValues(updated);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateConcurrencyException) { return false; }
            Volatile.Write(ref current, next);
            return true;
        }
        finally { gate.Release(); }
    }

    internal static async Task EnsureUserAsync(TorrentFlowDbContext db, string id, string? email, UserRole role, CancellationToken ct)
    {
        var existing = await db.Users.SingleOrDefaultAsync(u => u.Id == id, ct);
        if (existing is not null && existing.Role == role && existing.NormalizedEmail == email) return;
        var now = DateTimeOffset.UtcNow;
        if (existing is null)
            db.Users.Add(new UserRow { Id = id, NormalizedEmail = email, Name = email is null ? "Local" : null, Image = null, Role = role, CreatedAt = now, UpdatedAt = now });
        else
            db.Entry(existing).CurrentValues.SetValues(existing with { Role = role, NormalizedEmail = email, UpdatedAt = now });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException ex) when (ex is DbUpdateConcurrencyException || ex.InnerException is SqliteException { SqliteErrorCode: 19 })
        {
            db.ChangeTracker.Clear();
            var winner = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == id, ct);
            if (winner?.Role != role || winner.NormalizedEmail != email)
                throw new InvalidOperationException("The user changed during sign-in. Try signing in again.");
        }
    }

    internal static string? Validate(ref RemoteAccessSettings next)
    {
        if (next.TunnelPort is < 1024 or > 65535) return "tunnelPort must be between 1024 and 65535";
        if (!IPAddress.TryParse(next.TunnelBindAddress, out _)) return "tunnelBindAddress must be an IP address such as 127.0.0.1";
        var team = next.TeamDomain?.Trim().ToLowerInvariant();
        if (team?.StartsWith("https://", StringComparison.Ordinal) == true) team = team[8..];
        team = team?.TrimEnd('/');
        if (team?.EndsWith(".cloudflareaccess.com", StringComparison.Ordinal) == true) team = team[..^21];
        if (!string.IsNullOrEmpty(team) && !TeamPattern().IsMatch(team))
            return "teamDomain must be your Cloudflare team name, such as myteam or myteam.cloudflareaccess.com";
        var audience = next.Audience?.Trim();
        if (!string.IsNullOrEmpty(audience) && !AudiencePattern().IsMatch(audience)) return "audience must be the Access application's AUD tag";
        if (next.OwnerEmails.IsDefault || next.OwnerEmails.Length > 50) return "ownerEmails must contain at most 50 email addresses";
        var emails = next.OwnerEmails.Select(x => x.Trim().ToLowerInvariant()).Distinct().ToImmutableArray();
        if (emails.Any(x => x.Length > 254 || !EmailPattern().IsMatch(x))) return "ownerEmails contains an invalid email address";
        next = next with { TeamDomain = string.IsNullOrEmpty(team) ? null : team,
            Audience = string.IsNullOrEmpty(audience) ? null : audience, OwnerEmails = emails,
            TunnelBindAddress = next.TunnelBindAddress.Trim() };
        return null;
    }

    [GeneratedRegex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")]
    private static partial Regex TeamPattern();
    [GeneratedRegex("^[A-Za-z0-9_-]{8,256}$")]
    private static partial Regex AudiencePattern();
    [GeneratedRegex(@"^[^@\s""<>(),;:\\\[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")]
    private static partial Regex EmailPattern();
}
