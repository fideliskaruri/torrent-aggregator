using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Data;
using TorrentFlow.Core.Contracts.Engine;
using Microsoft.Extensions.DependencyInjection;

namespace TorrentFlow.Library.Tests;

public sealed class SeasonFailureTests
{
    [Fact]
    public async Task SeasonReplayReusesHealthyCoordinatesButRetriesErrors()
    {
        using var host = new LibraryHost(); using var http = host.CreateClient();
        await host.Settings();
        await host.Seed(db =>
        {
            db.Works.Add(new() { Id = "work", WorkKey = "example-show", CanonicalTitle = "Example Show", MediaType = "tv" });
            foreach (var episode in new[] { 1, 2 })
                db.EngineTorrents.Add(new() { Id = $"episode-{episode}", UserId = LocalUser.Id,
                    Hash = episode.ToString("x40"), Name = $"Example Show S01E{episode:00} 1080p", WorkId = "work",
                    QueueKey = $"s00001e{episode:00000}", Origin = "user", Status = episode == 1 ? "queued" : "error" });
        });
        host.Search.Respond = o => new() { Query = o.Query, Sources = [new("nyaa", 0)] };
        var response = await http.PostAsJsonAsync("/api/title/example-show", new
        { scope = "season", season = 1, episodes = new[] { 1, 2 }, title = "Example Show", mediaType = "tv" });
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1, body.GetProperty("report").GetProperty("coveredEpisodes").GetInt32());
        Assert.DoesNotContain(host.Search.Requests, r => r.Filters?.Episode == 1);
        Assert.Contains(host.Search.Requests, r => r.Filters?.Episode == 2);
    }

    [Fact]
    public async Task ConcurrentSeasonRetriesShareOneEpisodeAttempt()
    {
        using var host = new LibraryHost(); using var http = host.CreateClient();
        await host.Settings();
        await host.Seed(db => db.Works.Add(new()
            { Id = "work", WorkKey = "example-show", CanonicalTitle = "Example Show", MediaType = "tv" }));
        using var release = new ManualResetEventSlim();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        host.Search.Respond = o =>
        {
            entered.TrySetResult();
            if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException();
            return new() { Query = o.Query, Results = [FakeSearch.Release("Example Show S01E01 1080p")] };
        };
        var grabs = host.Services.GetRequiredService<GrabService>();
        var input = new GrabInput("Example Show", "tv", new(1, 1), WorkId: "work", ReuseExisting: true);
        var first = grabs.Grab(input, default);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var second = grabs.Grab(input, default);
            release.Set();
            Assert.All(await Task.WhenAll(first, second), r => Assert.True(r.Ok));
            Assert.Single(host.Engine.Adds);
        }
        finally { release.Set(); }
    }

    [Fact]
    public void SummaryKeepsEveryCauseAndActionWithoutInternalCopy()
    {
        var failures = new[] { GrabFailure.Storage, GrabFailure.Metadata, GrabFailure.Sources,
            GrabFailure.FromException(new HttpRequestException("busy", null, HttpStatusCode.TooManyRequests)) };
        var transfers = failures.Select((f, i) => new EpisodeTransfer(i + 1, "failed", null, f.Message, f)).ToArray();
        var summary = SeasonFailureSummary.From(new(transfers, [], new object()));
        Assert.Equal(4, summary.Reasons.Count);
        Assert.All(failures, f => { Assert.Contains(f.Message, summary.Message); Assert.Contains(f.Action, summary.Action); });
        Assert.True(summary.Retryable);
        Assert.DoesNotContain("\u2014", summary.Message + summary.Action);
        Assert.DoesNotContain("acquisition", summary.Message + summary.Action);
    }

    [Theory]
    [InlineData("below_floor", "quality_floor")]
    [InlineData("no_seeders", "no_seeders")]
    [InlineData("dub_not_preferred", "audio_preference")]
    [InlineData("other_work", "no_release")]
    public void RelevantCandidateReasonsChooseSpecificRecovery(string rejection, string code)
    {
        var failure = GrabFailure.FromCandidates(1080, [new("Example", "nyaa", [rejection])], false);
        Assert.Equal(code, failure.Code);
        Assert.NotEmpty(failure.Action);
    }

    [Fact]
    public async Task SeasonHttpResponseAggregatesMixedFailuresAndRetryOnlySearchesMissingEpisodes()
    {
        using var host = new LibraryHost(); using var http = host.CreateClient();
        await host.Settings();
        host.Search.Respond = o => new()
        {
            Query = o.Query, Sources = [new("nyaa", 1)],
            Results = o.Filters!.Episode == 2 ? [FakeSearch.Release("Example Show S01E02 1080p")] :
                o.Filters.Episode == 1 ? [FakeSearch.Release("Example Show S01E01 720p")] : [],
        };
        var response = await http.PostAsJsonAsync("/api/title/example-show", new
        { scope = "season", season = 1, episodes = new[] { 1, 2, 3 }, title = "Example Show", mediaType = "tv", preferredResolution = 1080 });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<JsonElement>());
        Assert.Contains("1 of 3", body.GetProperty("message").GetString());
        var report = body.GetProperty("report");
        Assert.True(report.GetProperty("retryable").GetBoolean());
        var reasons = report.GetProperty("failureReasons").EnumerateArray().ToArray();
        Assert.Contains(reasons, r => r.GetProperty("code").GetString() == "quality_floor");
        Assert.Contains(reasons, r => r.GetProperty("code").GetString() == "no_release");
        Assert.DoesNotContain("\u2014", body.GetProperty("message").GetString());
        Assert.DoesNotContain("acquisition", report.GetProperty("planReason").GetString());
        var missing = report.GetProperty("episodes").EnumerateArray().Where(e => e.GetProperty("status").GetString() == "missing")
            .Select(e => e.GetProperty("episode").GetInt32()).ToArray();
        Assert.Equal([1, 3], missing);
        host.Search.Requests.Clear();
        await http.PostAsJsonAsync("/api/title/example-show", new
        { scope = "season", season = 1, episodes = missing, title = "Example Show", mediaType = "tv", preferredResolution = 1080 });
        Assert.DoesNotContain(host.Search.Requests, r => r.Filters?.Episode == 2);
        Assert.All(host.Search.Requests, r => { Assert.False(r.Background); Assert.True(r.WaitForBudget); });
    }

    [Theory]
    [InlineData(false, "no_sources")]
    [InlineData(true, "sources_unavailable")]
    public async Task EmptyAndUnavailableSourcesHaveDifferentActionableHttpFailures(bool unavailable, string code)
    {
        using var host = new LibraryHost(); using var http = host.CreateClient();
        await host.Settings();
        host.Search.Respond = o => new() { Query = o.Query,
            Sources = unavailable ? [new SourceStatus("nyaa", 0, "Timeout")] : [] };
        var response = await http.PostAsJsonAsync("/api/title/example-show", new
        { scope = "season", season = 1, episodes = new[] { 1, 2 }, title = "Example Show", mediaType = "tv" });
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var reason = Assert.Single(body.GetProperty("report").GetProperty("failureReasons").EnumerateArray());
        Assert.Equal(code, reason.GetProperty("code").GetString());
        Assert.Equal(2, reason.GetProperty("count").GetInt32());
        Assert.NotEmpty(reason.GetProperty("action").GetString()!);
    }
}
