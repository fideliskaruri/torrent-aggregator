using System.Net;
using TorrentFlow.Api.Timeline;
using TorrentFlow.Core.Scheduling;

namespace TorrentFlow.Api.Tests;

public sealed class TimelineTests
{
    [Fact]
    public void UpcomingEntriesAreChronologicalWithUnestimatedQueueLastAndStableTies()
    {
        var now = new DateTime(2026, 9, 26, 12, 0, 0, DateTimeKind.Utc);
        var wait = new WaitReason(WaitReasonKind.None, "Ready");
        TimelineEntry Row(string id, string kind, DateTime? at, int? position = null) =>
            new(id, kind, "Title", "S01E01", null, at, null, wait, position);
        var ordered = TimelineService.Order([
            Row("queue-two", "queued", null, 2), Row("later", "airs", now.AddDays(1)),
            Row("b", "check", now), Row("a", "check", now), Row("queue-one", "queued", null, 1)
        ]);
        Assert.Equal(["a", "b", "later", "queue-one", "queue-two"], ordered.Select(e => e.Id));
        Assert.Equal(now, ordered[0].NextCheckAt);
        Assert.Null(ordered[2].NextCheckAt);
    }

    [Fact]
    public async Task TimelineIsOwnerOnlyAndDoesNotExposePaths()
    {
        using var factory = new RemoteHostFactory();
        using var requester = factory.Tunnel(factory.Token(email: "timeline-friend@example.com"));
        Assert.Equal(HttpStatusCode.Forbidden, (await requester.GetAsync("/api/timeline")).StatusCode);
        using var owner = factory.Local();
        var response = await owner.GetAsync("/api/timeline");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoStore);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("\"entries\":[]", body);
        Assert.DoesNotContain("savePath", body);
        Assert.DoesNotContain("filePath", body);
    }
}
