using System.Reflection;

namespace TorrentFlow.Core;

/// <summary>
/// Version string for /api/health. Prefer InformationalVersion (often includes git hash from CI);
/// fall back to AssemblyVersion; never report a bare 0.0.0.0 in dev without a "dev" marker.
/// </summary>
public static class BuildVersion
{
    public static string Id => IdFrom(typeof(BuildVersion).Assembly);

    public static string IdFrom(Assembly assembly)
    {
        var informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion?.Trim();
        if (!string.IsNullOrWhiteSpace(informational) && !IsZero(informational))
            return TrimPlus(informational);

        var name = assembly.GetName().Version?.ToString()?.Trim();
        if (!string.IsNullOrWhiteSpace(name) && !IsZero(name))
            return name!;

        // Local `dotnet run` / SkipWebBuild often ships 0.0.0.0 — mark it so support can tell builds apart.
        return "0.0.0.0-dev";
    }

    private static bool IsZero(string value)
    {
        var core = value.Split('+', StringSplitOptions.TrimEntries)[0];
        return core is "0.0.0.0" or "0.0.0" or "0.0";
    }

    private static string TrimPlus(string value)
    {
        // InformationalVersion may be "1.2.3+abcdef" — keep the hash; it's useful for support.
        return value.Length > 64 ? value[..64] : value;
    }
}
