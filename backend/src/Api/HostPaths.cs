using Microsoft.Extensions.FileProviders;
using System.Text.Json;

namespace TorrentFlow.Api;

internal static class HostPaths
{
    public static string DataDirectory(IConfiguration configuration)
    {
        var configured = configuration["TorrentFlow:DataDirectory"];
        var portable = File.Exists(Path.Combine(AppContext.BaseDirectory, "portable"));
        var defaultRoot = OperatingSystem.IsWindows()
            ? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
            : OperatingSystem.IsMacOS()
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "Application Support")
                : Environment.GetEnvironmentVariable("XDG_DATA_HOME") is { Length: > 0 } xdg && Path.IsPathFullyQualified(xdg)
                    ? xdg : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share");
        // Never adopt, copy or probe old data. Even portable builds get a distinct rebuild directory.
        var result = Path.GetFullPath(!string.IsNullOrWhiteSpace(configured) ? configured
            : portable ? Path.Combine(AppContext.BaseDirectory, "rebuild-data")
            : Path.Combine(defaultRoot, "TorrentFlow-Rebuild"));
        Directory.CreateDirectory(result);
        if (File.Exists(Path.Combine(result, "conversion-started.json")) || Directory.Exists(Path.Combine(result, "legacy-backup")))
        {
            var complete = Path.Combine(result, "conversion-complete.json");
            var valid = false;
            try
            {
                if (File.Exists(complete))
                {
                    using var marker = JsonDocument.Parse(File.ReadAllText(complete));
                    valid = marker.RootElement.TryGetProperty("completed", out var completed) &&
                        completed.ValueKind == JsonValueKind.True &&
                        File.Exists(Path.Combine(result, "torrentflow.db")) &&
                        File.Exists(Path.Combine(result, "legacy-backup", "torrentflow.db"));
                }
            }
            catch (JsonException) { }
            if (!valid)
                throw new InvalidOperationException("Conversion did not finish. Do not start this data directory. Preserve it and run the converter with a fresh destination and fresh payload copies, or start the old server on its untouched data.");
        }
        configuration["TorrentFlow:DataDirectory"] = result;
        return result;
    }

    public static PhysicalFileProvider? WebFiles(IConfiguration configuration, string contentRoot)
    {
        var configured = configuration["TorrentFlow:WebRoot"];
        if (!string.IsNullOrWhiteSpace(configured))
        {
            var path = Path.GetFullPath(configured);
            if (!File.Exists(Path.Combine(path, "index.html")))
                throw new InvalidOperationException("The configured web build is missing index.html. Build web with pnpm build first.");
            return new PhysicalFileProvider(path);
        }
        var roots = new[] { AppContext.BaseDirectory, contentRoot };
        foreach (var root in roots)
        {
            for (var directory = new DirectoryInfo(root); directory is not null; directory = directory.Parent)
            {
                foreach (var path in new[] { Path.Combine(directory.FullName, "wwwroot"), Path.Combine(directory.FullName, "web", "dist") })
                    if (File.Exists(Path.Combine(path, "index.html"))) return new PhysicalFileProvider(path);
            }
        }
        return null;
    }
}
