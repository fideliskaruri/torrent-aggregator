using System.IO.Compression;
using TorrentFlow.Media.Tools;

namespace TorrentFlow.Api.Desktop;

/// <summary>A pinned ffmpeg build: the zip is only unpacked when its SHA-256 matches.</summary>
public sealed record FfmpegPackage(string Url, string Sha256, long Size, string Label)
{
    /// <summary>Gyan.dev "essentials" 7.1.1 (GPLv3) from the GyanD/codexffmpeg GitHub release.</summary>
    public static readonly FfmpegPackage Windows = new(
        "https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.zip",
        "04861D3339C5EBE38B56C19A15CF2C0CC97F5DE4FA8910E4D47E5E6404E4A2D4",
        92_234_348,
        "FFmpeg 7.1.1 essentials (gyan.dev, GPLv3)");
}

public sealed record FfmpegStatus(string? Ffmpeg, string? Ffprobe, bool Managed, bool CanDownload, string ToolsDirectory, string? PackageLabel, long? PackageSize, DownloadProgress Download);

/// <summary>
/// ffmpeg/ffprobe on demand: downloads the pinned Windows build into &lt;data&gt;/tools/ffmpeg (the managed tools
/// directory both locators search), after the owner asks for it.
/// </summary>
public sealed class FfmpegInstaller(
    string toolsDirectory,
    FfmpegLocator locator,
    IHttpClientFactory http,
    ILogger<FfmpegInstaller> logger,
    FfmpegPackage? package = null)
{
    public const string HttpClientName = "TorrentFlow.Tools";
    private static readonly string[] Binaries = ["ffmpeg.exe", "ffprobe.exe"];
    private readonly FfmpegPackage? _package = package ?? (OperatingSystem.IsWindows() ? FfmpegPackage.Windows : null);
    private readonly Lock _gate = new();
    private DownloadProgress _progress = DownloadProgress.None;

    public string ToolsDirectory { get; } = Path.GetFullPath(toolsDirectory);

    public FfmpegStatus Status()
    {
        var ffmpeg = locator.TryResolveFfmpeg();
        var ffprobe = locator.TryResolveFfprobe();
        var managed = ffmpeg is not null && IsUnder(ffmpeg, ToolsDirectory);
        DownloadProgress progress;
        lock (_gate) progress = _progress;
        return new FfmpegStatus(ffmpeg, ffprobe, managed, _package is not null, ToolsDirectory, _package?.Label, _package?.Size, progress);
    }

    public string? Start()
    {
        if (_package is null) return "Automatic ffmpeg download is only available on Windows. Install ffmpeg with your package manager.";
        lock (_gate)
        {
            if (_progress.State is DownloadProgress.Downloading or DownloadProgress.Installing) return null;
            _progress = new DownloadProgress(DownloadProgress.Downloading, 0, _package.Size, null);
        }
        _ = Task.Run(() => RunAsync(_package));
        return null;
    }

    private async Task RunAsync(FfmpegPackage pkg)
    {
        var zip = Path.Combine(ToolsDirectory, "ffmpeg-download.zip");
        try
        {
            await VerifiedDownload.DownloadAsync(http.CreateClient(HttpClientName), pkg.Url, zip, pkg.Sha256, pkg.Size,
                (received, total) => Set(new DownloadProgress(DownloadProgress.Downloading, received, total, null)), CancellationToken.None);
            Set(new DownloadProgress(DownloadProgress.Installing, pkg.Size, pkg.Size, null));
            ExtractTools(zip, ToolsDirectory);
            logger.LogInformation("Installed {Package} into {Directory}", pkg.Label, ToolsDirectory);
            Set(new DownloadProgress(DownloadProgress.Done, pkg.Size, pkg.Size, null));
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            logger.LogWarning(ex, "ffmpeg download failed");
            Set(new DownloadProgress(DownloadProgress.Failed, 0, pkg.Size, ex is HttpRequestException ? "Could not download ffmpeg. Check your connection and try again." : ex.Message));
        }
        finally
        {
            try { if (File.Exists(zip)) File.Delete(zip); } catch (IOException) { }
        }
    }

    /// <summary>Copies bin/ffmpeg.exe and bin/ffprobe.exe (plus the licence) out of a verified zip, each via a temp name.</summary>
    public static void ExtractTools(string zipPath, string destination)
    {
        Directory.CreateDirectory(destination);
        using var archive = ZipFile.OpenRead(zipPath);
        var found = new List<string>();
        foreach (var entry in archive.Entries)
        {
            var parts = entry.FullName.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries);
            string? name = null;
            if (parts.Length >= 2 && parts[^2].Equals("bin", StringComparison.OrdinalIgnoreCase)
                && Binaries.Contains(parts[^1], StringComparer.OrdinalIgnoreCase)) name = parts[^1].ToLowerInvariant();
            else if (parts.Length <= 2 && parts[^1].Equals("LICENSE", StringComparison.OrdinalIgnoreCase)) name = "LICENSE.txt";
            if (name is null) continue;
            var target = Path.Combine(destination, name);
            var temp = target + ".tmp";
            entry.ExtractToFile(temp, overwrite: true);
            File.Move(temp, target, overwrite: true);
            if (name != "LICENSE.txt") found.Add(name);
        }
        var missing = Binaries.Where(b => !found.Contains(b)).ToList();
        if (missing.Count > 0) throw new InvalidDataException($"The ffmpeg package did not contain {string.Join(" or ", missing)}.");
    }

    private static bool IsUnder(string path, string directory)
    {
        var full = Path.GetFullPath(path);
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory)) + Path.DirectorySeparatorChar;
        return full.StartsWith(root, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
    }

    private void Set(DownloadProgress next)
    {
        lock (_gate) _progress = next;
    }
}
