using System.Runtime.InteropServices;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace TorrentFlow.Media.Ffmpeg;

public sealed class FfBinaryMissingException(string binary, string pkg, string cause)
    : Exception($"{binary} is unavailable \u2014 the bundled \"{pkg}\" binary could not be resolved. " +
        $"Playback probing/transcoding is disabled until it is restored (set TorrentFlow:Media:{(binary == "ffmpeg" ? "FfmpegPath" : "FfprobePath")}, " +
        $"{(binary == "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH")}, run \"npm install {pkg}\", or put {binary} on PATH). Underlying error: {cause}");

/// <summary>
/// Resolves ffmpeg/ffprobe. Order: config <c>TorrentFlow:Media:FfmpegPath</c>/<c>FfprobePath</c> → env
/// <c>FFMPEG_PATH</c>/<c>FFPROBE_PATH</c> → the TS app's bundled npm binaries (<c>node_modules/ffmpeg-static</c>,
/// <c>node_modules/ffprobe-static/bin/&lt;platform&gt;/&lt;arch&gt;</c>) found walking up from the content root and
/// working directory → PATH. Results are cached once found.
/// </summary>
public sealed class FfBinaries
{
    private readonly MediaOptions _options;
    private readonly IReadOnlyList<string> _searchRoots;
    private readonly Func<string, string?> _env;
    private string? _ffmpeg;
    private string? _ffprobe;

    public FfBinaries(IOptions<MediaOptions> options, IHostEnvironment env)
        : this(options.Value, [env.ContentRootPath, Environment.CurrentDirectory, AppContext.BaseDirectory], Environment.GetEnvironmentVariable) { }

    internal FfBinaries(MediaOptions options, IReadOnlyList<string> searchRoots, Func<string, string?> env)
    {
        _options = options;
        _searchRoots = searchRoots;
        _env = env;
    }

    public string ResolveFfmpeg() => _ffmpeg ??= Resolve("ffmpeg", "ffmpeg-static", _options.FfmpegPath, "FFMPEG_PATH", FfmpegPackagePath);

    public string ResolveFfprobe() => _ffprobe ??= Resolve("ffprobe", "ffprobe-static", _options.FfprobePath, "FFPROBE_PATH", FfprobePackagePath);

    public string? TryResolveFfmpeg() { try { return ResolveFfmpeg(); } catch (FfBinaryMissingException) { return null; } }

    public string? TryResolveFfprobe() { try { return ResolveFfprobe(); } catch (FfBinaryMissingException) { return null; } }

    private static string Exe(string name) => OperatingSystem.IsWindows() ? name + ".exe" : name;

    private static string FfmpegPackagePath(string nodeModules) => Path.Combine(nodeModules, "ffmpeg-static", Exe("ffmpeg"));

    private static string FfprobePackagePath(string nodeModules)
    {
        var platform = OperatingSystem.IsWindows() ? "win32" : OperatingSystem.IsMacOS() ? "darwin" : "linux";
        var arch = RuntimeInformation.OSArchitecture switch
        {
            Architecture.Arm64 => "arm64",
            Architecture.X86 => "ia32",
            Architecture.Arm => "arm",
            _ => "x64",
        };
        return Path.Combine(nodeModules, "ffprobe-static", "bin", platform, arch, Exe("ffprobe"));
    }

    private string Resolve(string binary, string pkg, string? configured, string envVar, Func<string, string> packagePath)
    {
        if (!string.IsNullOrWhiteSpace(configured))
        {
            if (!File.Exists(configured)) throw new FfBinaryMissingException(binary, pkg, $"TorrentFlow:Media path \"{configured}\" does not exist on disk");
            return Path.GetFullPath(configured);
        }
        var fromEnv = _env(envVar);
        if (!string.IsNullOrWhiteSpace(fromEnv))
        {
            if (!File.Exists(fromEnv)) throw new FfBinaryMissingException(binary, pkg, $"{envVar}=\"{fromEnv}\" does not exist on disk");
            return Path.GetFullPath(fromEnv);
        }
        var roots = new List<string>();
        if (!string.IsNullOrWhiteSpace(_options.NodeModulesRoot)) roots.Add(_options.NodeModulesRoot);
        roots.AddRange(_searchRoots);
        foreach (var root in roots.Where(r => !string.IsNullOrWhiteSpace(r)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            for (var dir = new DirectoryInfo(Path.GetFullPath(root)); dir is not null; dir = dir.Parent)
            {
                var candidate = packagePath(Path.Combine(dir.FullName, "node_modules"));
                if (File.Exists(candidate)) return candidate;
            }
        }
        var onPath = FindOnPath(Exe(binary), _env("PATH"));
        if (onPath is not null) return onPath;
        throw new FfBinaryMissingException(binary, pkg, $"no {envVar}, no node_modules/{pkg} above {string.Join(", ", _searchRoots)}, and {binary} is not on PATH");
    }

    internal static string? FindOnPath(string exe, string? pathVar)
    {
        if (string.IsNullOrWhiteSpace(pathVar)) return null;
        foreach (var dir in pathVar.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var candidate = Path.Combine(dir.Trim('"'), exe);
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException) { }
        }
        return null;
    }
}
