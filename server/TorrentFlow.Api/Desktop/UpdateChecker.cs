using System.Net;
using System.Text.Json;

namespace TorrentFlow.Api.Desktop;

public interface IReleaseSource
{
    /// <summary>The latest published release, or null when the repository has none yet.</summary>
    Task<LatestRelease?> GetLatestAsync(CancellationToken ct);
}

/// <summary>GitHub Releases "latest" (drafts and pre-releases excluded by GitHub).</summary>
public sealed class GitHubReleaseSource(IHttpClientFactory http) : IReleaseSource
{
    public const string HttpClientName = "TorrentFlow.Updates";
    public const string LatestUrl = "https://api.github.com/repos/fideliskaruri/torrent-aggregator/releases/latest";
    public const string InstallerPrefix = "TorrentFlow-Setup-";

    public async Task<LatestRelease?> GetLatestAsync(CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, LatestUrl);
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        request.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
        using var response = await http.CreateClient(HttpClientName).SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        await using var body = await response.Content.ReadAsStreamAsync(ct);
        using var doc = await JsonDocument.ParseAsync(body, cancellationToken: ct);
        return Parse(doc.RootElement);
    }

    internal static LatestRelease? Parse(JsonElement root)
    {
        var tag = root.TryGetProperty("tag_name", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
        if (!ReleaseVersion.TryParse(tag, out var version)) return null;
        string? name = null, url = null, sha = null;
        long? size = null;
        if (root.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
        {
            foreach (var asset in assets.EnumerateArray())
            {
                var assetName = Str(asset, "name");
                if (assetName is null || !assetName.StartsWith(InstallerPrefix, StringComparison.OrdinalIgnoreCase)
                    || !assetName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) continue;
                name = assetName;
                url = Str(asset, "browser_download_url");
                var digest = Str(asset, "digest");
                sha = digest is not null && digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase) ? digest[7..].ToLowerInvariant() : null;
                size = asset.TryGetProperty("size", out var s) && s.TryGetInt64(out var n) ? n : null;
                break;
            }
        }
        // Only an https download from GitHub is ever run.
        if (url is not null && !IsTrustedDownload(url)) (name, url, sha, size) = (null, null, null, null);
        return new LatestRelease(version.ToString(), tag!, Str(root, "html_url"), name, url, sha, size);
    }

    internal static bool IsTrustedDownload(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps
        && (uri.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".githubusercontent.com", StringComparison.OrdinalIgnoreCase));

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}

/// <summary>Checks for a newer release at most once a day while the desktop app runs and the owner has not turned it off.</summary>
public sealed class UpdateChecker(
    DesktopEnvironment desktop,
    DesktopSettingsStore store,
    IReleaseSource source,
    TimeProvider time,
    ILogger<UpdateChecker> logger) : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromDays(1);
    private readonly SemaphoreSlim _checking = new(1, 1);

    public bool Supported => desktop.IsDesktop && desktop.IsVersioned;

    public bool Checking => _checking.CurrentCount == 0;

    public bool UpdateAvailable(DesktopSettings settings) =>
        Supported && settings.CheckForUpdates && settings.Latest is { } latest && ReleaseVersion.IsNewer(latest.Version, desktop.Version);

    public bool IsDue(DesktopSettings settings) =>
        Supported && settings.CheckForUpdates
        && (settings.LastCheckedAt is not { } last || time.GetUtcNow() - last >= Interval || time.GetUtcNow() < last);

    public async Task<DesktopSettings> CheckNowAsync(CancellationToken ct)
    {
        await _checking.WaitAsync(ct);
        try
        {
            LatestRelease? latest;
            string? error = null;
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(20));
                latest = await source.GetLatestAsync(timeout.Token);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested && ex is HttpRequestException or OperationCanceledException or JsonException or IOException)
            {
                // Offline is normal for a desktop app; keep the last known result and try again tomorrow.
                logger.LogDebug(ex, "Update check failed");
                latest = store.Current.Latest;
                error = ex is OperationCanceledException ? "Timed out reaching GitHub." : "Could not reach GitHub.";
            }
            return store.Update(s => s with { LastCheckedAt = time.GetUtcNow(), LastCheckError = error, Latest = latest });
        }
        finally
        {
            _checking.Release();
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!Supported) return;
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(30), time, stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
            {
                if (IsDue(store.Current))
                {
                    try { await CheckNowAsync(stoppingToken); }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                    {
                        logger.LogWarning(ex, "Could not save the update check result");
                    }
                }
                await Task.Delay(TimeSpan.FromHours(1), time, stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
