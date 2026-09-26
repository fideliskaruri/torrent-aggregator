using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using TorrentFlow.Data;
using TorrentFlow.Library.Features.Automation;

namespace TorrentFlow.Library.Tests;

public sealed class CheckScheduleTests
{
    private static readonly DateTime Now = new(2026, 9, 26, 12, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData(2, 0, 120, "not aired yet")]
    [InlineData(72, 0, 1440, "not aired yet")]
    [InlineData(0, 9, 15, "next check")]
    [InlineData(-11, 9, 15, "next check")]
    [InlineData(-13, 0, 60, "next check")]
    [InlineData(null, 0, 60, "next check")]
    [InlineData(null, 6, 240, "next check")]
    public void AirDateAndFallback(int? airHours, int misses, int expectedMinutes, string reason)
    {
        var next = CheckSchedule.Next(Now, airHours is { } h ? Now.AddHours(h) : null, misses, null, 60, new());
        Assert.Equal(Now.AddMinutes(expectedMinutes), next.At);
        Assert.Equal(reason, next.Reason);
    }

    [Theory]
    [InlineData(0, 15, "waiting for seeders")]
    [InlineData(355, 5, "waiting for seeders")]
    [InlineData(360, 60, "next check")]
    public void SeederWaitStopsAtTimeout(int elapsed, int due, string reason)
    {
        var next = CheckSchedule.Next(Now, null, 0, Now.AddMinutes(-elapsed), 60, new());
        Assert.Equal(Now.AddMinutes(due), next.At);
        Assert.Equal(reason, next.Reason);
    }

    [Theory]
    [InlineData(-1, 1)]
    [InlineData(5, 5)]
    [InlineData(100, 60)]
    public void SchedulerDelayIsBounded(int due, int expected) =>
        Assert.Equal(TimeSpan.FromMinutes(expected), CheckSchedule.Delay(Now, Now.AddMinutes(due), 60));

    [Fact]
    public async Task WakeCoalescesAndCancelsWithoutLeavingReaders()
    {
        var wake = new AutomationWake();
        wake.Wake(); wake.Wake();
        await wake.Wait(TimeSpan.FromHours(1), default).WaitAsync(TimeSpan.FromSeconds(1));
        using var ct = new CancellationTokenSource(50);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => wake.Wait(TimeSpan.FromHours(1), ct.Token));
        await wake.Wait(TimeSpan.FromMilliseconds(1), default);
        var waiting = wake.Wait(TimeSpan.FromHours(1), default);
        wake.Wake();
        await waiting.WaitAsync(TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task FutureAirDateDefersWithoutSearchOrMiss()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        var airDate = DateTime.UtcNow.AddHours(2);
        host.AirDates.Resolve = (_, _) => airDate;
        await host.Seed(db => db.WatchListItems.Add(LibraryHost.Watch()));
        await host.Services.GetRequiredService<AutomationService>().Run(new[] { "watch" }, default);
        Assert.Empty(host.Search.Requests);
        await using var db = await host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        var item = await db.WatchListItems.SingleAsync();
        Assert.InRange(airDate - item.NextCheckAt!.Value, TimeSpan.Zero, TimeSpan.FromMilliseconds(1));
        Assert.Equal("not aired yet", item.NextCheckReason);
        Assert.Equal(0, item.CursorMisses);
        var json = await client.GetFromJsonAsync<JsonElement>("/api/watchlist");
        Assert.Equal("not aired yet", json.GetProperty("items")[0].GetProperty("nextCheckReason").GetString());
        Assert.EndsWith("Z", json.GetProperty("items")[0].GetProperty("nextCheckAt").GetString());
    }

    [Fact]
    public async Task FreshEpisodeDoesNotRollSeasonAndSchedulesDenseCheck()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        host.AirDates.Resolve = (_, _) => DateTime.UtcNow.AddHours(-1);
        await host.Seed(db => { var item = LibraryHost.Watch(episode: 2); item.CursorMisses = 2; db.WatchListItems.Add(item); });
        await host.Services.GetRequiredService<AutomationService>().Run(new[] { "watch" }, default);
        await using var db = await host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        var item = await db.WatchListItems.SingleAsync();
        Assert.Equal(1, item.CursorSeason);
        Assert.Equal(2, item.CursorEpisode);
        Assert.InRange(item.NextCheckAt!.Value - DateTime.UtcNow, TimeSpan.FromMinutes(14), TimeSpan.FromMinutes(16));
    }

    [Fact]
    public async Task SubsetRespectsDueStateAndRunLock()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        await host.Seed(db =>
        {
            db.WatchListItems.Add(LibraryHost.Watch("due"));
            var future = LibraryHost.Watch("future"); future.ExternalId = "future"; future.NextCheckAt = DateTime.UtcNow.AddDays(1);
            db.WatchListItems.Add(future);
            var other = LibraryHost.Watch("other"); other.ExternalId = "other"; db.WatchListItems.Add(other);
            db.RunLocks.Add(new() { Id = "lock", UserId = LocalUser.Id, Scope = "automation", AcquiredAt = DateTime.UtcNow });
        });
        var automation = host.Services.GetRequiredService<AutomationService>();
        await automation.Run(new[] { "due", "future" }, default);
        Assert.Empty(host.Search.Requests);
        await using var db = await host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        await db.RunLocks.ExecuteDeleteAsync();
        await automation.Run(new[] { "due", "future" }, default);
        Assert.Single(host.Search.Requests);
        Assert.Empty(await db.RunLocks.ToListAsync());
    }

    [Theory]
    [InlineData(10, 60, 0, false)]
    [InlineData(10, 60, 61, true)]
    [InlineData(0, 60, 0, true)]
    [InlineData(10, 0, 0, true)]
    public async Task ConfigurableGracePreservesCursorUntilSend(int minimum, int timeout, int waited, bool send)
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        var options = host.Services.GetRequiredService<IOptions<AutomationOptions>>().Value;
        options.MinimumSeeders = minimum; options.SeederWaitTimeoutMinutes = timeout;
        await host.Seed(db => { var item = LibraryHost.Watch(); item.SeederWaitSince = DateTime.UtcNow.AddMinutes(-waited); db.WatchListItems.Add(item); });
        host.Search.Respond = o => new() { Query = o.Query, Results = [FakeSearch.Release("Example Show S01E01 1080p", 5)] };
        await host.Services.GetRequiredService<AutomationService>().Run(default);
        Assert.Equal(send ? 1 : 0, host.Engine.Adds.Count);
        await using var db = await host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        var item = await db.WatchListItems.SingleAsync();
        Assert.Equal(send ? 2 : 1, item.CursorEpisode);
        Assert.Equal(send ? "next check" : "waiting for seeders", item.NextCheckReason);
    }

    [Fact]
    public async Task WatchlistChangeWakesHostedLoopAndChecksOnlyDueRows()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        await host.Seed(db => {
            var item = LibraryHost.Watch(); item.NextCheckAt = DateTime.UtcNow.AddDays(1); db.WatchListItems.Add(item);
            db.ClientSettings.Single().AutomationIntervalMinutes = 60;
        });
        var wake = host.Services.GetRequiredService<AutomationWake>();
        using var scheduler = new AutomationScheduler(host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>(),
            host.Services.GetRequiredService<AutomationService>(), new ConfigurationBuilder().Build(),
            NullLogger<AutomationScheduler>.Instance, wake);
        await scheduler.StartAsync(default);
        try
        {
            var response = await client.PatchAsJsonAsync("/api/watchlist", new { id = "watch", cursorSeason = 1, cursorEpisode = 2 });
            response.EnsureSuccessStatusCode();
            var timeout = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < timeout)
            {
                lock (host.Search.Requests) { if (host.Search.Requests.Count > 0) break; }
                await Task.Delay(20);
            }
            Assert.Single(host.Search.Requests);
            Assert.Contains("S01E02", host.Search.Requests[0].Query);
        }
        finally { await scheduler.StopAsync(default); }
    }

    [Theory]
    [InlineData(false, "watching")]
    [InlineData(true, "completed")]
    public async Task InactiveItemsAreNeverScheduled(bool monitored, string status)
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        await host.Seed(db => { var item = LibraryHost.Watch(); item.Monitored = monitored; item.Status = status; db.WatchListItems.Add(item); });
        await host.Services.GetRequiredService<AutomationService>().Run(new[] { "watch" }, default);
        Assert.Empty(host.Search.Requests);
    }

    [Fact]
    public void ConfigurationBindsAndValidatesTheDocumentedSection()
    {
        var services = new ServiceCollection();
        services.AddLibraryModule(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["TorrentFlow:Library:MinimumSeeders"] = "12",
            ["TorrentFlow:Library:SeederWaitTimeoutMinutes"] = "90",
            ["TorrentFlow:Library:SeederRecheckMinutes"] = "5",
        }).Build());
        using var provider = services.BuildServiceProvider();
        var options = provider.GetRequiredService<IOptions<AutomationOptions>>().Value;
        Assert.Equal(12, options.MinimumSeeders);
        Assert.Equal(90, options.SeederWaitTimeoutMinutes);
        Assert.Equal(5, options.SeederRecheckMinutes);
    }

    [Fact]
    public async Task ManualRunBypassesDueTimeButNotKnownFutureAirDate()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        await host.Seed(db => { var item = LibraryHost.Watch(); item.NextCheckAt = DateTime.UtcNow.AddDays(1); db.WatchListItems.Add(item); });
        (await client.PostAsync("/api/automation/run", null)).EnsureSuccessStatusCode();
        Assert.Single(host.Search.Requests);
        host.AirDates.Resolve = (_, _) => DateTime.UtcNow.AddDays(1);
        (await client.PostAsync("/api/automation/run", null)).EnsureSuccessStatusCode();
        Assert.Single(host.Search.Requests);
    }

    [Theory]
    [InlineData(1080, 1, false)]
    [InlineData(2160, 1, true)]
    [InlineData(1080, 2, true)]
    public async Task OnlyChangedAcquisitionInputsResetGrace(int resolution, int episode, bool reset)
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        await host.Seed(db =>
        {
            var item = LibraryHost.Watch(); item.PreferredResolution = 1080; item.CursorMisses = 5;
            item.SeederWaitSince = DateTime.UtcNow.AddHours(-2); db.WatchListItems.Add(item);
        });
        (await client.PatchAsJsonAsync("/api/watchlist", new { id = "watch", preferredResolution = resolution, cursorSeason = 1, cursorEpisode = episode })).EnsureSuccessStatusCode();
        await using var db = await host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        var item = await db.WatchListItems.SingleAsync();
        Assert.Equal(reset, item.SeederWaitSince == null);
        Assert.Equal(reset ? 0 : 5, item.CursorMisses);
        Assert.NotNull(item.NextCheckAt);
    }

    [Fact]
    public async Task DueItemsAreSeriallySpacedAndFutureItemIsNotSearched()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        host.Services.GetRequiredService<IOptions<AutomationOptions>>().Value.ItemSpacingMilliseconds = 100;
        await host.Seed(db =>
        {
            db.WatchListItems.Add(LibraryHost.Watch("one"));
            var two = LibraryHost.Watch("two"); two.ExternalId = "two"; db.WatchListItems.Add(two);
            var future = LibraryHost.Watch("future"); future.ExternalId = "future"; future.NextCheckAt = DateTime.UtcNow.AddDays(1); db.WatchListItems.Add(future);
        });
        var starts = new List<long>();
        host.Search.Respond = o => { starts.Add(System.Diagnostics.Stopwatch.GetTimestamp()); return new() { Query = o.Query }; };
        await host.Services.GetRequiredService<AutomationService>().Run(new[] { "one", "two", "future" }, default);
        Assert.Equal(2, starts.Count);
        Assert.True(System.Diagnostics.Stopwatch.GetElapsedTime(starts[0], starts[1]) >= TimeSpan.FromMilliseconds(90));
    }

    [Fact]
    public async Task LegacyBackoffDoesNotSuppressFreshAiringAndMetadataFailureFallsBack()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        host.AirDates.Resolve = (_, _) => DateTime.UtcNow.AddHours(-1);
        await host.Seed(db => { var item = LibraryHost.Watch(); item.CursorMisses = 9; db.WatchListItems.Add(item); });
        await host.Services.GetRequiredService<AutomationService>().Run(default);
        Assert.Single(host.Search.Requests);
        host.AirDates.Resolve = (_, _) => throw new HttpRequestException("offline");
        (await client.PatchAsJsonAsync("/api/watchlist", new { id = "watch", cursorSeason = 1, cursorEpisode = 2 })).EnsureSuccessStatusCode();
        await host.Services.GetRequiredService<AutomationService>().Run(default);
        Assert.Equal(2, host.Search.Requests.Count);
    }

    [Fact]
    public async Task MigrationRoundTripKeepsExistingWatchlistRows()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Seed(db => db.WatchListItems.Add(LibraryHost.Watch()));
        await using var db = await host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        var migrator = db.GetService<IMigrator>();
        await migrator.MigrateAsync("20260925134945_ClientMaxActiveDownloads");
        await migrator.MigrateAsync();
        var item = await db.WatchListItems.AsNoTracking().SingleAsync();
        Assert.Equal("Example Show", item.Title);
        Assert.Null(item.NextCheckAt);
        Assert.Null(item.NextCheckReason);
    }

    [Fact]
    public async Task DisabledIntervalDoesNotRunEvenWhenWoken()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        await host.Seed(db => db.WatchListItems.Add(LibraryHost.Watch()));
        var wake = host.Services.GetRequiredService<AutomationWake>();
        using var scheduler = new AutomationScheduler(host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>(),
            host.Services.GetRequiredService<AutomationService>(), new ConfigurationBuilder().Build(),
            NullLogger<AutomationScheduler>.Instance, wake);
        await scheduler.StartAsync(default);
        wake.Wake();
        await Task.Delay(100);
        await scheduler.StopAsync(default);
        Assert.Empty(host.Search.Requests);
    }
}
