using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace TorrentFlow.Engine.Layout;

/// <summary>Bound from TorrentFlow:Media. Only the ffprobe location is read here.</summary>
public sealed class LayoutMediaOptions
{
    public const string Section = "TorrentFlow:Media";
    public const string FfprobeEnvVar = "FFPROBE_PATH";

    public string? FfprobePath { get; set; }

    /// <summary>Extra roots searched for node_modules/ffprobe-static (the host adds its content root and data directory).</summary>
    public List<string> SearchRoots { get; set; } = [];
}

/// <summary>
/// Finds ffprobe the way the TypeScript app did, plus the obvious fallbacks: TorrentFlow:Media:FfprobePath, then
/// FFPROBE_PATH, then the ffprobe-static binary under a node_modules folder (cwd, content root and their ancestors),
/// then PATH. Resolved once, lazily: a missing binary disables validation only, and says so in one info log.
/// </summary>
internal sealed class FfprobeLocator
{
    private readonly Lazy<string?> _path;

    public FfprobeLocator(IOptions<LayoutMediaOptions> options, ILogger<FfprobeLocator> logger)
    {
        _path = new Lazy<string?>(() =>
        {
            var found = Find(options.Value.FfprobePath, Environment.GetEnvironmentVariable(LayoutMediaOptions.FfprobeEnvVar),
                [Environment.CurrentDirectory, AppContext.BaseDirectory, .. options.Value.SearchRoots]);
            if (found is null)
                logger.LogInformation("[content-layout] ffprobe not found (TorrentFlow:Media:FfprobePath, FFPROBE_PATH, node_modules/ffprobe-static, PATH); completed downloads are not media-validated");
            return found;
        });
    }

    public string? Path => _path.Value;

    /// <summary>Test seam: a fixed location (null = no ffprobe).</summary>
    internal FfprobeLocator(string? path) => _path = new Lazy<string?>(() => path);

    internal static string? Find(string? configured, string? env, IEnumerable<string> roots)
    {
        foreach (var candidate in new[] { configured, env })
            if (!string.IsNullOrWhiteSpace(candidate) && File.Exists(candidate.Trim())) return System.IO.Path.GetFullPath(candidate.Trim());

        var exe = OperatingSystem.IsWindows() ? "ffprobe.exe" : "ffprobe";
        var platform = OperatingSystem.IsWindows() ? "win32" : OperatingSystem.IsMacOS() ? "darwin" : "linux";
        var arch = RuntimeInformation.OSArchitecture switch
        {
            Architecture.Arm64 => "arm64",
            Architecture.X86 => "ia32",
            Architecture.Arm => "arm",
            _ => "x64",
        };
        foreach (var root in roots.Where(r => !string.IsNullOrWhiteSpace(r)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            for (var dir = new DirectoryInfo(root); dir is not null; dir = dir.Parent)
            {
                var bundled = System.IO.Path.Combine(dir.FullName, "node_modules", "ffprobe-static", "bin", platform, arch, exe);
                if (File.Exists(bundled)) return bundled;
            }
        }

        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(System.IO.Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var onPath = System.IO.Path.Combine(dir.Trim().Trim('"'), exe);
                if (File.Exists(onPath)) return onPath;
            }
            catch (ArgumentException) { }
        }
        return null;
    }
}

internal enum MediaVerdict { Skipped, Valid, Invalid }

/// <summary>
/// Port of validatedPersistedVerifiedState: a completed release must hold at least one supported video, and every
/// video must probe to a real video stream. A fake (renamed archive, zero-filled placeholder, "codec pack" exe) is
/// flagged so the caller can choose another release. Optional: with no ffprobe, validation is skipped.
/// </summary>
internal sealed class CompletedMediaValidator(FfprobeLocator locator, ILogger<CompletedMediaValidator> logger)
{
    public const string InvalidCompletedMediaMessage =
        "The downloaded release did not contain playable video. TorrentFlow will choose another release.";

    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(15);

    private static readonly Regex VideoExtension = new(@"\.(?:mkv|mp4|avi|m4v|mov|wmv|flv|webm|ts|m2ts|mpg|mpeg|vob)$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>One authoritative filename rule for content the app treats as video (isSupportedVideoFileName).</summary>
    public static bool IsSupportedVideoFileName(string name) => VideoExtension.IsMatch(name.Replace('\\', '/'));

    public bool Available => locator.Path is not null;

    public async Task<MediaVerdict> ValidateAsync(IReadOnlyList<string> files, CancellationToken ct)
    {
        if (locator.Path is not { } ffprobe) return MediaVerdict.Skipped;

        var videos = files.Where(IsSupportedVideoFileName).ToList();
        if (videos.Count == 0) return MediaVerdict.Invalid;

        foreach (var file in videos)
        {
            var outcome = await ProbeAsync(ffprobe, file, ct);
            if (outcome is null) return MediaVerdict.Skipped;
            if (outcome == false) return MediaVerdict.Invalid;
        }
        return MediaVerdict.Valid;
    }

    /// <summary>ffprobe arguments for a local file (buildProbeArgs without the network-only options).</summary>
    internal static IReadOnlyList<string> BuildProbeArgs(string input) =>
        ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", "-analyzeduration", "5000000", "-probesize", "10000000", input];

    /// <summary>True when ffprobe reports at least one stream and one of them is video (parseProbeOutput's contract).</summary>
    internal static bool HasVideoStream(string stdout)
    {
        try
        {
            using var doc = JsonDocument.Parse(stdout);
            if (!doc.RootElement.TryGetProperty("streams", out var streams) || streams.ValueKind != JsonValueKind.Array || streams.GetArrayLength() == 0)
                return false;
            foreach (var s in streams.EnumerateArray())
                if (s.TryGetProperty("codec_type", out var type) && type.ValueKind == JsonValueKind.String
                    && string.Equals(type.GetString(), "video", StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <summary>True/false for a probe verdict; null when ffprobe itself could not run (validation is skipped, not failed).</summary>
    private async Task<bool?> ProbeAsync(string ffprobe, string file, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(ffprobe)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in BuildProbeArgs(file)) psi.ArgumentList.Add(arg);

        Process process;
        try
        {
            process = Process.Start(psi) ?? throw new Win32Exception("ffprobe did not start");
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            logger.LogWarning(ex, "[content-layout] ffprobe is unavailable; skipping media validation");
            return null;
        }

        using (process)
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            timeout.CancelAfter(ProbeTimeout);
            var stdout = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var stderr = process.StandardError.ReadToEndAsync(timeout.Token);
            try
            {
                await process.WaitForExitAsync(timeout.Token);
                var output = await stdout;
                await stderr;
                return process.ExitCode == 0 && HasVideoStream(output);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
                return false;
            }
        }
    }
}
