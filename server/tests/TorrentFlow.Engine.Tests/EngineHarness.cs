using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Settings;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine.Tests;

internal sealed class StaticOptionsMonitor<T>(T value) : IOptionsMonitor<T>
{
    public T CurrentValue { get; } = value;
    public T Get(string? name) => CurrentValue;
    public IDisposable? OnChange(Action<T, string?> listener) => null;
}

/// <summary>HTTP factory that fails closed so real-engine tests never hit the network by accident.</summary>
internal sealed class NoHttpFactory : IHttpClientFactory
{
    public HttpClient CreateClient(string name) => new(new FailingHandler(), disposeHandler: true);

    private sealed class FailingHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            throw new HttpRequestException("no network in engine tests");
    }
}

/// <summary>
/// Real temp directory + migrated SQLite for MonoTorrent/disk tests.
/// No fake ITorrentBackend — callers wire a real MonoTorrentBackend.
/// </summary>
internal sealed class EngineRoot : IAsyncDisposable
{
    public string Root { get; }
    public ServiceProvider Services { get; }
    public IDbContextFactory<TorrentFlowDbContext> Db { get; }
    public EngineOptions Options { get; }
    public StorageBudget Storage { get; }

    private EngineRoot(string root, ServiceProvider services, EngineOptions options)
    {
        Root = root;
        Services = services;
        Options = options;
        Db = services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();
        Storage = new StorageBudget(TimeProvider.System) { FreeBytesProvider = _ => 10L << 40 };
    }

    public static string NewRoot()
    {
        var root = Path.Combine(AppContext.BaseDirectory, "testdata", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    public static async Task<EngineRoot> CreateAsync(int cap = 2, long? maxStorageBytes = 1L << 40)
    {
        var root = NewRoot();
        var services = new ServiceCollection()
            .AddLogging(b => b.SetMinimumLevel(LogLevel.Warning))
            .AddTorrentFlowData($"Data Source={Path.Combine(root, "test.db")};Pooling=False")
            .BuildServiceProvider();
        await services.GetRequiredService<DatabaseInitializer>().InitializeAsync();
        var options = new EngineOptions { MaxActiveDownloads = cap, DataDirectory = root, MetadataTimeoutSeconds = 5, Streaming = true };
        var h = new EngineRoot(root, services, options);
        await using var db = await h.Db.CreateDbContextAsync();
        var settings = await new ClientSettingsStore(h.Db).EnsureAsync(db);
        settings.BaseDownloadPath = Path.Combine(root, "downloads");
        settings.MaxStorageBytes = maxStorageBytes;
        settings.StorageCapConfigured = maxStorageBytes is not null;
        foreach (var work in new[] { "show", "other" })
            db.Works.Add(new Work { Id = work, WorkKey = work, CanonicalTitle = work, MediaType = "tv", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync();
        return h;
    }

    public static string Hash(int n) => n.ToString("x40");

    public static string Magnet(int n) => $"magnet:?xt=urn:btih:{Hash(n)}&dn=item{n}";

    public async Task<List<EngineTorrent>> RowsAsync()
    {
        await using var db = await Db.CreateDbContextAsync();
        return await db.EngineTorrents.AsNoTracking().OrderBy(r => r.CreatedAt).ToListAsync();
    }

    public async ValueTask DisposeAsync()
    {
        await Services.DisposeAsync();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try { Directory.Delete(Root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

/// <summary>Legacy name used by remaining disk helpers (Hash/Magnet/NewRoot).</summary>
internal static class EngineHarness
{
    public static string NewRoot() => EngineRoot.NewRoot();
    public static string Hash(int n) => EngineRoot.Hash(n);
    public static string Magnet(int n) => EngineRoot.Magnet(n);
}
