using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Library.Features.Automation;
using TorrentFlow.Library.Features.Grabs;

namespace TorrentFlow.Library.Tests;

public sealed class AutomationTests
{
    [Theory]
    [InlineData("Example Show S01E02 720p", false, 2, 2)]
    [InlineData("Example Show S01E02", false, 2, 2)]
    [InlineData("Different Show S01E02 1080p", true, 1, 0)]
    public async Task OnlyRealAbsenceCountsAsHuntMiss(string release, bool rolled, int expectedEpisode, int expectedMisses)
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        await host.Seed(db => { var item = LibraryHost.Watch(episode: 2); item.CursorMisses = 2; db.WatchListItems.Add(item); });
        host.Search.Respond = o => new() { Query = o.Query, Results = [FakeSearch.Release(release)] };
        await host.Services.GetRequiredService<AutomationService>().Run(default);
        await using var db = await host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        var item = await db.WatchListItems.SingleAsync();
        Assert.Equal(rolled ? 2 : 1, item.CursorSeason);
        Assert.Equal(expectedEpisode, item.CursorEpisode);
        Assert.Equal(expectedMisses, item.CursorMisses);
        Assert.Empty(host.Engine.Adds);
        Assert.All(host.Search.Requests, x => Assert.True(x.Background));
    }
    [Theory]
    [InlineData(0, false)]
    [InlineData(7, true)]
    public async Task ThinSwarmWaitsSixHoursWithoutRollingSeason(int waitedHours, bool send)
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        await host.Seed(db =>
        {
            var item = LibraryHost.Watch(); item.SeederWaitSince = DateTime.UtcNow.AddHours(-waitedHours);
            item.CursorMisses = 2; db.WatchListItems.Add(item);
        });
        host.Search.Respond = o => new() { Query = o.Query, Results = [FakeSearch.Release("Example Show S01E01 1080p", 0)] };
        await host.Services.GetRequiredService<AutomationService>().Run(default);
        Assert.Equal(send ? 1 : 0, host.Engine.Adds.Count);
        Assert.All(host.Engine.Adds, a => Assert.Equal(TorrentLane.Automation, a.Lane));
        await using var db = await host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        var item = await db.WatchListItems.SingleAsync();
        Assert.Equal(1, item.CursorSeason);
        Assert.Equal(send ? 2 : 1, item.CursorEpisode);
        Assert.Equal(send ? 0 : 2, item.CursorMisses);
    }
    [Fact]
    public async Task ExistingRunLockSkipsSecondRun()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Seed(db => db.RunLocks.Add(new() { Id = "held", UserId = LocalUser.Id, Scope = "automation", AcquiredAt = DateTime.UtcNow }));
        var summary = await host.Services.GetRequiredService<AutomationService>().Run(default);
        Assert.Equal("Automation is already running — ignored this request", summary["message"]);
        Assert.Empty(host.Search.Requests);
    }
    [Fact]
    public async Task RuleFailureDoesNotPoisonSuccessfulMatchDedupe()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        await client.PostAsJsonAsync("/api/rules", new { name = "Weekly", query = "Example", category = "anime" });
        host.Search.Respond = o => new() { Query = o.Query, Results = [FakeSearch.Release("Example Show S01E01 1080p")] };
        host.Engine.Result = new(false, "client refused");
        var automation = host.Services.GetRequiredService<AutomationService>();
        Assert.Equal("failed", Assert.Single(await automation.Rules(default)).Status);
        await using (var db = await host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync())
        {
            var rule = await db.AutoRules.SingleAsync();
            Assert.Null(rule.LastMatchMagnet); Assert.Equal(0, rule.MatchCount); Assert.NotNull(rule.LastRunAt);
        }
        host.Engine.Result = new(true, "Started", Hash: new string('a', 40));
        Assert.Equal("sent", Assert.Single(await automation.Rules(default)).Status);
        Assert.Equal("skipped", Assert.Single(await automation.Rules(default)).Status);
        Assert.Equal(2, host.Engine.Adds.Count);
        Assert.All(host.Engine.Adds, a => Assert.Equal(TorrentLane.Automation, a.Lane));
    }
    [Theory]
    [InlineData("Blade Runner 2049 1080p", "Blade Runner 2049")]
    [InlineData("1917 1080p", "1917")]
    [InlineData("Dune.2021.1080p", "Dune")]
    [InlineData("[Group] Example Show - 02 [1080p]", "Example Show")]
    [InlineData("Example Show 1x02 1080p", "Example Show")]
    public void IdentityKeepsTitleDigitsAndCutsEpisodeStructure(string release, string name) => Assert.Equal(name, ReleaseSelection.CleanTitle(release));
    [Fact]
    public void BadMetadataCannotMergeDifferentWorks()
    {
        var release = FakeSearch.Release("Children of Dune S01E01 1080p") with
        {
            Metadata = new() { Source = "tmdb", MediaType = "tv", ExternalId = "1", Title = "Dune" }
        };
        Assert.False(ReleaseSelection.SameWork(release, "Dune", []));
        Assert.False(ReleaseSelection.MatchesWork("dune-2021", "Dune", 1984));
        Assert.Equal("amelie-2001", ReleaseSelection.WorkKey("Amélie", 2001));
    }
    [Theory]
    [InlineData("""{"scope":"title","season":1}""", "Title scope cannot include season or episode coordinates.")]
    [InlineData("""{"scope":"episode","season":1}""", "Episode scope requires exactly one season and episode.")]
    [InlineData("""{"scope":"season","season":1,"episodes":[]}""", "Season scope requires a season and its episode list.")]
    [InlineData("""{"scope":"title","infoHash":"abc"}""", "Acquisition intent cannot pin or promote a torrent hash.")]
    [InlineData("""{}""", "An explicit acquisition scope is required.")]
    public async Task AcquisitionScopeNeverWidensMalformedIntent(string json, string expected)
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        var response = await client.PostAsync("/api/title/example", new StringContent(json, System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(System.Net.HttpStatusCode.BadRequest, response.StatusCode);
        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal(expected, body.GetProperty("message").GetString());
        Assert.Empty(host.Engine.Adds);
    }
}
