using System.Text.Json;
using TorrentFlow.Api.RemoteAccess;

namespace TorrentFlow.Api.Desktop;

public static class DesktopModule
{
    /// <summary>Desktop services exist on every platform so /api/desktop can answer; they only act on the Windows desktop app.</summary>
    public static IServiceCollection AddDesktop(this IServiceCollection services, DesktopEnvironment desktop, string toolsDirectory)
    {
        services.AddSingleton(desktop);
        services.AddSingleton(sp => new DesktopSettingsStore(desktop.DataDirectory, sp.GetRequiredService<ILogger<DesktopSettingsStore>>()));
        if (OperatingSystem.IsWindows()) services.AddSingleton<IAutostartRegistry, WindowsAutostartRegistry>();
        else services.AddSingleton<IAutostartRegistry, UnsupportedAutostartRegistry>();
        services.AddSingleton<AutostartService>();
        services.AddHttpClient(GitHubReleaseSource.HttpClientName, c =>
        {
            c.Timeout = TimeSpan.FromMinutes(10);
            c.DefaultRequestHeaders.UserAgent.ParseAdd($"TorrentFlow/{desktop.Version}");
        });
        services.AddHttpClient(FfmpegInstaller.HttpClientName, c =>
        {
            c.Timeout = TimeSpan.FromMinutes(20);
            c.DefaultRequestHeaders.UserAgent.ParseAdd($"TorrentFlow/{desktop.Version}");
        });
        services.AddSingleton<IReleaseSource, GitHubReleaseSource>();
        services.AddSingleton<IProcessLauncher, ShellProcessLauncher>();
        services.AddSingleton<UpdateChecker>();
        services.AddHostedService(sp => sp.GetRequiredService<UpdateChecker>());
        services.AddSingleton<UpdateInstaller>();
        services.AddSingleton(sp => new FfmpegInstaller(toolsDirectory,
            sp.GetRequiredService<TorrentFlow.Media.Tools.FfmpegLocator>(),
            sp.GetRequiredService<IHttpClientFactory>(),
            sp.GetRequiredService<ILogger<FfmpegInstaller>>()));
        services.AddHostedService<DesktopShellService>();
        return services;
    }

    private sealed class UnsupportedAutostartRegistry : IAutostartRegistry
    {
        public string? Get(string name) => null;
        public void Set(string name, string command) => throw new PlatformNotSupportedException();
        public void Delete(string name) { }
    }
}

public static class DesktopEndpoints
{
    public static IEndpointRouteBuilder MapDesktopEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/desktop", (HttpContext http, DesktopEnvironment desktop, DesktopSettingsStore store, AutostartService autostart,
            UpdateChecker checker, UpdateInstaller installer, FfmpegInstaller ffmpeg) =>
        {
            http.Response.Headers.CacheControl = "no-store";
            return Results.Json(Describe(http, desktop, store, autostart, checker, installer, ffmpeg));
        });

        app.MapPut("/api/desktop/settings", async (HttpContext http, DesktopEnvironment desktop, DesktopSettingsStore store, AutostartService autostart,
            UpdateChecker checker, UpdateInstaller installer, FfmpegInstaller ffmpeg, ILogger<DesktopSettingsStore> logger) =>
        {
            if (Refuse(http) is { } refused) return refused;
            if (http.Request.ContentLength > 4096) return Error(413, "JSON body is too large");
            JsonElement body;
            try
            {
                using var doc = await JsonDocument.ParseAsync(http.Request.Body, cancellationToken: http.RequestAborted);
                body = doc.RootElement.Clone();
            }
            catch (JsonException) { return Error(400, "Request body is not valid JSON"); }
            if (body.ValueKind != JsonValueKind.Object) return Error(400, "JSON body must be an object");

            bool? startWithWindows = null, checkForUpdates = null;
            foreach (var property in body.EnumerateObject())
            {
                if (property.Value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    return Error(400, $"{property.Name} must be a boolean");
                switch (property.Name)
                {
                    case "startWithWindows": startWithWindows = property.Value.GetBoolean(); break;
                    case "checkForUpdates": checkForUpdates = property.Value.GetBoolean(); break;
                    default: return Error(400, $"Unknown field `{property.Name}`");
                }
            }
            if (startWithWindows is not null && !autostart.Status().Available)
                return Error(409, "Start with Windows is only available in the installed Windows app.");
            try
            {
                if (startWithWindows is { } start) autostart.SetEnabled(start);
                if (checkForUpdates is { } check) store.Update(s => s with { CheckForUpdates = check });
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
            {
                logger.LogError(ex, "Could not save desktop settings");
                return Error(500, $"The setting could not be saved: {ex.Message}");
            }
            // Turning checks back on should not wait up to a day for the first answer.
            if (checkForUpdates == true && checker.IsDue(store.Current)) _ = Task.Run(() => checker.CheckNowAsync(CancellationToken.None));
            http.Response.Headers.CacheControl = "no-store";
            return Results.Json(Describe(http, desktop, store, autostart, checker, installer, ffmpeg));
        });

        app.MapPost("/api/desktop/update/check", async (HttpContext http, DesktopEnvironment desktop, DesktopSettingsStore store, AutostartService autostart,
            UpdateChecker checker, UpdateInstaller installer, FfmpegInstaller ffmpeg) =>
        {
            if (Refuse(http) is { } refused) return refused;
            if (!checker.Supported) return Error(409, "Update checks are only available in the installed Windows app.");
            await checker.CheckNowAsync(http.RequestAborted);
            http.Response.Headers.CacheControl = "no-store";
            return Results.Json(Describe(http, desktop, store, autostart, checker, installer, ffmpeg));
        });

        app.MapPost("/api/desktop/update/install", (HttpContext http, UpdateInstaller installer) =>
        {
            if (Refuse(http) is { } refused) return refused;
            var problem = installer.Start();
            return problem is null ? Results.Json(new { ok = true, progress = installer.Progress }, statusCode: 202) : Error(409, problem);
        });

        app.MapPost("/api/desktop/ffmpeg/download", (HttpContext http, FfmpegInstaller ffmpeg) =>
        {
            if (Refuse(http) is { } refused) return refused;
            var problem = ffmpeg.Start();
            return problem is null ? Results.Json(new { ok = true, ffmpeg = ffmpeg.Status() }, statusCode: 202) : Error(409, problem);
        });

        return app;
    }

    private static object Describe(HttpContext http, DesktopEnvironment desktop, DesktopSettingsStore store, AutostartService autostart,
        UpdateChecker checker, UpdateInstaller installer, FfmpegInstaller ffmpeg)
    {
        var settings = store.Current;
        var auto = autostart.Status();
        return new
        {
            supported = desktop.IsDesktop,
            platform = OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "macos" : OperatingSystem.IsLinux() ? "linux" : "other",
            version = desktop.Version,
            editable = !RemoteAccessClaims.IsTunnel(http),
            autostart = new { available = auto.Available, enabled = auto.Enabled, pointsElsewhere = auto.PointsElsewhere },
            updates = new
            {
                available = checker.Supported,
                enabled = settings.CheckForUpdates,
                checking = checker.Checking,
                lastCheckedAt = settings.LastCheckedAt,
                lastError = settings.LastCheckError,
                updateAvailable = checker.UpdateAvailable(settings),
                latest = settings.Latest is { } latest
                    ? new { version = latest.Version, tag = latest.Tag, pageUrl = latest.PageUrl, hasInstaller = latest.InstallerUrl is not null && latest.InstallerSha256 is not null }
                    : null,
                install = installer.Progress,
            },
            ffmpeg = ffmpeg.Status(),
        };
    }

    private static IResult? Refuse(HttpContext http) =>
        RemoteAccessClaims.IsTunnel(http) ? Error(403, "Desktop settings can only be changed on the computer running TorrentFlow.") : null;

    private static IResult Error(int status, string message) => Results.Json(new { error = message }, statusCode: status);
}
