using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Library.Features.Grabs;

namespace TorrentFlow.Library.Tests;

public sealed class EpisodeDiagnosticsTests
{
    private static TorrentResult Candidate(string title, int id) => FakeSearch.Release(title) with { InfoHash = id.ToString("x40") };

    [Fact]
    public async Task RejectionSummaryCountsUniqueCandidatesAndPersistsInExistingUiFields()
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        var wrong = Enumerable.Range(2, 9).Select(n => Candidate($"Example Show S01E{n:00} 1080p", n)).ToArray();
        var low = Enumerable.Range(20, 3).Select(n => Candidate($"Example Show S01E01 720p Group{n}", n)).ToArray();
        host.Search.Respond = o => new()
        {
            Query = o.Query, Results = low,
            RejectedResults = wrong.Select(r => new SearchRejectedResult(r, "episode_filter")).ToArray()
        };
        var response = await client.PostAsJsonAsync("/api/title/example-show",
            new { title = "Example Show", mediaType = "tv", scope = "episode", season = 1, episode = 1, preferredResolution = 1080 });
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var message = body.RootElement.GetProperty("message").GetString();
        Assert.Equal("Couldn't find a release for S01E01 at 1080p or higher. 12 results checked: 9 were a different episode; 3 were below 1080p.", message);
        var report = body.RootElement.GetProperty("noReleaseFound");
        Assert.Equal(12, report.GetProperty("candidates").GetArrayLength());
        Assert.All(report.GetProperty("candidates").EnumerateArray(), c => Assert.NotEmpty(c.GetProperty("reasons").EnumerateArray()));
        Assert.DoesNotContain("magnet:", report.GetRawText());
        Assert.All(host.Search.Requests, r => Assert.True(r.IncludeRejectedResults));
        await host.Seed(db =>
        {
            Assert.Equal(message, db.AcquisitionTargets.Single().Error);
            Assert.Equal(message, db.GrabJobs.OrderByDescending(g => g.CreatedAt).First().Message);
        });
        Assert.Empty(host.Engine.Adds);
    }

    [Fact]
    public async Task SourceFailuresAreNotReportedAsAnEmptyCatalog()
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        host.Search.Respond = o => new() { Query = o.Query, Sources = [new("nyaa", 0, "timed out")] };
        var result = await host.Services.GetRequiredService<GrabService>().Grab(new("Frieren", "anime", new(1, 5)), default);
        Assert.False(result.Ok);
        Assert.Contains("Search could not finish", result.Message);
        Assert.DoesNotContain("No results were returned", result.Message);
    }

    [Fact]
    public async Task RateLimitKeepsEarlierCandidateDiagnosticsAndStopsTheLadder()
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        host.Search.Respond = o => host.Search.Requests.Count == 1
            ? new() { Query = o.Query, Results = [Candidate("Frieren S01E06 1080p", 1)] }
            : throw new InvalidOperationException("Indexers are being rate limited");
        var result = await host.Services.GetRequiredService<GrabService>().Grab(new("Frieren", "anime", new(1, 5)), default);
        Assert.False(result.Ok);
        Assert.Equal(2, host.Search.Requests.Count);
        Assert.Contains("different episode", result.Message);
        Assert.Contains("search could not finish", result.Message);
        Assert.NotNull(result.NoReleaseFound);
    }

    [Theory]
    [InlineData("Example Show S01E05 720p", "below_floor")]
    [InlineData("Example Show S01E05 WEB-DL", "unknown_quality")]
    [InlineData("Example Show S01E50 1080p", "different_episode")]
    [InlineData("Example Show Season 1 Complete 1080p", "pack")]
    [InlineData("Other Show S01E05 1080p", "other_work")]
    [InlineData("Example Show [1080p]", "unknown_episode")]
    public void EveryGateRetainsItsReason(string title, string reason)
    {
        var rejection = EpisodeRejections.Explain(Candidate(title, 1), ["Example Show"], new(1, 5), null, 1080, false);
        Assert.Contains(reason, rejection.Reasons);
    }

    [Fact]
    public async Task FailedEngineAdmissionsRemainDistinctFromNoMatchingEpisodes()
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        host.Engine.Result = new(false, "Engine could not start");
        host.Search.Respond = o => new()
        {
            Query = o.Query, Results = [Candidate("Example Show S01E05 1080p A", 1), Candidate("Example Show S01E05 1080p B", 2)]
        };
        var result = await host.Services.GetRequiredService<GrabService>().Grab(new("Example Show", "tv", new(1, 5)), default);
        Assert.False(result.Ok);
        Assert.Equal(2, host.Engine.Adds.Count);
        Assert.Contains("2 could not be started", result.Message);
    }
}
