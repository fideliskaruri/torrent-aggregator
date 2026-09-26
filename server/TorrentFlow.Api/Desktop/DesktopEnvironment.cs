using System.Reflection;

namespace TorrentFlow.Api.Desktop;

/// <summary>
/// What the running process is: the installed Windows desktop app (published single-file exe on Windows) or a
/// server/dev build. Only the desktop app gets a tray icon, autostart, and self-update.
/// </summary>
public sealed class DesktopEnvironment(bool isDesktop, string? exePath, string version, string dataDirectory, string browserUrl, bool background)
{
    public const string BackgroundArg = "--background";
    public const string NoBrowserArg = "--no-browser";

    /// <summary>Published single-file exe running on Windows.</summary>
    public bool IsDesktop { get; } = isDesktop;

    public string? ExePath { get; } = exePath;

    /// <summary>Informational version without build metadata, e.g. "1.2.0". "0.0.0" is a local (unversioned) build.</summary>
    public string Version { get; } = version;

    public string DataDirectory { get; } = dataDirectory;

    public string BrowserUrl { get; } = browserUrl;

    /// <summary>Started with --background (autostart): no browser window.</summary>
    public bool Background { get; } = background;

    /// <summary>Local builds carry no release version, so there is nothing to compare an update against.</summary>
    public bool IsVersioned => ReleaseVersion.TryParse(Version, out var v) && v.Core > new System.Version(0, 0, 0);

    public static string CurrentVersion()
    {
        var info = typeof(DesktopEnvironment).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        var raw = string.IsNullOrWhiteSpace(info) ? typeof(DesktopEnvironment).Assembly.GetName().Version?.ToString(3) ?? "0.0.0" : info;
        var plus = raw.IndexOf('+');
        return plus >= 0 ? raw[..plus] : raw;
    }

    /// <summary>Removes the switch-only flags so the command-line configuration provider never pairs them with the next argument.</summary>
    public static string[] HostArgs(string[] args) =>
        args.Where(a => !IsFlag(a, BackgroundArg) && !IsFlag(a, NoBrowserArg)).ToArray();

    public static bool HasFlag(string[] args, string flag) => args.Any(a => IsFlag(a, flag));

    private static bool IsFlag(string arg, string flag) => string.Equals(arg, flag, StringComparison.OrdinalIgnoreCase);
}
