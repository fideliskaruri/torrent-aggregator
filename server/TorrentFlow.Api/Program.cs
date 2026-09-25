using Microsoft.EntityFrameworkCore;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Data;
using TorrentFlow.Engine;
using TorrentFlow.Library;
using TorrentFlow.Media;
using TorrentFlow.Metadata;
using TorrentFlow.Search;

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

// The React SPA (web/) builds into web/dist; serve it with history-API fallback for client routes.
var webRoot = builder.Configuration["TorrentFlow:WebRoot"]
    ?? Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "..", "..", "web", "dist"));
if (Directory.Exists(webRoot))
{
    var files = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(webRoot);
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
    app.UseStaticFiles(new StaticFileOptions { FileProvider = files });
    app.MapFallbackToFile("{**path:regex(^(?!api/).*$)}", "index.html", new StaticFileOptions { FileProvider = files });
}

app.Run();

public partial class Program;
