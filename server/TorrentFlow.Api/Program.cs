using Microsoft.EntityFrameworkCore;
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

// Local single-user app: listen on loopback only unless the owner overrides --urls.
if (string.IsNullOrEmpty(builder.Configuration["urls"]) && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ASPNETCORE_URLS")))
    builder.WebHost.UseUrls("http://127.0.0.1:3000");

var dataDir = builder.Configuration["TorrentFlow:DataDirectory"] ?? Path.Combine(builder.Environment.ContentRootPath, "data");
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
var contentRoot = builder.Environment.ContentRootPath;
var webRoot = builder.Configuration["TorrentFlow:WebRoot"]
    ?? new[]
    {
        Path.Combine(AppContext.BaseDirectory, "wwwroot"),
        Path.Combine(contentRoot, "web", "dist"),
        Path.Combine(contentRoot, "..", "..", "web", "dist"),
    }.Select(Path.GetFullPath).FirstOrDefault(p => File.Exists(Path.Combine(p, "index.html")))
    ?? Path.GetFullPath(Path.Combine(contentRoot, "..", "..", "web", "dist"));
Microsoft.Extensions.FileProviders.PhysicalFileProvider? webFiles = Directory.Exists(webRoot) ? new(webRoot) : null;
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

app.Run();

public partial class Program;
