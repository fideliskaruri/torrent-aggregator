using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Serilog;
using TorrentFlow.Api;
using TorrentFlow.Api.Access;
using TorrentFlow.Api.Catalog;
using TorrentFlow.Api.Requests;
using TorrentFlow.Api.Desktop;
using TorrentFlow.Api.Notifications;
using TorrentFlow.Api.Automation;
using TorrentFlow.Store;

CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.InvariantCulture;
var clock = Stopwatch.StartNew();
var background = args.Any(a => a.Equals("--background", StringComparison.OrdinalIgnoreCase));
var noBrowser = args.Any(a => a.Equals("--no-browser", StringComparison.OrdinalIgnoreCase));
var desktop = DesktopEnvironment.IsPublishedDesktop();
var browserRequested = desktop || args.Any(a => a.Equals("--desktop", StringComparison.OrdinalIgnoreCase));
if (desktop && OperatingSystem.IsWindows()) NativeDialogs.AttachToParentConsole();
var hostArgs = args.Where(a => !new[] { "--background", "--no-browser", "--desktop" }
    .Contains(a, StringComparer.OrdinalIgnoreCase)).ToArray();
var builder = WebApplication.CreateBuilder(hostArgs);
var dataDirectory = HostPaths.DataDirectory(builder.Configuration);
var urls = builder.Configuration["urls"];
if (string.IsNullOrWhiteSpace(urls)) builder.WebHost.UseUrls("http://127.0.0.1:3940");
using var desktopInstance = new DesktopInstance(desktop, dataDirectory,
    (urls ?? "http://127.0.0.1:3940").Split(';')[0], background, noBrowser);
if (!desktopInstance.IsFirst) return;
Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .MinimumLevel.Override("Microsoft.EntityFrameworkCore", Serilog.Events.LogEventLevel.Warning)
    .Enrich.FromLogContext()
    .WriteTo.Console()
    .WriteTo.File(Path.Combine(dataDirectory, "logs", "torrentflow-.log"),
        rollingInterval: RollingInterval.Day, fileSizeLimitBytes: 10 * 1024 * 1024,
        rollOnFileSizeLimit: true, retainedFileCountLimit: 14, shared: true)
    .CreateLogger();
builder.Services.AddSerilog();
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
});
builder.Services.AddStore(Path.Combine(dataDirectory, "torrentflow.db"));
TorrentFlow.Metadata.MetadataModule.AddMetadata(builder.Services, dataDirectory);
builder.Services.AddAccess();
builder.Services.AddNotifications();
builder.Services.AddSources();
builder.Services.AddCatalog();
builder.Services.AddRequests();
builder.Services.AddAutomation();
builder.Services.AddEngine(dataDirectory);
TorrentFlow.Targets.PlanComposition.AddPlanModule(builder.Services);
TorrentFlow.Targets.CheckComposition.AddCheckModule(builder.Services,
    builder.Configuration.GetSection("TorrentFlow:Check").Get<TorrentFlow.Domain.CheckOptions>());
TorrentFlow.Targets.TargetPipeline.AddTargets(builder.Services, builder.Configuration);
builder.Services.AddSingleton<DownloadsApi>();
builder.Services.AddLibrary();
builder.Services.AddLocalFiles();
builder.Services.AddDesktop(new DesktopEnvironment(desktop, desktop ? Environment.ProcessPath : null,
    DesktopEnvironment.CurrentVersion(), dataDirectory, (urls ?? "http://127.0.0.1:3940").Split(';')[0], background));
var app = builder.Build();
try
{
    await using (var scope = app.Services.CreateAsyncScope())
        await scope.ServiceProvider.GetRequiredService<StoreDatabase>().InitializeAsync(null,
            builder.Configuration.GetValue<bool>("TorrentFlow:Scheduler:Disabled"));
    app.Logger.LogInformation("TorrentFlow rebuild data directory: {DataDirectory}", dataDirectory);
    await app.UseAccessAsync();
    app.MapNotifications();
    app.MapActivity();
    await app.Services.GetRequiredService<DesktopSettingsStore>().InitializeAsync();
    app.MapDesktopEndpoints();
    app.MapLocalFiles();
    await app.MapSettingsAsync();
    app.MapCatalog();
    app.MapRequests();
    app.MapAutomation();
    app.MapTargets();
    app.MapDownloads();
    await app.MapLibraryAsync();
    using var files = HostPaths.WebFiles(builder.Configuration, builder.Environment.ContentRootPath);
    // API paths cannot be served from static files, even if a web build accidentally contains an api folder.
    app.UseWhen(context => !context.Request.Path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase), branch =>
    {
        if (files is null) return;
        branch.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
        var types = new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider();
        types.Mappings[".webmanifest"] = "application/manifest+json";
        branch.UseStaticFiles(new StaticFileOptions { FileProvider = files, ContentTypeProvider = types });
    });
    var version = typeof(Program).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? "0.2.0";
    app.MapGet("/api/health", async (StoreDatabase database, HttpContext http, CancellationToken ct) =>
    {
        var started = Stopwatch.StartNew();
        var ready = await database.IsReadyAsync(ct);
        http.Response.Headers.CacheControl = "no-store";
        return Results.Json(new
        {
            status = ready ? "ok" : "degraded", live = true, ready, version,
            uptimeSeconds = (long)clock.Elapsed.TotalSeconds,
            timestamp = DateTimeOffset.UtcNow,
            process = new { status = "up", uptimeSeconds = (long)clock.Elapsed.TotalSeconds },
            build = new { id = version },
            database = new { status = ready ? "up" : "down", ok = ready, latencyMs = started.ElapsedMilliseconds },
        }, statusCode: ready ? 200 : 503);
    });
    app.Map("/api", () => Results.Json(new { error = "not_found", message = "This API route does not exist." }, statusCode: 404));
    app.Map("/api/{**rest}", () => Results.Json(new { error = "not_found", message = "This API route does not exist." }, statusCode: 404));
    app.MapGet("/activity", () => Results.Redirect("/notifications", permanent: true, preserveMethod: true));
    app.MapGet("/client", () => Results.Redirect("/downloads", permanent: true, preserveMethod: true));
    if (files is not null)
        app.MapFallbackToFile("{**path:nonfile:regex(^(?!api(?:/|$)|assets(?:/|$)).*$)}", "index.html",
            new StaticFileOptions { FileProvider = files });
    else app.Logger.LogWarning("Web build is missing. Run pnpm build in web before using the browser.");
    app.Lifetime.ApplicationStarted.Register(() =>
    {
        using var process = Process.GetCurrentProcess();
        app.Logger.LogInformation("Ready in {StartupMs} ms; working set {WorkingSetBytes} bytes",
            clock.ElapsedMilliseconds, process.WorkingSet64);
        if (browserRequested && !background && !noBrowser)
        {
            try { Process.Start(new ProcessStartInfo(app.Urls.First()) { UseShellExecute = true }); }
            catch (Exception ex) { app.Logger.LogWarning(ex, "Could not open the browser. Open the loopback URL manually."); }
        }
    });
    await app.RunAsync();
}
catch (Exception ex)
{
    Log.Fatal(ex, "TorrentFlow rebuild could not start. Check the data directory, port and database, then try again.");
    if (desktop && OperatingSystem.IsWindows())
        NativeDialogs.ShowError($"TorrentFlow could not start:\n\n{ex.Message}\n\nCheck the data directory and port, then try again.");
    throw;
}
finally
{
    await app.DisposeAsync();
    await Log.CloseAndFlushAsync();
}
