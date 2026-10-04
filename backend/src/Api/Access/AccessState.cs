using System.Collections.Immutable;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Api.Access;

public sealed partial class AccessState(IConfiguration configuration, IServiceScopeFactory scopes)
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
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<IStore>();
        var row = (await store.ReadAsync<SettingRow>(Query("remoteAccess"), ct)).Single();
        current = SettingsCatalog.Read<RemoteAccessSettings>(row);
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
        await EnsureUserAsync(store, "local", null, UserRole.Owner, ct);
    }

    public async Task<bool> SaveAsync(RemoteAccessSettings next, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredService<IStore>();
            var old = (await store.ReadAsync<SettingRow>(Query("remoteAccess"), ct)).Single();
            var row = old with { Value = JsonSerializer.SerializeToElement(next, Json),
                Revision = old.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
            var result = await CommitAsync(store, row, old.Revision, null, ct);
            if (result.Applied) Volatile.Write(ref current, next);
            return result.Applied;
        }
        finally { gate.Release(); }
    }

    public static StoreQuery Query(string? id = null, string? userId = null, string? cursor = null) =>
        new(id, null, null, null, userId, null, null, null, null, null, null, null, null, cursor, 500, StoreOrder.PrimaryKey);

    internal static async Task<ImmutableArray<T>> AllAsync<T>(IStore store, CancellationToken ct, string? userId = null)
        where T : StoreRow
    {
        var rows = ImmutableArray.CreateBuilder<T>();
        string? cursor = null;
        while (true)
        {
            var page = await store.ReadAsync<T>(Query(userId: userId, cursor: cursor), ct);
            rows.AddRange(page);
            if (page.Length < 500) return rows.ToImmutable();
            cursor = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(page[^1].Id));
        }
    }

    internal static async Task<string> EnsureUserAsync(IStore store, string id, string? email, UserRole role, CancellationToken ct)
    {
        var existing = (await store.ReadAsync<UserRow>(Query(id), ct)).SingleOrDefault();
        if (existing is not null && existing.Role == role && existing.NormalizedEmail == email) return existing.Id;
        var now = DateTimeOffset.UtcNow;
        var row = existing is null ? new UserRow { Id = id, NormalizedEmail = email, Name = email is null ? "Local" : null, Image = null, Role = role, CreatedAt = now, UpdatedAt = now }
            : existing with { Role = role, NormalizedEmail = email, UpdatedAt = now };
        var result = await CommitAsync(store, row, null, existing, ct);
        if (!result.Applied)
        {
            var winner = (await store.ReadAsync<UserRow>(Query(id), ct)).SingleOrDefault();
            if (winner?.Role != role || winner.NormalizedEmail != email)
                throw new InvalidOperationException("The user changed during sign-in. Try signing in again.");
        }
        return row.Id;
    }

    internal static Task<CommitResult> CommitAsync(IStore store, StoreRow row, long? version, StoreRow? expected, CancellationToken ct)
    {
        var key = Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        var receipt = new AttemptRow { Id = $"commit:access:{key}", TargetId = null, WorkId = null, ReleaseHash = null, ActorUserId = null, Kind = AttemptKind.LegacyEvent, StartedAt = now, EndedAt = now, Outcome = "applied", ReasonCode = "access", ReasonText = null, Decision = null, LegacyContext = null, BatchId = null, DownloadId = null, DeadlineAt = null, Swap = null };
        return store.CommitAsync(new StoreCommit(key, StoreOwner.Targets,
            [new RowWrite(row, version, expected), new RowWrite(receipt, null, null)], []), ct);
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
