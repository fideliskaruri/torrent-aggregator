using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Settings;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine.Tests;

internal sealed class StaticOptionsMonitor<T>(T value) : IOptionsMonitor<T>
{
    public T CurrentValue { get; } = value;
    public T Get(string? name) => CurrentValue;
    public IDisposable? OnChange(Action<T, string?> listener) => null;
}

internal sealed class NoHttpFactory : IHttpClientFactory
{
    public HttpClient CreateClient(string name) => new(new FailingHandler());
    private sealed class FailingHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            throw new HttpRequestException("no network in unit tests");
    }
}

/// <summary>In-memory torrent client: records what the service loads, so queue behaviour is observable.</summary>
internal sealed class FakeBackend : ITorrentBackend
{
    public readonly ConcurrentDictionary<string, BackendSnapshot> Live = new(StringComparer.OrdinalIgnoreCase);
    public readonly List<string> AddLog = [];
    public Func<BackendAddSpec, BackendAddOutcome?>? AddOverride { get; set; }
    /// <summary>Awaited before an add takes effect: lets a test hold a start mid-flight.</summary>
    public Func<BackendAddSpec, Task>? BeforeAdd { get; set; }
    public Action<string>? OnGet { get; set; }

    public async Task<BackendAddOutcome> AddAsync(BackendAddSpec spec, CancellationToken ct)
    {
        if (BeforeAdd is { } before) await before(spec);
        lock (AddLog) AddLog.Add(spec.Hash);
        if (AddOverride?.Invoke(spec) is { } forced) return forced;
        var snap = Live.GetOrAdd(spec.Hash, h => new BackendSnapshot(h, "name-" + h, 0, 1000, 0, 0, 0, "stalledDL", true, spec.SavePath,
            [new BackendFile(0, "file-" + h + ".mkv", Path.Combine(spec.SavePath, "file-" + h + ".mkv"), 1000, spec.Purpose == "keep", 0)], null));
        return new BackendAddOutcome(true, "", snap);
    }

    public bool Contains(string hash) => Live.ContainsKey(hash);
    public BackendSnapshot? Get(string hash)
    {
        OnGet?.Invoke(hash);
        return Live.TryGetValue(hash, out var s) ? s : null;
    }
    public IReadOnlyList<BackendSnapshot> List() => Live.Values.ToList();
    public Task PauseAsync(string hash) { Update(hash, s => s with { State = "paused" }); return Task.CompletedTask; }
    public Task ResumeAsync(string hash) { Update(hash, s => s with { State = "stalledDL" }); return Task.CompletedTask; }
    public Task RemoveAsync(string hash) { Live.TryRemove(hash, out _); return Task.CompletedTask; }
    public Task SetSelectedFilesAsync(string hash, IReadOnlySet<int>? selected)
    {
        Update(hash, s => s with { Files = s.Files.Select(f => f with { Selected = selected is null || selected.Contains(f.Index) }).ToList() });
        return Task.CompletedTask;
    }
    public Task<Stream> OpenStreamAsync(string hash, int fileIndex, CancellationToken ct) => Task.FromResult<Stream>(new MemoryStream([1, 2, 3]));
    public byte[]? GetMetadata(string hash) => null;

    public void Update(string hash, Func<BackendSnapshot, BackendSnapshot> f)
    {
        if (Live.TryGetValue(hash, out var s)) Live[hash] = f(s);
    }

    /// <summary>Writes the release file at its full size and reports the torrent complete.</summary>
    public void Complete(string hash)
    {
        var s = Live[hash];
        foreach (var file in s.Files)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file.FullPath)!);
            File.WriteAllBytes(file.FullPath, new byte[file.Length]);
        }
        Live[hash] = s with { State = "complete", Progress = 1, Files = s.Files.Select(f => f with { Progress = 1, Selected = true }).ToList(), PieceBitfield = "/w==" };
    }
}

/// <summary>A real migrated SQLite database + engine service over a <see cref="FakeBackend"/>.</summary>
internal sealed class EngineHarness : IAsyncDisposable
{
    public string Root { get; }
    public ServiceProvider Services { get; }
    public IDbContextFactory<TorrentFlowDbContext> Db { get; }
    public FakeBackend Backend { get; } = new();
    public EngineOptions Options { get; }
    public StorageBudget Storage { get; }
    public TorrentEngineService Engine { get; }

    private EngineHarness(string root, ServiceProvider services, EngineOptions options, Layout.CompletedLayoutFinalizer? layout)
    {
        Root = root;
        Services = services;
        Options = options;
        Db = services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();
        Storage = new StorageBudget(TimeProvider.System) { FreeBytesProvider = _ => 10L << 40 };
        Engine = new TorrentEngineService(Db, Backend, new StaticOptionsMonitor<EngineOptions>(options), new ClientSettingsStore(Db), Storage,
            new NoHttpFactory(), TimeProvider.System, NullLogger<TorrentEngineService>.Instance, layout);
    }

    public static string NewRoot()
    {
        var root = Path.Combine(AppContext.BaseDirectory, "testdata", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    public static async Task<EngineHarness> CreateAsync(int cap = 2, long? maxStorageBytes = 1L << 40, Layout.CompletedLayoutFinalizer? layout = null)
    {
        var root = NewRoot();
        var services = new ServiceCollection()
            .AddLogging(b => b.SetMinimumLevel(LogLevel.Warning))
            .AddTorrentFlowData($"Data Source={Path.Combine(root, "test.db")};Pooling=False")
            .BuildServiceProvider();
        await services.GetRequiredService<DatabaseInitializer>().InitializeAsync();
        var options = new EngineOptions { MaxActiveDownloads = cap, DataDirectory = root, MetadataTimeoutSeconds = 5 };
        var h = new EngineHarness(root, services, options, layout);
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

    public async Task<EngineTorrent> RowAsync(int n) => (await RowsAsync()).Single(r => r.Hash == Hash(n));

    /// <summary>Writes a row straight to the database, bypassing the engine (a restart, a crash, a stale queue).</summary>
    public async Task SeedAsync(int n, string status, int? ep = null, string origin = "user", string work = "show", DateTime? updatedAt = null)
    {
        await using var db = await Db.CreateDbContextAsync();
        var now = DateTime.UtcNow;
        db.EngineTorrents.Add(new EngineTorrent
        {
            Id = Data.Ids.New(), UserId = Data.LocalUser.Id, Hash = Hash(n), Name = "n" + n, Magnet = Magnet(n), Status = status, Origin = origin,
            WorkId = work, QueueKey = ep is { } e ? Queue.DownloadQueue.QueueKeyForEpisode(1, e) : null,
            CreatedAt = now, UpdatedAt = updatedAt ?? now, LastUsedAt = now, SavePath = Path.Combine(Root, "downloads"),
        });
        await db.SaveChangesAsync();
    }

    public async ValueTask DisposeAsync()
    {
        await Services.DisposeAsync();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try { Directory.Delete(Root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}
