using System.Net;
using System.Net.Http.Json;
using TorrentFlow.Data;

namespace TorrentFlow.Library.Tests;

public sealed class ConcurrentTitleTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ConcurrentTitleGrabsReuseOneWorkAndTarget(bool existingWork)
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        if (existingWork)
            await host.Seed(db => db.Works.Add(new()
            {
                Id = Ids.New(), WorkKey = "concurrent-show", CanonicalTitle = "Concurrent Show",
                MediaType = "tv", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow
            }));
        var responses = await Task.WhenAll(Enumerable.Range(0, 16).Select(_ => Task.Run(() =>
            client.PostAsJsonAsync("/api/title/concurrent-show",
                new { title = "Concurrent Show", mediaType = "tv", scope = "episode", season = 1, episode = 1 }))));
        foreach (var response in responses)
        {
            using (response)
                Assert.True(response.StatusCode == HttpStatusCode.Conflict,
                    $"{response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
        }
        await host.Seed(db =>
        {
            var work = Assert.Single(db.Works);
            var target = Assert.Single(db.AcquisitionTargets);
            Assert.Equal(work.Id, target.WorkId);
            Assert.Equal("failed", target.Status);
        });
    }
}
