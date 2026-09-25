using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.FileProviders;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Data;
using TorrentFlow.Engine;
using TorrentFlow.Library;
using TorrentFlow.Media;
using TorrentFlow.Metadata;
using TorrentFlow.Search;

// Culture-neutral formatting everywhere (numbers in headers, ffmpeg args, logs), whatever the machine locale is.
System.Globalization.CultureInfo.DefaultThreadCurrentCulture = System.Globalization.CultureInfo.InvariantCulture;
System.Globalization.CultureInfo.DefaultThreadCurrentUICulture = System.Globalization.CultureInfo.InvariantCulture;

var builder = WebApplication.CreateBuilder(args);
var isPublishedBundle = IsPublishedBundle();

// Local single-user app: listen on loopback only unless the owner overrides --urls.
var configuredUrls = builder.Configuration["urls"];
var aspNetCoreUrls = Environment.GetEnvironmentVariable("ASPNETCORE_URLS");
var defaultUrl = "http://127.0.0.1:3000";
if (string.IsNullOrWhiteSpace(configuredUrls) && string.IsNullOrWhiteSpace(aspNetCoreUrls))
    builder.WebHost.UseUrls(defaultUrl);

if (isPublishedBundle && string.IsNullOrWhiteSpace(configuredUrls) && string.IsNullOrWhiteSpace(aspNetCoreUrls))
{
    if (!IsLoopbackPortAvailable(3000))
    {
        Console.Error.WriteLine("TorrentFlow could not start because http://127.0.0.1:3000 is already in use. Close the other app or launch TorrentFlow with --urls <address>.");
        Environment.ExitCode = 1;
        return;
    }
}

var dataDir = ResolveDataDirectory(builder.Configuration, builder.Environment);
Directory.CreateDirectory(dataDir);
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

var app = builder.Build();
await app.Services.GetRequiredService<DatabaseInitializer>().InitializeAsync();

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
        await db.AcquisitionTargets.Select(t => t.Id).FirstOrDefaultAsync(ct);
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
});
app.MapControllers();


// Missing hashed chunks (stale tab after an update, or wrong casing on case-sensitive file systems) must
// 404 rather than return index.html, which the browser would reject as a script with the wrong MIME type.
if (webFiles is not null)
    app.MapFallbackToFile("{**path:regex(^(?!api/|assets/).*$)}", "index.html", new StaticFileOptions { FileProvider = webFiles });

var launchBrowser = isPublishedBundle && !Debugger.IsAttached && !args.Any(a => string.Equals(a, "--no-browser", StringComparison.OrdinalIgnoreCase));
if (launchBrowser)
{
    var browserUrl = GetBrowserUrl(configuredUrls, aspNetCoreUrls, defaultUrl);
    app.Lifetime.ApplicationStarted.Register(() => OpenBrowser(browserUrl));
}

app.Run();

static string ResolveDataDirectory(IConfiguration configuration, IHostEnvironment environment)
{
    var configured = configuration["TorrentFlow:DataDirectory"];
    if (!string.IsNullOrWhiteSpace(configured))
        return Path.GetFullPath(configured);

    if (!IsPublishedBundle())
        return Path.Combine(environment.ContentRootPath, "data");

    var exeDirectory = Path.GetDirectoryName(Environment.ProcessPath ?? AppContext.BaseDirectory) ?? AppContext.BaseDirectory;
    if (File.Exists(Path.Combine(exeDirectory, "portable")))
        return Path.Combine(exeDirectory, "data");

    var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    return string.IsNullOrWhiteSpace(localAppData)
        ? Path.Combine(exeDirectory, "data")
        : Path.Combine(localAppData, "TorrentFlow");
}

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

    var assembly = typeof(Program).Assembly;
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

static bool IsLoopbackPortAvailable(int port)
{
    try
    {
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        listener.Stop();
        return true;
    }
    catch (SocketException)
    {
        return false;
    }
}

public partial class Program;
