using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Library.Tests;

public sealed class LibraryHost : WebApplicationFactory<Program>
{
    private readonly string directory = Path.Combine(AppContext.BaseDirectory, "test-data", Guid.NewGuid().ToString("N"));
    public string DataDirectory => directory;
    public FakeEngine Engine { get; } = new();
    public FakeSearch Search { get; } = new();
    public FakeArtwork Artwork { get; } = new();
    public FakeAnimeLookup Anime { get; } = new();
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        Directory.CreateDirectory(directory);
        builder.UseSetting("TorrentFlow:DatabasePath", Path.Combine(directory, "library.db"));
        builder.UseSetting("TorrentFlow:DataDirectory", directory);
        builder.ConfigureServices(services =>
        {
            services.RemoveAll<IHostedService>();
            services.RemoveAll<IDbContextFactory<TorrentFlowDbContext>>();
            services.RemoveAll<DbContextOptions<TorrentFlowDbContext>>();
            services.RemoveAll<TorrentFlowDbContext>();
            services.AddTorrentFlowData($"Data Source={Path.Combine(directory, "library.db")}");
            services.RemoveAll<ITorrentEngine>();
            services.RemoveAll<ITorrentSearchService>();
            services.RemoveAll<IMetadataResolver>();
            services.RemoveAll<ICatalogLookup>();
            services.AddSingleton<ITorrentEngine>(Engine);
            services.AddSingleton<ITorrentSearchService>(Search);
            services.AddSingleton<IMetadataResolver, FakeMetadata>();
            services.AddSingleton<ICatalogLookup, FakeCatalog>();
            services.Replace(ServiceDescriptor.Singleton<ILibraryArtworkResolver>(Artwork));
            services.Replace(ServiceDescriptor.Singleton<ILibraryAnimeLookup>(Anime));
        });
    }
    public async Task Seed(Action<TorrentFlowDbContext> seed)
    {
        await using var db = await Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        seed(db);
        await db.SaveChangesAsync();
    }
    public async Task Settings() => await Seed(db => db.ClientSettings.Add(new()
    {
        Id = Ids.New(), UserId = LocalUser.Id, ClientType = "builtin", Host = "", BaseDownloadPath = directory,
        MaxStorageBytes = 100000000000, StorageCapConfigured = true, PreferredResolution = 1080,
        DefaultRetentionPolicy = "keep", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow
    }));
    public static WatchListItem Watch(string id = "watch", int episode = 1) => new()
    {
        Id = id, UserId = LocalUser.Id, Title = "Example Show", MediaType = "tv", ExternalId = "example",
        Status = "watching", Monitored = true, MonitorMode = "ongoing", CursorSeason = 1, CursorEpisode = episode,
        CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow, LastChecked = DateTime.UtcNow
    };
    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!disposing) return;
        using (var connection = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={Path.Combine(directory, "library.db")}"))
            Microsoft.Data.Sqlite.SqliteConnection.ClearPool(connection);
        if (Directory.Exists(directory)) Directory.Delete(directory, true);
    }
}

public sealed class FakeSearch : ITorrentSearchService
{
    public Func<SearchOptions, SearchResponse> Respond { get; set; } = options => new() { Query = options.Query };
    public List<SearchOptions> Requests { get; } = [];
    public Task<SearchResponse> SearchAsync(SearchOptions options, CancellationToken cancellationToken = default)
    {
        lock (Requests) Requests.Add(options);
        return Task.FromResult(Respond(options));
    }
    public static TorrentResult Release(string title, int seeders = 50) => new()
    {
        Id = title, Title = title, InfoHash = new string('a', 40), Magnet = $"magnet:?xt=urn:btih:{new string('a', 40)}",
        Source = "nyaa", SourceUrl = "", SizeBytes = 1000000, Seeders = seeders
    };
}
public sealed class FakeEngine : ITorrentEngine
{
    public List<EngineAddRequest> Adds { get; } = [];
    public List<string> Removed { get; } = [];
    public EngineAddResult Result { get; set; } = new(true, "Started", new("started", 0, 0), new string('a', 40));
    public event EventHandler<EngineTorrentCompletedEventArgs>? TorrentCompleted { add { } remove { } }
    public Task<EngineAddResult> AddAsync(EngineAddRequest request, CancellationToken ct = default)
    {
        lock (Adds) Adds.Add(request);
        return Task.FromResult(Result);
    }
    public Task<IReadOnlyList<EngineTorrentInfo>> ListAsync(CancellationToken ct = default) => Task.FromResult<IReadOnlyList<EngineTorrentInfo>>([]);
    public Task<EngineTorrentInfo?> GetAsync(string infoHash, CancellationToken ct = default) => Task.FromResult<EngineTorrentInfo?>(null);
    public Task<EngineActionResult> PauseAsync(string infoHash, CancellationToken ct = default) => Task.FromResult(new EngineActionResult(true, ""));
    public Task<EngineActionResult> ResumeAsync(string infoHash, CancellationToken ct = default) => PauseAsync(infoHash, ct);
    public Task<EngineActionResult> ForceAsync(string infoHash, CancellationToken ct = default) => PauseAsync(infoHash, ct);
    public Task<EngineActionResult> RemoveAsync(string infoHash, bool deleteFiles, CancellationToken ct = default) { Removed.Add(infoHash); return PauseAsync(infoHash, ct); }
    public Task<EngineActionResult> SelectFilesAsync(string infoHash, IReadOnlyCollection<int> fileIndices, CancellationToken ct = default) => PauseAsync(infoHash, ct);
    public Task<Stream> OpenFileStreamAsync(string infoHash, string fileIndexOrPath, CancellationToken ct = default) => throw new NotSupportedException();
    public Task<long> QueuedReservedBytesAsync(CancellationToken ct = default) => Task.FromResult(0L);
}
internal sealed class FakeCatalog : ICatalogLookup
{
    public Task<CatalogWork?> FindByWorkKeyAsync(string workKey, CancellationToken cancellationToken = default) => Task.FromResult<CatalogWork?>(null);
}
internal sealed class FakeMetadata : IMetadataResolver
{
    public Task<MediaMetadata?> ResolveMetadataAsync(string rawTitle, string? category, CancellationToken cancellationToken = default) => Task.FromResult<MediaMetadata?>(null);
    public Task<IReadOnlyList<MediaMetadata?>> EnrichAsync(IReadOnlyList<MetadataEnrichmentInput> inputs, string query, string? category, MediaMetadata? primary = null, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<MediaMetadata?>>(inputs.Select(_ => (MediaMetadata?)null).ToArray());
    public Task<MediaMetadata?> GetAniListByIdAsync(string id, CancellationToken cancellationToken = default) => Task.FromResult<MediaMetadata?>(null);
    public Task<MediaMetadata?> GetTmdbByIdAsync(string mediaType, string id, CancellationToken cancellationToken = default) => Task.FromResult<MediaMetadata?>(null);
}
public sealed class FakeArtwork : ILibraryArtworkResolver
{
    public LibraryArtwork Result { get; set; } = new(null, null);
    public List<string> Requests { get; } = [];
    public Task<LibraryArtwork> ResolveAsync(string title, int? year, string? mediaType, CancellationToken cancellationToken)
    {
        lock (Requests) Requests.Add(title);
        return Task.FromResult(Result);
    }
}
public sealed class FakeAnimeLookup : ILibraryAnimeLookup
{
    public Func<string, IReadOnlyList<MediaMetadata>> Respond { get; set; } = _ => [];
    public Task<IReadOnlyList<MediaMetadata>> SearchAsync(string title, int limit, CancellationToken cancellationToken) => Task.FromResult(Respond(title));
}