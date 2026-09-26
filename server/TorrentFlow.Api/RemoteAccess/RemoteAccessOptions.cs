using System.Net;
using System.Text.RegularExpressions;

namespace TorrentFlow.Api.RemoteAccess;

/// <summary>
/// Owner remote access through Cloudflare Tunnel + Access (config section <c>TorrentFlow:RemoteAccess</c>,
/// overlaid by <c>&lt;dataDir&gt;/remote-access.json</c>). <see cref="Enabled"/>, <see cref="TunnelPort"/> and
/// <see cref="TunnelBindAddress"/> only take effect on restart; the rest applies live.
/// </summary>
public sealed record RemoteAccessOptions
{
    public const string SectionName = "TorrentFlow:RemoteAccess";
    public const int DefaultTunnelPort = 3940;
    public const string DefaultBindAddress = "127.0.0.1";

    public bool Enabled { get; init; }
    public int TunnelPort { get; init; } = DefaultTunnelPort;
    public string TunnelBindAddress { get; init; } = DefaultBindAddress;
    /// <summary>The Zero Trust team name (the <c>&lt;team&gt;</c> in <c>&lt;team&gt;.cloudflareaccess.com</c>).</summary>
    public string? TeamDomain { get; init; }
    /// <summary>The Access application's AUD tag.</summary>
    public string? Audience { get; init; }
    /// <summary>Lowercase, de-duplicated.</summary>
    public IReadOnlyList<string> OwnerEmails { get; init; } = [];
    /// <summary>Signed-in emails that are not owners may search and request titles (and nothing else).</summary>
    public bool AllowRequesters { get; init; } = true;

    public string? Issuer => string.IsNullOrEmpty(TeamDomain) ? null : $"https://{TeamDomain}.cloudflareaccess.com";

    public bool IsConfigured => !string.IsNullOrEmpty(TeamDomain) && !string.IsNullOrEmpty(Audience) && OwnerEmails.Count > 0;

    public string TunnelUrl => $"http://{FormatHost(TunnelBindAddress)}:{TunnelPort}";

    public bool ListenerEquals(RemoteAccessOptions other) =>
        Enabled == other.Enabled && TunnelPort == other.TunnelPort
        && string.Equals(TunnelBindAddress, other.TunnelBindAddress, StringComparison.OrdinalIgnoreCase);

    public bool IsOwner(string email) =>
        OwnerEmails.Contains(email.Trim().ToLowerInvariant(), StringComparer.Ordinal);

    private static string FormatHost(string address) =>
        IPAddress.TryParse(address, out var ip) && ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6
            ? $"[{ip}]"
            : address;
}

public static partial class RemoteAccessRules
{
    public const int MinPort = 1024;
    public const int MaxPort = 65535;
    public const int MaxOwnerEmails = 50;

    /// <summary>Accepts <c>team</c>, <c>team.cloudflareaccess.com</c> or <c>https://team.cloudflareaccess.com/</c>.</summary>
    public static string? NormalizeTeamDomain(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var value = raw.Trim().ToLowerInvariant();
        if (value.StartsWith("https://", StringComparison.Ordinal)) value = value["https://".Length..];
        value = value.TrimEnd('/');
        const string suffix = ".cloudflareaccess.com";
        if (value.EndsWith(suffix, StringComparison.Ordinal)) value = value[..^suffix.Length];
        return TeamPattern().IsMatch(value) ? value : null;
    }

    public static bool IsValidAudience(string value) => AudiencePattern().IsMatch(value);

    public static string? NormalizeEmail(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var value = raw.Trim().ToLowerInvariant();
        return value.Length <= 254 && EmailPattern().IsMatch(value) ? value : null;
    }

    public static bool IsValidBindAddress(string value) => IPAddress.TryParse(value, out _);

    /// <summary>Ports in a Kestrel <c>urls</c> value (<c>;</c>-separated, wildcard hosts <c>*</c>/<c>+</c> allowed).</summary>
    public static IReadOnlyList<int> ParseOwnerPorts(string urls)
    {
        var ports = new List<int>();
        foreach (var raw in urls.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            // Kestrel accepts wildcard hosts (http://*:5000, http://+:5000) that Uri cannot parse.
            var normalized = raw.Replace("://*", "://localhost", StringComparison.Ordinal).Replace("://+", "://localhost", StringComparison.Ordinal);
            if (Uri.TryCreate(normalized, UriKind.Absolute, out var uri) && !ports.Contains(uri.Port))
                ports.Add(uri.Port);
        }
        return ports;
    }

    [GeneratedRegex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")]
    private static partial Regex TeamPattern();

    [GeneratedRegex("^[A-Za-z0-9_-]{8,256}$")]
    private static partial Regex AudiencePattern();

    [GeneratedRegex(@"^[^@\s""<>(),;:\\\[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")]
    private static partial Regex EmailPattern();
}
