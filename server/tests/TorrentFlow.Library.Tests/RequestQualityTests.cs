using Microsoft.Extensions.DependencyInjection;
using System.Net.Http.Json;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Automation;

namespace TorrentFlow.Library.Tests;

public sealed class RequestQualityTests
{
    [Theory]
    [InlineData(false, 720)]
    [InlineData(false, 1080)]
    [InlineData(true, 720)]
    [InlineData(true, 1080)]
    public async Task AutomationWatchlistAndRulesPreferSmallerNonRemuxAtSelectedQuality(bool rule, int floor)
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        await host.Seed(db => db.ClientSettings.Single().PreferredResolution = floor);
        if (rule)
            await client.PostAsJsonAsync("/api/rules", new { name = "Weekly", query = "Example Show", category = "anime", resolution = $"{floor}p" });
        else
            await host.Seed(db => db.WatchListItems.Add(LibraryHost.Watch()));
        host.Search.Respond = o => new()
        {
            Query = o.Query, Results =
            [
                FakeSearch.Release("Example Show S01E01 2160p REMUX", 500) with { SizeBytes = 12_000_000_000 },
                FakeSearch.Release($"Example Show S01E01 {floor}p REMUX", 400) with { SizeBytes = 8_000_000_000 },
                FakeSearch.Release($"Example Show S01E01 {floor}p WEB-DL Large", 300) with { SizeBytes = 4_000_000_000 },
                FakeSearch.Release($"Example Show S01E01 {floor}p WEB-DL", 30) with { SizeBytes = 700_000_000 }
            ]
        };
        await host.Services.GetRequiredService<AutomationService>().Run(default);
        var sent = Assert.Single(host.Engine.Adds);
        Assert.Equal($"Example Show S01E01 {floor}p WEB-DL", sent.Name);
        Assert.Equal(TorrentLane.Automation, sent.Lane);
    }

    [Theory]
    [InlineData(720, "Breaking Bad S03E05 720p WEB-DL", false)]
    [InlineData(1080, "Breaking Bad S03E05 1080p WEB-DL", false)]
    [InlineData(720, "Breaking Bad S03E05 1080p WEB-DL", true)]
    public async Task RequestsPreferClosestQualityAndWebOverRemuxWithoutTakingPacks(int floor, string expected, bool no720)
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        await host.Seed(db => db.ClientSettings.Single().PreferredResolution = floor);
        TorrentResult Release(string title, int id, long bytes) =>
            FakeSearch.Release(title, 200) with { InfoHash = id.ToString("x40"), SizeBytes = bytes };
        host.Search.Respond = o => new()
        {
            Query = o.Query, Results = new[]
            {
                Release("Breaking Bad S03 Complete 2160p REMUX", 1, 88000000000),
                Release("Breaking Bad S03E05 2160p WEB-DL", 2, 6000000000),
                Release("Breaking Bad S03E05 1080p REMUX", 3, 8000000000),
                Release("Breaking Bad S03E05 1080p WEB-DL", 4, 1500000000),
                Release("Breaking Bad S03E05 720p WEB-DL", 5, 700000000),
                Release("Breaking Bad S03E05 480p WEB-DL", 6, 300000000),
            }.Where(r => !no720 || !r.Title.Contains("720p")).ToArray()
        };
        var result = await host.Services.GetRequiredService<GrabService>().Grab(
            new("Breaking Bad", "tv", new(3, 5), Lane: TorrentLane.Request), default);
        Assert.True(result.Ok, result.Message);
        Assert.Equal(expected, Assert.Single(host.Engine.Adds).Name);
        Assert.EndsWith($"{floor}p", host.Search.Requests[0].Query);
    }

    [Fact]
    public async Task PreferredQualityQueryFindsSmallReleaseBeforeUnfilteredLargeRelease()
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        host.Search.Respond = o => new()
        {
            Query = o.Query, Results = [FakeSearch.Release(o.Query.EndsWith("720p")
                ? "Breaking Bad S03E05 720p WEB-DL" : "Breaking Bad S03E05 2160p REMUX")]
        };
        var result = await host.Services.GetRequiredService<GrabService>().Grab(
            new("Breaking Bad", "tv", new(3, 5), PreferredResolution: 720, Lane: TorrentLane.Request), default);
        Assert.True(result.Ok);
        Assert.Equal("Breaking Bad S03E05 720p WEB-DL", Assert.Single(host.Engine.Adds).Name);
        Assert.Single(host.Search.Requests);
    }
}
