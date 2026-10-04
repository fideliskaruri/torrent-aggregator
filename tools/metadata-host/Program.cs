using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;
using TorrentFlow.Metadata;
using TorrentFlow.Store;
var builder = WebApplication.CreateBuilder(args);
var data = builder.Configuration["DataDirectory"] ?? @"D:\code\memtest\rebuild-dev\data";
Directory.CreateDirectory(data);
builder.Services.AddStore(Path.Combine(data, "metadata-bench.db"));
builder.Services.AddMetadata(data);
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter()));
builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(o => o.SingleLine = true);
builder.Logging.SetMinimumLevel(LogLevel.Warning);
var app = builder.Build();
await using (var scope = app.Services.CreateAsyncScope())
    await scope.ServiceProvider.GetRequiredService<StoreDatabase>().InitializeAsync(null, true);
app.MapPost("/resolve", (MetadataQuery query, IMetadata metadata, CancellationToken ct) => metadata.ResolveAsync(query, ct));
app.MapGet("/health", () => new { ok = true, pid = Environment.ProcessId });
app.MapGet("/proof/tmdb/{kind}/{id}", async (string kind, string id, TorrentFlowDbContext db, CancellationToken ct) =>
{
    var rows = await db.MetadataCaches.AsNoTracking().Where(row => row.Provider == "tmdb")
        .OrderBy(row => row.Id).ToListAsync(ct);
    var prefix = "/" + kind + "/" + id;
    return rows.Select(row => new
    {
        path = row.CacheKey[(row.CacheKey.IndexOf(':', 5) + 1)..],
        row.FetchedAt, row.Complete, row.Payload,
    }).Where(row => row.path.StartsWith(prefix + "?", StringComparison.Ordinal) ||
        row.path.StartsWith(prefix + "/season/", StringComparison.Ordinal));
});
app.MapGet("/work/{id}", (string id, bool? refresh, IMetadata metadata, CancellationToken ct) =>
    metadata.GetWorkAsync(id, refresh ?? false, ct));
app.MapPost("/search", (CatalogQuery query, IMetadata metadata, CancellationToken ct) => metadata.SearchAsync(query, ct));
app.MapPost("/browse", (BrowseQuery query, IMetadata metadata, CancellationToken ct) => metadata.BrowseAsync(query, ct));
app.MapPost("/extras", (MetadataQuery query, IMetadata metadata, CancellationToken ct) => metadata.ExtrasAsync(query, null, ct));
app.MapPost("/links", (LinkCommand query, IMetadata metadata, CancellationToken ct) => metadata.ChangeLinkAsync(query, ct));
app.MapPost("/recommend", (string[] seeds, IMetadata metadata, CancellationToken ct) =>
    metadata.RecommendAsync([.. seeds], ct));
await app.RunAsync("http://127.0.0.1:3940");
