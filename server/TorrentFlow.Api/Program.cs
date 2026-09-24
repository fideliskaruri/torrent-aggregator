using TorrentFlow.Data;

var builder = WebApplication.CreateBuilder(args);
var dbPath = builder.Configuration["TorrentFlow:DatabasePath"] ?? Path.Combine(AppContext.BaseDirectory, "torrentflow.db");
builder.Services.AddTorrentFlowData($"Data Source={dbPath}");

var app = builder.Build();
await app.Services.GetRequiredService<DatabaseInitializer>().InitializeAsync();
app.MapGet("/api/health", () => Results.Ok(new { ok = true }));
app.Run();

public partial class Program;
