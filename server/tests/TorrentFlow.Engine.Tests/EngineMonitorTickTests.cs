using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Engine.Tests;

/// <summary>The monitor tick's database cost: nothing when idle, and no writes for rows that did not change.</summary>
public class EngineMonitorTickTests
{
    private sealed class CountingDbFactory : IDbContextFactory<TorrentFlowDbContext>
    {
        private readonly DbContextOptions<TorrentFlowDbContext> _options;
        public int Commands;
        public int EngineTorrentUpdates;

        public CountingDbFactory(string root) => _options = new DbContextOptionsBuilder<TorrentFlowDbContext>()
            .UseSqlite($"Data Source={Path.Combine(root, "test.db")};Pooling=False")
            .AddInterceptors(new Counter(this))
            .Options;

        public TorrentFlowDbContext CreateDbContext() => new(_options);

        private sealed class Counter(CountingDbFactory owner) : DbCommandInterceptor
        {
            private void Count(DbCommand command)
            {
                Interlocked.Increment(ref owner.Commands);
                if (command.CommandText.Contains("UPDATE \"EngineTorrent\"", StringComparison.Ordinal))
                    Interlocked.Increment(ref owner.EngineTorrentUpdates);
            }

            public override InterceptionResult<DbDataReader> ReaderExecuting(DbCommand c, CommandEventData e, InterceptionResult<DbDataReader> r)
            { Count(c); return r; }
            public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand c, CommandEventData e, InterceptionResult<DbDataReader> r, CancellationToken ct = default)
            { Count(c); return ValueTask.FromResult(r); }
            public override InterceptionResult<int> NonQueryExecuting(DbCommand c, CommandEventData e, InterceptionResult<int> r)
            { Count(c); return r; }
            public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand c, CommandEventData e, InterceptionResult<int> r, CancellationToken ct = default)
            { Count(c); return ValueTask.FromResult(r); }
            public override InterceptionResult<object> ScalarExecuting(DbCommand c, CommandEventData e, InterceptionResult<object> r)
            { Count(c); return r; }
            public override ValueTask<InterceptionResult<object>> ScalarExecutingAsync(DbCommand c, CommandEventData e, InterceptionResult<object> r, CancellationToken ct = default)
            { Count(c); return ValueTask.FromResult(r); }
        }
    }

    private static (TorrentEngineService Engine, CountingDbFactory Db) CountingEngine(EngineHarness h)
    {
        var db = new CountingDbFactory(h.Root);
        var engine = new TorrentEngineService(db, h.Backend, new StaticOptionsMonitor<EngineOptions>(h.Options), new ClientSettingsStore(db),
            h.Storage, new NoHttpFactory(), TimeProvider.System, NullLogger<TorrentEngineService>.Instance);
        return (engine, db);
    }

    private static EngineAddRequest Keep(int n) => new() { Magnet = EngineHarness.Magnet(n), Purpose = TorrentPurpose.Keep, WorkId = "show" };

    [Fact]
    public async Task IdleTicksSkipTheDatabaseUntilAnOperationWakesTheMonitor()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        await h.SeedAsync(9, "parked");                  // a finished library row: nothing for the monitor to do
        var (engine, db) = CountingEngine(h);

        await engine.TickAsync();                        // first tick after startup always looks
        Assert.True(db.Commands > 0);
        var afterFirst = db.Commands;
        for (var i = 0; i < 3; i++) await engine.TickAsync();
        Assert.Equal(afterFirst, db.Commands);

        Assert.True((await engine.AddAsync(Keep(1))).Ok);
        var afterAdd = db.Commands;
        await engine.TickAsync();
        Assert.True(db.Commands > afterAdd);             // a live transfer: the monitor reads again

        await engine.RemoveAsync(EngineHarness.Hash(1), deleteFiles: false);
        await engine.TickAsync();                        // woken by the delete; finds nothing and goes idle
        var idle = db.Commands;
        await engine.TickAsync();
        Assert.Equal(idle, db.Commands);
    }

    [Fact]
    public async Task ACompletionStillPromotesTheQueueHead()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        var (engine, _) = CountingEngine(h);
        Assert.True((await engine.AddAsync(Keep(1))).Ok);
        Assert.True((await engine.AddAsync(Keep(2))).Ok);
        Assert.Equal("queued", (await h.RowAsync(2)).Status);

        h.Backend.Complete(EngineHarness.Hash(1));
        await engine.TickAsync();
        Assert.Equal("parked", (await h.RowAsync(1)).Status);
        Assert.Equal("downloading", (await h.RowAsync(2)).Status);
        Assert.True(h.Backend.Contains(EngineHarness.Hash(2)));
    }

    [Fact]
    public async Task AnyLifecycleCallWakesAnIdleMonitor()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        var (engine, _) = CountingEngine(h);
        await engine.TickAsync();                        // idle: empty database
        await h.SeedAsync(1, "queued");                  // written behind the service's back

        await engine.TickAsync();
        Assert.Equal("queued", (await h.RowAsync(1)).Status);
        await engine.PauseAsync(EngineHarness.Hash(42)); // not found, but it still wakes the monitor
        await engine.TickAsync();
        Assert.Equal("downloading", (await h.RowAsync(1)).Status);
        Assert.True(h.Backend.Contains(EngineHarness.Hash(1)));
    }

    [Fact]
    public async Task OnlyChangedRowsAreWritten()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        var (engine, db) = CountingEngine(h);
        Assert.True((await engine.AddAsync(Keep(1))).Ok);
        Assert.True((await engine.AddAsync(Keep(2))).Ok);
        await engine.TickAsync();

        var before = db.EngineTorrentUpdates;
        await engine.TickAsync();                        // nothing moved
        Assert.Equal(before, db.EngineTorrentUpdates);

        h.Backend.Update(EngineHarness.Hash(1), s => s with { Progress = 0.42 });
        await engine.TickAsync();
        Assert.Equal(before + 1, db.EngineTorrentUpdates);
        Assert.Equal(0.42, (await h.RowAsync(1)).Progress, 4);
        Assert.Equal(0, (await h.RowAsync(2)).Progress);
    }
}
