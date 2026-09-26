using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TorrentFlow.Api.Requests;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Api.Tests;

public sealed class FakeGrabber : IRequestGrabber
{
    public ConcurrentQueue<MediaRequest> Grabbed { get; } = new();

    public Func<MediaRequest, RequestGrabOutcome> Outcome { get; set; } = r => new([$"{r.Id.ToLowerInvariant()}aa"], null);

    public Task<RequestGrabOutcome> GrabAsync(MediaRequest request, CancellationToken ct)
    {
        Grabbed.Enqueue(request);
        return Task.FromResult(Outcome(request));
    }
}

public sealed class FakeTransfers : IRequestTransfers
{
    public ConcurrentDictionary<string, bool> Done { get; } = new(StringComparer.OrdinalIgnoreCase);

    public Task<bool> CompletedAsync(string hash, CancellationToken ct) => Task.FromResult(Done.ContainsKey(hash));
}

public sealed class DecisionHostFactory : RequesterHostFactory
{
    public FakeGrabber Grabber { get; } = new();
    public FakeTransfers Transfers { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IRequestGrabber>();
            services.AddSingleton<IRequestGrabber>(Grabber);
            services.RemoveAll<IRequestTransfers>();
            services.AddSingleton<IRequestTransfers>(Transfers);
        });
    }
}

public sealed class RequestDecisionTests(DecisionHostFactory factory) : IClassFixture<DecisionHostFactory>
{
    private static async Task<JsonElement> Json(HttpResponseMessage response)
    {
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return doc.RootElement.Clone();
    }

    private static string Email(string name) => $"{name}-{Guid.NewGuid():N}@example.com";

    private async Task<(HttpClient Client, string Id)> RequestAsync(string title, string providerId, object? extra = null)
    {
        var client = factory.Requester(Email(title.ToLowerInvariant().Replace(' ', '-')));
        var body = extra ?? new { provider = "tmdb", providerId, mediaType = "movie", title, year = 2000, scope = "movie" };
        var created = await client.PostAsJsonAsync("/api/requester/requests", body);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        return (client, (await Json(created)).GetProperty("request").GetProperty("id").GetString()!);
    }

    private async Task<MediaRequest> RowAsync(string id)
    {
        await using var db = await factory.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        return await db.MediaRequests.AsNoTracking().SingleAsync(r => r.Id == id);
    }

    private Task GrabDone() => factory.Services.GetRequiredService<RequestDecisionService>().LastGrab;

    private static async Task<JsonElement> Mine(HttpClient client, string id) =>
        (await Json(await client.GetAsync("/api/requester/requests"))).GetProperty("requests").EnumerateArray().Single(r => r.GetProperty("id").GetString() == id);

    [Fact]
    public async Task ApprovingGrabsOnTheRequestLaneAndCompletionFulfills()
    {
        var (friend, id) = await RequestAsync("Approve Me", "5001");
        using (friend)
        using (var owner = factory.Local())
        {
            var approved = await owner.PostAsync($"/api/requests/{id}/approve", null);
            Assert.Equal(HttpStatusCode.OK, approved.StatusCode);
            Assert.Equal("approved", (await Json(approved)).GetProperty("status").GetString());
            await GrabDone();

            Assert.Contains(factory.Grabber.Grabbed, r => r.Id == id);
            var row = await RowAsync(id);
            Assert.Equal(MediaRequestStatus.Approved, row.Status);
            var hash = Assert.Single(row.GrabbedHashes!.Split(','));
            Assert.NotNull(row.DecidedAt);

            Assert.Equal(HttpStatusCode.Conflict, (await owner.PostAsync($"/api/requests/{id}/approve", null)).StatusCode);

            var decisions = factory.Services.GetRequiredService<RequestDecisionService>();
            await decisions.OnTorrentCompletedAsync(hash, CancellationToken.None);
            Assert.Equal(MediaRequestStatus.Approved, (await RowAsync(id)).Status);

            factory.Transfers.Done[hash] = true;
            await decisions.OnTorrentCompletedAsync(hash.ToUpperInvariant(), CancellationToken.None);
            Assert.Equal(MediaRequestStatus.Fulfilled, (await RowAsync(id)).Status);
            Assert.Equal("fulfilled", (await Mine(friend, id)).GetProperty("status").GetString());

            var library = await friend.GetAsync("/api/requester/library");
            Assert.Equal(HttpStatusCode.OK, library.StatusCode);
            var text = await library.Content.ReadAsStringAsync();
            Assert.Contains("Approve Me", text);
            foreach (var leak in new[] { "filePath", "savePath", "magnet", "infoHash", "grabbedHashes", hash })
                Assert.DoesNotContain(leak, text, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task ASeriesFulfillsOnlyWhenEveryGrabbedTransferCompletes()
    {
        factory.Grabber.Outcome = r => r.Scope == MediaRequestScope.Movie ? new([$"{r.Id.ToLowerInvariant()}aa"], null)
            : new([$"{r.Id.ToLowerInvariant()}e1", $"{r.Id.ToLowerInvariant()}e2"], null);
        var (friend, id) = await RequestAsync("Two Parts", "",
            new { provider = "tmdb", providerId = "5002", mediaType = "tv", title = "Two Parts", scope = "seasons", seasons = new[] { 1 } });
        using (friend)
        using (var owner = factory.Local())
        {
            Assert.Equal(HttpStatusCode.OK, (await owner.PostAsync($"/api/requests/{id}/approve", null)).StatusCode);
            await GrabDone();
            var hashes = (await RowAsync(id)).GrabbedHashes!.Split(',');
            Assert.Equal(2, hashes.Length);
            var decisions = factory.Services.GetRequiredService<RequestDecisionService>();
            factory.Transfers.Done[hashes[0]] = true;
            await decisions.OnTorrentCompletedAsync(hashes[0], CancellationToken.None);
            Assert.Equal(MediaRequestStatus.Approved, (await RowAsync(id)).Status);
            factory.Transfers.Done[hashes[1]] = true;
            await decisions.OnTorrentCompletedAsync(hashes[1], CancellationToken.None);
            Assert.Equal(MediaRequestStatus.Fulfilled, (await RowAsync(id)).Status);
        }
    }

    [Fact]
    public async Task AnApprovalThatStartsNothingFailsWithASafeReason()
    {
        var (friend, id) = await RequestAsync("Nothing Found", "5003");
        var previous = factory.Grabber.Outcome;
        factory.Grabber.Outcome = r => r.Id == id ? new([], "indexer secret C:\\data magnet:?xt=") : previous(r);
        using (friend)
        using (var owner = factory.Local())
        {
            Assert.Equal(HttpStatusCode.OK, (await owner.PostAsync($"/api/requests/{id}/approve", null)).StatusCode);
            await GrabDone();
            var mine = await Mine(friend, id);
            Assert.Equal("failed", mine.GetProperty("status").GetString());
            Assert.Equal(RequestDecisionService.NoDownloadReason, mine.GetProperty("decisionReason").GetString());
        }
        factory.Grabber.Outcome = previous;
    }

    [Fact]
    public async Task DecliningStoresAReasonTheRequesterSees()
    {
        var (friend, id) = await RequestAsync("Decline Me", "5004");
        using (friend)
        using (var owner = factory.Local())
        {
            Assert.Equal(HttpStatusCode.BadRequest,
                (await owner.PostAsJsonAsync($"/api/requests/{id}/decline", new { reason = new string('x', 501) })).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsJsonAsync($"/api/requests/{id}/decline", new { other = 1 })).StatusCode);
            var declined = await owner.PostAsJsonAsync($"/api/requests/{id}/decline", new { reason = "  Already on Netflix  " });
            Assert.Equal(HttpStatusCode.OK, declined.StatusCode);
            var mine = await Mine(friend, id);
            Assert.Equal("declined", mine.GetProperty("status").GetString());
            Assert.Equal("Already on Netflix", mine.GetProperty("decisionReason").GetString());
            Assert.Equal(HttpStatusCode.Conflict, (await owner.PostAsync($"/api/requests/{id}/approve", null)).StatusCode);
            Assert.DoesNotContain(factory.Grabber.Grabbed, r => r.Id == id);
            Assert.Equal(HttpStatusCode.NotFound, (await owner.PostAsync("/api/requests/missing/decline", null)).StatusCode);
        }
    }

    [Fact]
    public async Task RequestersCannotDecideAndTheLibraryOmitsUnfinishedTitles()
    {
        var (friend, id) = await RequestAsync("Self Approve", "5005");
        using (friend)
        {
            Assert.Equal(HttpStatusCode.Forbidden, (await friend.PostAsync($"/api/requests/{id}/approve", null)).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await friend.PostAsJsonAsync($"/api/requests/{id}/decline", new { reason = "x" })).StatusCode);
            Assert.Equal(MediaRequestStatus.Pending, (await RowAsync(id)).Status);

            await factory.SeedOwnerLibraryAsync(db =>
            {
                var now = DateTime.UtcNow;
                db.Works.Add(new Work { Id = Ids.New(), WorkKey = "done-film-1999", CanonicalTitle = "Done Film", MediaType = "movie", Year = 1999, CreatedAt = now, UpdatedAt = now });
                db.Works.Add(new Work { Id = Ids.New(), WorkKey = "half-film-1999", CanonicalTitle = "Half Film", MediaType = "movie", Year = 1999, CreatedAt = now, UpdatedAt = now });
                db.AcquisitionTargets.Add(new AcquisitionTarget { Id = Ids.New(), UserId = LocalUser.Id, TargetKey = "done-film-1999:title:-:-", WorkKey = "done-film-1999",
                    Scope = "title", Status = "downloaded", FilePath = "C:\\media\\done.mkv", CreatedAt = now, UpdatedAt = now });
                db.AcquisitionTargets.Add(new AcquisitionTarget { Id = Ids.New(), UserId = LocalUser.Id, TargetKey = "half-film-1999:title:-:-", WorkKey = "half-film-1999",
                    Scope = "title", Status = "downloading", CreatedAt = now, UpdatedAt = now });
            });
            var text = await (await friend.GetAsync("/api/requester/library")).Content.ReadAsStringAsync();
            Assert.Contains("Done Film", text);
            Assert.DoesNotContain("Half Film", text);
            Assert.DoesNotContain("C:\\\\media", text);
            Assert.DoesNotContain("filePath", text, StringComparison.OrdinalIgnoreCase);
        }
    }
}
