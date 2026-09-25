using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.FileProviders;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.RemoteAccess;
using TorrentFlow.Api.Requests;
using TorrentFlow.Data;
using TorrentFlow.Engine;
using TorrentFlow.Library;
using TorrentFlow.Media;
using TorrentFlow.Metadata;
using TorrentFlow.Search;
using TorrentFlow.Api;

// Culture-neutral formatting everywhere (numbers in headers, ffmpeg args, logs), whatever the machine locale is.
System.Globalization.CultureInfo.DefaultThreadCurrentCulture = System.Globalization.CultureInfo.InvariantCulture;
System.Globalization.CultureInfo.DefaultThreadCurrentUICulture = System.Globalization.CultureInfo.InvariantCulture;

var builder = WebApplication.CreateBuilder(args);
var isPublishedBundle = IsPublishedBundle();

// Local single-user app: listen on loopback only unless the owner overrides --urls.
var configuredUrls = builder.Configuration["urls"];
var aspNetCoreUrls = Environment.GetEnvironmentVariable("ASPNETCORE_URLS");
var defaultUrl = "http://127.0.0.1:3000";
var ownerUrls = !string.IsNullOrWhiteSpace(configuredUrls) ? configuredUrls
    : !string.IsNullOrWhiteSpace(aspNetCoreUrls) ? aspNetCoreUrls
    : defaultUrl;

var dataDir = DataDirectoryResolver.Resolve(builder.Configuration["TorrentFlow:DataDirectory"],
    builder.Environment.ContentRootPath, AppContext.BaseDirectory, DataDirectoryResolver.DefaultDirectory(), Console.WriteLine);
Directory.CreateDirectory(dataDir);
builder.Configuration["TorrentFlow:DataDirectory"] = dataDir;

// Remote access adds a second listener meant only for cloudflared. It joins the same UseUrls list: calling
// ConfigureKestrel().Listen() would silently override --urls / ASPNETCORE_URLS.
var remoteAccess = RemoteAccessStore.Load(builder.Configuration, dataDir);
foreach (var warning in remoteAccess.LoadWarnings)
    Console.Error.WriteLine($"TorrentFlow remote access: {warning}");
remoteAccess.OwnerPorts = OwnerPorts(ownerUrls);
if (remoteAccess.Startup.Enabled)
{
    if (remoteAccess.OwnerPorts.Contains(remoteAccess.Startup.TunnelPort))
    {
        var clash = $"TorrentFlow could not start because the remote access tunnel port {remoteAccess.Startup.TunnelPort} is the same port TorrentFlow uses on this computer ({ownerUrls}). Choose a different tunnel port in {remoteAccess.FilePath} or TorrentFlow:RemoteAccess:TunnelPort.";
        if (!isPublishedBundle) throw new InvalidOperationException(clash);
        ExitWithMessage(clash);
        return;
    }
    builder.WebHost.UseUrls(ownerUrls + ";" + remoteAccess.Startup.TunnelUrl);
}
else if (string.IsNullOrWhiteSpace(configuredUrls) && string.IsNullOrWhiteSpace(aspNetCoreUrls))
{
    builder.WebHost.UseUrls(defaultUrl);
}

if (isPublishedBundle && string.IsNullOrWhiteSpace(configuredUrls) && string.IsNullOrWhiteSpace(aspNetCoreUrls))
{
    if (!IsPortAvailable(IPAddress.Loopback, 3000))
    {
        ExitWithMessage("TorrentFlow could not start because http://127.0.0.1:3000 is already in use. Close the other app or launch TorrentFlow with --urls <address>.");
        return;
    }
}
if (isPublishedBundle && remoteAccess.Startup.Enabled
    && !IsPortAvailable(IPAddress.Parse(remoteAccess.Startup.TunnelBindAddress), remoteAccess.Startup.TunnelPort))
{
    ExitWithMessage($"TorrentFlow could not start because the remote access port {remoteAccess.Startup.TunnelUrl} is already in use. Close the other app or choose a different tunnel port in {remoteAccess.FilePath}.");
    return;
}
var dbPath = builder.Configuration["TorrentFlow:DatabasePath"] ?? Path.Combine(dataDir, "torrentflow.db");
builder.Services.AddTorrentFlowData($"Data Source={dbPath}");

builder.Services
    .AddSearchModule(builder.Configuration)
    .AddMetadataModule(builder.Configuration)
    .AddEngineModule(builder.Configuration)
    .AddLibraryModule(builder.Configuration)
    .AddMediaModule(builder.Configuration);

builder.Services.AddControllers()
    .AddApplicationPart(typeof(SearchModule).Assembly)
    .AddApplicationPart(typeof(MetadataModule).Assembly)
    .AddApplicationPart(typeof(EngineModule).Assembly)
    .AddApplicationPart(typeof(LibraryModule).Assembly)
    .AddApplicationPart(typeof(MediaModule).Assembly)
    .AddJsonOptions(o =>
    {
        o.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        o.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
    });

builder.Services.AddSingleton(remoteAccess);
builder.Services.TryAddSingleton(TimeProvider.System);
builder.Services.AddHttpClient(HttpAccessKeySource.HttpClientName, c => c.Timeout = TimeSpan.FromSeconds(10));
builder.Services.AddSingleton<IAccessKeySource, HttpAccessKeySource>();
builder.Services.AddSingleton<AccessKeyCache>();
builder.Services.AddSingleton<AccessTokenValidator>();
builder.Services.AddSingleton<RequesterDirectory>();
builder.Services.Configure<RequestOptions>(builder.Configuration.GetSection(RequestOptions.SectionName));
builder.Services.AddSingleton<IRequesterCatalog, RequesterCatalog>();
builder.Services.AddSingleton<MediaRequestService>();

var app = builder.Build();
app.Logger.LogInformation("TorrentFlow data directory: {DataDirectory}; database: {DatabasePath}", dataDir, dbPath);
await app.Services.GetRequiredService<DatabaseInitializer>().InitializeAsync();

// Trust is decided first, before static files, the SPA fallback and every endpoint.
app.UseMiddleware<RemoteAccessMiddleware>();
app.UseMiddleware<UnsafeMethodGuardMiddleware>();

// The React SPA (web/) builds into web/dist. Static files run before routing so the history-API fallback
// below never captures real assets (it would answer /assets/*.js with index.html).
// Published: wwwroot beside the exe. Dev: web/dist, whether launched via `dotnet run` (content root
// = server/TorrentFlow.Api) or `dotnet <dll>` from the repo root.
IFileProvider? webFiles = ResolveWebRootFileProvider(builder.Configuration, builder.Environment.ContentRootPath);
if (webFiles is not null)
{
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = webFiles });
    var types = new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider();
    types.Mappings[".webmanifest"] = "application/manifest+json";
    app.UseStaticFiles(new StaticFileOptions { FileProvider = webFiles, ContentTypeProvider = types });
}
app.UseRouting();
// Requesters only reach endpoints marked AllowRequesters(); everything else, including new endpoints, is owner-only.
app.UseMiddleware<RequesterAuthorizationMiddleware>();

// Streaming is off by default (see EngineOptions.Streaming); its routes answer 404 so the SPA can tell it apart.
string[] streamingRoutes = ["/api/stream", "/api/playback", "/api/prewarm", "/api/subtitles"];
app.Use(async (context, next) =>
{
    var path = context.Request.Path;
    if (!context.RequestServices.GetRequiredService<Microsoft.Extensions.Options.IOptionsMonitor<EngineOptions>>().CurrentValue.Streaming
        && streamingRoutes.Any(r => path.StartsWithSegments(r, StringComparison.OrdinalIgnoreCase)))
    {
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        await context.Response.WriteAsJsonAsync(new { error = "Streaming is turned off.", streamingDisabled = true });
        return;
    }
    await next();
});
app.MapGet("/api/features", (Microsoft.Extensions.Options.IOptionsMonitor<EngineOptions> engine,
    TorrentFlow.Engine.Settings.ClientSettingsStore settings, IConfiguration configuration, HttpContext http) =>
{
    http.Response.Headers.CacheControl = "no-store";
    // Streaming routes are refused on the tunnel, so the SPA must hide playback there too.
    return Results.Json(new
    {
        streaming = engine.CurrentValue.Streaming && !RemoteAccessClaims.IsTunnel(http),
        runningInContainer = settings.RunningInContainer,
        openFolder = !settings.RunningInContainer && !RemoteAccessClaims.IsTunnel(http),
        displayPathMappings = configuration.GetSection("TorrentFlow:DisplayPathMappings").GetChildren()
            .Select(m => new { containerPath = m["ContainerPath"], hostPath = m["HostPath"] })
            .Where(m => !string.IsNullOrWhiteSpace(m.containerPath) && !string.IsNullOrWhiteSpace(m.hostPath))
            .ToArray(),
    });
}).AllowRequesters();
app.MapRemoteAccessEndpoints();
app.MapRequestEndpoints();

// Renamed pages keep their old bookmarks working with a permanent (308) redirect, as the Next pages did.
app.MapGet("/activity", () => Results.Redirect("/notifications", permanent: true, preserveMethod: true));
app.MapGet("/client", () => Results.Redirect("/downloads", permanent: true, preserveMethod: true));

app.MapGet("/api/health", async (TorrentFlowDbContext db, HttpContext http, CancellationToken ct) =>
{
    var started = System.Diagnostics.Stopwatch.StartNew();
    bool ready;
    try
    {
        // The newest required table, not SELECT 1: that succeeds before migrations while the app does not.
        await db.MediaRequests.Select(t => t.Id).FirstOrDefaultAsync(ct);
        ready = true;
    }
    catch (Exception) when (!ct.IsCancellationRequested)
    {
        ready = false;
    }
    var latencyMs = Math.Clamp((int)Math.Round(started.Elapsed.TotalMilliseconds), 0, 30_000);
    http.Response.Headers.CacheControl = "no-store";
    var uptime = DateTime.UtcNow - System.Diagnostics.Process.GetCurrentProcess().StartTime.ToUniversalTime();
    return Results.Json(new
    {
        status = ready ? "ok" : "degraded",
        live = true,
        ready,
        timestamp = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture),
        process = new { status = "up", uptimeSeconds = Math.Max(0, (long)uptime.TotalSeconds) },
        build = new { id = typeof(Program).Assembly.GetName().Version?.ToString() ?? "dev" },
        database = new { status = ready ? "up" : "down", latencyMs },
    }, statusCode: ready ? 200 : 503);
}).AllowRequesters();
app.MapControllers();


// Missing hashed chunks (stale tab after an update, or wrong casing on case-sensitive file systems) must
// 404 rather than return index.html, which the browser would reject as a script with the wrong MIME type.
if (webFiles is not null)
    app.MapFallbackToFile("{**path:regex(^(?!api/|assets/).*$)}", "index.html", new StaticFileOptions { FileProvider = webFiles }).AllowRequesters();

var launchBrowser = isPublishedBundle && !Debugger.IsAttached && !args.Any(a => string.Equals(a, "--no-browser", StringComparison.OrdinalIgnoreCase));
if (launchBrowser)
{
    var browserUrl = GetBrowserUrl(configuredUrls, aspNetCoreUrls, defaultUrl);
    app.Lifetime.ApplicationStarted.Register(() => OpenBrowser(browserUrl));
}
if (remoteAccess.Startup.Enabled)
{
    // Kestrel:Endpoints config overrides UseUrls; report the tunnel as down instead of trusting what was requested.
    app.Lifetime.ApplicationStarted.Register(() =>
    {
        var addresses = app.Services.GetRequiredService<Microsoft.AspNetCore.Hosting.Server.IServer>()
            .Features.Get<Microsoft.AspNetCore.Hosting.Server.Features.IServerAddressesFeature>()?.Addresses;
        if (addresses is null || addresses.Count == 0) return;
        var port = remoteAccess.Startup.TunnelPort;
        remoteAccess.TunnelBound = addresses.Any(a => RemoteAccessRules.ParseOwnerPorts(a).Contains(port));
        if (remoteAccess.TunnelBound == false)
            app.Logger.LogError("Remote access is on but the tunnel port {Port} is not among the bound addresses ({Addresses}). Remove the Kestrel:Endpoints override or add {TunnelUrl} to it.",
                port, string.Join(", ", addresses), remoteAccess.Startup.TunnelUrl);
    });
}

app.Run();

static IFileProvider? ResolveWebRootFileProvider(IConfiguration configuration, string contentRoot)
{
    var configured = configuration["TorrentFlow:WebRoot"];
    if (!string.IsNullOrWhiteSpace(configured))
        return Directory.Exists(configured) ? new PhysicalFileProvider(Path.GetFullPath(configured)) : null;

    var candidates = new[]
    {
        Path.Combine(AppContext.BaseDirectory, "wwwroot"),
        Path.Combine(contentRoot, "web", "dist"),
        Path.GetFullPath(Path.Combine(contentRoot, "..", "..", "web", "dist")),
    };

    foreach (var candidate in candidates)
    {
        if (File.Exists(Path.Combine(candidate, "index.html")))
            return new PhysicalFileProvider(Path.GetFullPath(candidate));
    }

    // Only single-file publishes embed the SPA; other builds have no manifest and the provider would throw.
    var assembly = typeof(Program).Assembly;
    if (assembly.GetManifestResourceInfo("Microsoft.Extensions.FileProviders.Embedded.Manifest.xml") is null)
        return null;
    var embedded = new ManifestEmbeddedFileProvider(assembly, "wwwroot");
    return embedded.GetFileInfo("index.html").Exists ? embedded : null;
}

static string GetBrowserUrl(string? configuredUrls, string? aspNetCoreUrls, string defaultUrl)
{
    var raw = !string.IsNullOrWhiteSpace(configuredUrls) ? configuredUrls
        : !string.IsNullOrWhiteSpace(aspNetCoreUrls) ? aspNetCoreUrls
        : defaultUrl;
    return raw.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault() ?? defaultUrl;
}

static void OpenBrowser(string url)
{
    try
    {
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"TorrentFlow started, but could not open the browser automatically: {ex.Message}");
    }
}

static bool IsPublishedBundle()
{
#pragma warning disable IL3000
    return string.IsNullOrEmpty(typeof(Program).Assembly.Location);
#pragma warning restore IL3000
}

static bool IsPortAvailable(IPAddress address, int port)
{
    try
    {
        var listener = new TcpListener(address, port);
        listener.Start();
        listener.Stop();
        return true;
    }
    catch (SocketException)
    {
        return false;
    }
}

static void ExitWithMessage(string message)
{
    Console.Error.WriteLine(message);
    Environment.ExitCode = 1;
    // A double-clicked exe closes its console on exit; keep the message readable.
    if (!Console.IsInputRedirected)
    {
        Console.Error.WriteLine("Press any key to close.");
        Console.ReadKey(intercept: true);
    }
}

static IReadOnlyList<int> OwnerPorts(string urls) => RemoteAccessRules.ParseOwnerPorts(urls);

public partial class Program;
