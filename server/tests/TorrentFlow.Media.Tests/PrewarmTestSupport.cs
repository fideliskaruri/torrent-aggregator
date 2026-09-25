using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Media.Features.Prewarm;

namespace TorrentFlow.Media.Tests;

/// <summary>A clock tests move by hand.</summary>
internal sealed class ManualTime(DateTimeOffset? start = null) : TimeProvider
{
    public DateTimeOffset Now { get; set; } = start ?? DateTimeOffset.UtcNow;
    public override DateTimeOffset GetUtcNow() => Now;
    public void Advance(TimeSpan by) => Now += by;
}

/// <summary>An in-memory ITorrentEngine: no swarm, no disk. Records every call.</summary>
internal sealed class FakeEngine : ITorrentEngine
{
    public readonly List<EngineTorrentInfo> Torrents = [];
    public readonly List<EngineAddRequest> Adds = [];
    public readonly List<string> Removed = [];
    public readonly List<string> Deselected = [];
    public IDbContextFactory<TorrentFlowDbContext>? Db { get; set; }
    /// <summary>Returns the add result; null = accept and stamp an origin=prewarm row.</summary>
    public Func<EngineAddRequest, EngineAddResult?>? OnAdd { get; set; }
    public Func<string, EngineActionResult>? OnSelect { get; set; }
    public Func<Exception>? ListThrows { get; set; }

    public event EventHandler<EngineTorrentCompletedEventArgs>? TorrentCompleted { add { } remove { } }

    public async Task<EngineAddResult> AddAsync(EngineAddRequest request, CancellationToken ct = default)
    {
        Adds.Add(request);
        if (OnAdd?.Invoke(request) is { } custom) return custom;
        var hash = ReleaseText.InfoHashFromMagnet(request.Magnet) ?? "0".PadLeft(40, '0');
        if (Db is not null)
        {
            await using var db = await Db.CreateDbContextAsync(ct);
            if (!await db.EngineTorrents.AnyAsync(t => t.Hash == hash, ct))
            {
                var now = DateTime.UtcNow;
                db.EngineTorrents.Add(new EngineTorrent
                {
                    Id = Ids.New(), UserId = LocalUser.Id, Hash = hash, Name = request.Name ?? hash, Magnet = request.Magnet,
                    Status = "downloading", Origin = TorrentOrigin.FromPurpose(request.Purpose), SizeBytes = request.ExpectedSizeBytes ?? 0,
                    CreatedAt = now, UpdatedAt = now, LastUsedAt = now,
                });
                await db.SaveChangesAsync(ct);
            }
        }
        return new EngineAddResult(true, $"Added {request.Name}", new EngineAddDetails(EngineAddDetails.Started, 0, 0), hash);
    }

    public Task<IReadOnlyList<EngineTorrentInfo>> ListAsync(CancellationToken ct = default) =>
        ListThrows is { } t ? throw t() : Task.FromResult<IReadOnlyList<EngineTorrentInfo>>([.. Torrents]);

    public Task<EngineTorrentInfo?> GetAsync(string infoHash, CancellationToken ct = default) =>
        Task.FromResult(Torrents.FirstOrDefault(t => t.Hash == infoHash));

    public Task<EngineActionResult> PauseAsync(string infoHash, CancellationToken ct = default) => Task.FromResult(new EngineActionResult(true, "paused"));
    public Task<EngineActionResult> ResumeAsync(string infoHash, CancellationToken ct = default) => Task.FromResult(new EngineActionResult(true, "resumed"));
    public Task<EngineActionResult> ForceAsync(string infoHash, CancellationToken ct = default) => Task.FromResult(new EngineActionResult(true, "forced"));

    public async Task<EngineActionResult> RemoveAsync(string infoHash, bool deleteFiles, CancellationToken ct = default)
    {
        Removed.Add(infoHash);
        Torrents.RemoveAll(t => t.Hash == infoHash);
        if (Db is not null)
        {
            await using var db = await Db.CreateDbContextAsync(ct);
            await db.EngineTorrents.Where(t => t.Hash == infoHash).ExecuteDeleteAsync(ct);
        }
        return new EngineActionResult(true, "removed");
    }

    public Task<EngineActionResult> SelectFilesAsync(string infoHash, IReadOnlyCollection<int> fileIndices, CancellationToken ct = default)
    {
        if (OnSelect?.Invoke(infoHash) is { } r) return Task.FromResult(r);
        if (Torrents.All(t => t.Hash != infoHash)) return Task.FromResult(new EngineActionResult(false, "not found"));
        Deselected.Add(infoHash);
        return Task.FromResult(new EngineActionResult(true, "selected"));
    }

    public Task<Stream> OpenFileStreamAsync(string infoHash, string fileIndexOrPath, CancellationToken ct = default) => throw new NotSupportedException();
    public Task<long> QueuedReservedBytesAsync(CancellationToken ct = default) => Task.FromResult(0L);

    public void Live(string hash, long dlspeed = 0, string state = "downloading", double progress = 0.1, long size = 1000, int peers = 3) =>
        Torrents.Add(new EngineTorrentInfo { Hash = hash, Name = hash, State = state, Dlspeed = dlspeed, Progress = progress, SizeBytes = size, Peers = peers });
}

/// <summary>A search service that answers from a fixed pool and counts calls. No indexers.</summary>
internal sealed class FakeSearch : ITorrentSearchService
{
    public readonly List<SearchOptions> Calls = [];
    public Func<SearchOptions, SearchResponse>? Respond { get; set; }

    public Task<SearchResponse> SearchAsync(SearchOptions options, CancellationToken cancellationToken = default)
    {
        Calls.Add(options);
        return Task.FromResult(Respond?.Invoke(options) ?? new SearchResponse { Query = options.Query });
    }
}

internal sealed class NoSwarm : ISwarmProbeEngine
{
    public Task<SwarmLiveState> FindLiveAsync(string infoHash, CancellationToken cancellationToken) => Task.FromResult(new SwarmLiveState("absent"));
    public Task<IIsolatedSwarmProbe> OpenIsolatedAsync(string magnet, CancellationToken cancellationToken) => throw new InvalidOperationException("no swarm in tests");
}

/// <summary>A real migrated SQLite database plus the pre-warm services over fakes.</summary>
internal sealed class PrewarmHarness : IAsyncDisposable
{
    public string Root { get; }
    public ServiceProvider Services { get; }
    public IDbContextFactory<TorrentFlowDbContext> Db { get; }
    public FakeEngine Engine { get; } = new();
    public FakeSearch Search { get; } = new();
    public ManualTime Time { get; } = new();
    public ForegroundTracker Foreground { get; }
    public PrewarmEviction Eviction { get; }
    public SwarmMeasurements Swarm { get; }
    public PreRanker Ranker { get; }
    public PreProber Prober { get; }
    public PrewarmService Prewarm { get; }

    private PrewarmHarness(string root, ServiceProvider services)
    {
        Root = root;
        Services = services;
        Db = services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();
        Engine.Db = Db;
        Foreground = new ForegroundTracker(Db, Engine, Time);
        Eviction = new PrewarmEviction(Db, Engine, Time);
        Swarm = new SwarmMeasurements(new NoSwarm(), Db);
        Ranker = new PreRanker(Search, Db, Swarm, Time);
        Prober = new PreProber(Db, Ranker, Swarm, new NoSwarm(), Foreground);
        Prewarm = new PrewarmService(Db, Engine, Search, Ranker, Eviction, Foreground, Time);
    }

    public static string NewRoot()
    {
        var root = Path.Combine(AppContext.BaseDirectory, "testdata", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    public static async Task<PrewarmHarness> CreateAsync()
    {
        var root = NewRoot();
        var services = new ServiceCollection()
            .AddLogging(b => b.SetMinimumLevel(LogLevel.Warning))
            .AddTorrentFlowData($"Data Source={Path.Combine(root, "test.db")};Pooling=False")
            .BuildServiceProvider();
        await services.GetRequiredService<DatabaseInitializer>().InitializeAsync();
        return new PrewarmHarness(root, services);
    }

    public static string Hash(int n) => n.ToString("x40");
    public static string Magnet(int n, string? name = null) => $"magnet:?xt=urn:btih:{Hash(n)}&dn={Uri.EscapeDataString(name ?? "item" + n)}";

    public async Task<EngineTorrent> SeedTorrentAsync(int n, string origin, string name = "", long size = 1000, double progress = 1,
        string status = "downloading", DateTime? lastUsedAt = null, string? savePath = null, string? verifiedFilesJson = null)
    {
        await using var db = await Db.CreateDbContextAsync();
        var now = Time.GetUtcNow().UtcDateTime;
        var row = new EngineTorrent
        {
            Id = Ids.New(), UserId = LocalUser.Id, Hash = Hash(n), Name = name.Length > 0 ? name : "n" + n, Magnet = Magnet(n),
            Status = status, Origin = origin, SizeBytes = size, Progress = progress, CreatedAt = now, UpdatedAt = now,
            LastUsedAt = lastUsedAt ?? now, SavePath = savePath, VerifiedFilesJson = verifiedFilesJson,
        };
        db.EngineTorrents.Add(row);
        await db.SaveChangesAsync();
        return row;
    }

    public async Task<List<EngineTorrent>> RowsAsync()
    {
        await using var db = await Db.CreateDbContextAsync();
        return await db.EngineTorrents.AsNoTracking().ToListAsync();
    }

    public async Task<WatchListItem> SeedItemAsync(string title, string mediaType = "tv", bool monitored = true, int? cursorSeason = null,
        int? cursorEpisode = null, string status = "watching")
    {
        await using var db = await Db.CreateDbContextAsync();
        var now = Time.GetUtcNow().UtcDateTime;
        var item = new WatchListItem
        {
            Id = Ids.New(), UserId = LocalUser.Id, MediaType = mediaType, ExternalId = Guid.NewGuid().ToString("N"), Title = title,
            Status = status, Monitored = monitored, LastChecked = now, CursorSeason = cursorSeason, CursorEpisode = cursorEpisode,
            MonitorMode = "future", CreatedAt = now, UpdatedAt = now,
        };
        db.WatchListItems.Add(item);
        await db.SaveChangesAsync();
        return item;
    }

    public static TorrentResult Result(string title, int n, int seeders = 10, long? size = 1_000_000_000, bool magnet = true) => new()
    {
        Id = $"r{n}",
        Title = title,
        Magnet = magnet ? Magnet(n, title) : null,
        InfoHash = Hash(n),
        Seeders = seeders,
        SizeBytes = size,
        Source = "test",
        SourceUrl = "https://example.invalid/" + n,
    };

    public async ValueTask DisposeAsync()
    {
        await Services.DisposeAsync();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try { Directory.Delete(Root, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}
