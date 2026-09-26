using System.Diagnostics;
using System.Security.Cryptography;

namespace TorrentFlow.Api.Desktop;

public sealed record DownloadProgress(string State, long ReceivedBytes, long? TotalBytes, string? Error)
{
    public const string Idle = "idle";
    public const string Downloading = "downloading";
    public const string Installing = "installing";
    public const string Done = "done";
    public const string Failed = "failed";

    public static readonly DownloadProgress None = new(Idle, 0, null, null);
}

/// <summary>Streams a URL to a file while hashing it; the file only appears under its final name once the hash matches.</summary>
public static class VerifiedDownload
{
    public static async Task DownloadAsync(HttpClient client, string url, string destination, string? expectedSha256, long? expectedSize,
        Action<long, long?> progress, CancellationToken ct)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        var part = destination + ".part";
        try
        {
            using (var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct))
            {
                response.EnsureSuccessStatusCode();
                var total = response.Content.Headers.ContentLength ?? expectedSize;
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                await using var body = await response.Content.ReadAsStreamAsync(ct);
                await using (var file = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true))
                {
                    var buffer = new byte[81920];
                    long received = 0;
                    int read;
                    while ((read = await body.ReadAsync(buffer, ct)) > 0)
                    {
                        hash.AppendData(buffer, 0, read);
                        await file.WriteAsync(buffer.AsMemory(0, read), ct);
                        received += read;
                        progress(received, total);
                    }
                    if (expectedSize is { } size && received != size)
                        throw new InvalidDataException($"The download was {received:N0} bytes; expected {size:N0}.");
                }
                var actual = Convert.ToHexString(hash.GetHashAndReset());
                if (expectedSha256 is not null && !Sha256Equals(actual, expectedSha256))
                    throw new InvalidDataException("The download's SHA-256 checksum did not match, so it was discarded.");
            }
            File.Move(part, destination, overwrite: true);
        }
        finally
        {
            if (File.Exists(part)) File.Delete(part);
        }
    }

    public static bool Sha256Equals(string actualHex, string expectedHex) =>
        string.Equals(actualHex.Trim(), expectedHex.Trim(), StringComparison.OrdinalIgnoreCase);

    public static string Sha256Of(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream));
    }
}

public interface IProcessLauncher
{
    void Start(string fileName, string arguments);
}

public sealed class ShellProcessLauncher : IProcessLauncher
{
    public void Start(string fileName, string arguments) =>
        Process.Start(new ProcessStartInfo(fileName, arguments) { UseShellExecute = true })?.Dispose();
}

/// <summary>
/// One-click update: downloads the release's installer into the data directory, verifies it, starts it silently
/// with /UPDATE=1 (the installer relaunches TorrentFlow when done), then shuts this instance down so files unlock.
/// </summary>
public sealed class UpdateInstaller(
    DesktopEnvironment desktop,
    DesktopSettingsStore store,
    UpdateChecker checker,
    IHttpClientFactory http,
    IProcessLauncher launcher,
    IHostApplicationLifetime lifetime,
    ILogger<UpdateInstaller> logger)
{
    public const string InstallerArguments = "/SILENT /SP- /NOCANCEL /NORESTART /CLOSEAPPLICATIONS /UPDATE=1";
    private readonly Lock _gate = new();
    private DownloadProgress _progress = DownloadProgress.None;

    public DownloadProgress Progress
    {
        get { lock (_gate) return _progress; }
    }

    /// <summary>Starts the update in the background. Returns an error message when it cannot start.</summary>
    public string? Start()
    {
        var settings = store.Current;
        if (!checker.UpdateAvailable(settings) || settings.Latest is not { } latest) return "No update is available.";
        if (latest.InstallerUrl is null || latest.InstallerName is null)
            return "This release has no Windows installer attached. Download it from the release page instead.";
        // Never run an installer that cannot be checked against GitHub's published SHA-256.
        if (latest.InstallerSha256 is null)
            return "This release's installer has no published checksum. Download it from the release page instead.";
        lock (_gate)
        {
            if (_progress.State is DownloadProgress.Downloading or DownloadProgress.Installing) return null;
            _progress = new DownloadProgress(DownloadProgress.Downloading, 0, latest.InstallerSize, null);
        }
        _ = Task.Run(() => RunAsync(latest));
        return null;
    }

    private async Task RunAsync(LatestRelease latest)
    {
        try
        {
            var target = Path.Combine(desktop.DataDirectory, "updates", Path.GetFileName(latest.InstallerName!));
            await VerifiedDownload.DownloadAsync(http.CreateClient(GitHubReleaseSource.HttpClientName), latest.InstallerUrl!, target,
                latest.InstallerSha256, latest.InstallerSize, Report, lifetime.ApplicationStopping);
            Set(Progress with { State = DownloadProgress.Installing });
            logger.LogInformation("Starting the TorrentFlow {Version} installer; this instance will now exit.", latest.Version);
            launcher.Start(target, InstallerArguments);
            // Give the response poll a moment to show "installing", then release the files for the installer.
            await Task.Delay(TimeSpan.FromSeconds(1));
            lifetime.StopApplication();
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            logger.LogWarning(ex, "Update to {Version} failed", latest.Version);
            Set(Progress with { State = DownloadProgress.Failed, Error = ex is HttpRequestException ? "Could not download the installer." : ex.Message });
        }
    }

    private void Report(long received, long? total) => Set(new DownloadProgress(DownloadProgress.Downloading, received, total, null));

    private void Set(DownloadProgress next)
    {
        lock (_gate) _progress = next;
    }
}
