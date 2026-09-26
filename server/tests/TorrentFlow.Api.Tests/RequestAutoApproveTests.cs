using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Api.Requests;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Api.Tests;

public sealed class RequestAutoApproveTests(DecisionHostFactory factory) : IClassFixture<DecisionHostFactory>
{
    private static async Task<JsonElement> Json(HttpResponseMessage response)
    {
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return doc.RootElement.Clone();
    }

    private static string Email(string name) => $"{name}-{Guid.NewGuid():N}@example.com";

    private async Task SeedRuleAsync(string email, string mode)
    {
        await using var db = await factory.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        var now = DateTime.UtcNow;
        var normalized = RequestAutoApproveService.NormalizeEmail(email)!;
        var existing = await db.RequestAutoApproveRules.FirstOrDefaultAsync(r => r.Email == normalized);
        if (existing is null)
        {
            db.RequestAutoApproveRules.Add(new RequestAutoApproveRule
            {
                Id = Ids.New(), Email = normalized, Mode = mode, CreatedAt = now, UpdatedAt = now,
            });
        }
        else
        {
            existing.Mode = mode;
            existing.UpdatedAt = now;
        }
        await db.SaveChangesAsync();
    }

    private Task GrabDone() => factory.Services.GetRequiredService<RequestDecisionService>().LastGrab;

    private async Task<MediaRequest> RowAsync(string id)
    {
        await using var db = await factory.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        return await db.MediaRequests.AsNoTracking().SingleAsync(r => r.Id == id);
    }

    [Theory]
    [InlineData(AutoApproveMode.None, "movie", "movie", false)]
    [InlineData(AutoApproveMode.MoviesOnly, "movie", "movie", true)]
    [InlineData(AutoApproveMode.MoviesOnly, "seasons", "tv", false)]
    [InlineData(AutoApproveMode.MoviesOnly, "series", "tv", false)]
    [InlineData(AutoApproveMode.Everything, "movie", "movie", true)]
    [InlineData(AutoApproveMode.Everything, "seasons", "tv", true)]
    [InlineData(AutoApproveMode.Everything, "series", "anime", true)]
    public void RuleMatching(string mode, string scope, string mediaType, bool expected) =>
        Assert.Equal(expected, AutoApproveMode.Matches(mode, scope, mediaType));

    [Fact]
    public async Task RequesterCannotReadOrWriteAutoApproveRules()
    {
        var email = Email("rules-403");
        using var friend = factory.Requester(email);
        Assert.Equal(HttpStatusCode.Forbidden, (await friend.GetAsync("/api/requests/auto-approve")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden,
            (await friend.PutAsJsonAsync("/api/requests/auto-approve", new { rules = new[] { new { email, mode = "everything" } } })).StatusCode);
    }

    [Fact]
    public async Task OwnerCanGetAndPutRulesAndKnownEmailsIncludeRequesters()
    {
        var friendEmail = Email("known");
        using (var friend = factory.Requester(friendEmail))
        {
            var created = await friend.PostAsJsonAsync("/api/requester/requests", new
            {
                provider = "tmdb", providerId = "91001", mediaType = "movie", title = "Known Film", year = 2001, scope = "movie",
            });
            Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        }

        using var owner = factory.Local();
        var get = await owner.GetAsync("/api/requests/auto-approve");
        Assert.Equal(HttpStatusCode.OK, get.StatusCode);
        var body = await Json(get);
        Assert.Contains(body.GetProperty("knownEmails").EnumerateArray().Select(e => e.GetString()), e => e == friendEmail.ToLowerInvariant());

        var put = await owner.PutAsJsonAsync("/api/requests/auto-approve", new
        {
            rules = new[] { new { email = friendEmail, mode = AutoApproveMode.MoviesOnly } },
        });
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        var saved = (await Json(put)).GetProperty("rules").EnumerateArray().Single();
        Assert.Equal(friendEmail.ToLowerInvariant(), saved.GetProperty("email").GetString());
        Assert.Equal(AutoApproveMode.MoviesOnly, saved.GetProperty("mode").GetString());

        Assert.Equal(HttpStatusCode.BadRequest,
            (await owner.PutAsJsonAsync("/api/requests/auto-approve", new { rules = new[] { new { email = "not-an-email", mode = "everything" } } })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest,
            (await owner.PutAsJsonAsync("/api/requests/auto-approve", new { rules = new[] { new { email = friendEmail, mode = "bogus" } } })).StatusCode);
    }

    [Fact]
    public async Task MoviesOnlyAutoApprovesMoviesAndLeavesSeriesPending()
    {
        var email = Email("movies-only");
        await SeedRuleAsync(email, AutoApproveMode.MoviesOnly);
        using var friend = factory.Requester(email);

        var movie = await friend.PostAsJsonAsync("/api/requester/requests", new
        {
            provider = "tmdb", providerId = "91002", mediaType = "movie", title = "Auto Movie", year = 2002, scope = "movie",
        });
        Assert.Equal(HttpStatusCode.Created, movie.StatusCode);
        var movieBody = await Json(movie);
        Assert.Equal("approved", movieBody.GetProperty("request").GetProperty("status").GetString());
        Assert.Equal(RequestAutoApproveService.AutoApprovedReason, movieBody.GetProperty("request").GetProperty("decisionReason").GetString());
        await GrabDone();
        var movieId = movieBody.GetProperty("request").GetProperty("id").GetString()!;
        Assert.Contains(factory.Grabber.Grabbed, r => r.Id == movieId);
        Assert.Equal(MediaRequestStatus.Approved, (await RowAsync(movieId)).Status);
        Assert.Equal(RequestAutoApproveService.AutoApprovedReason, (await RowAsync(movieId)).DecisionReason);

        var series = await friend.PostAsJsonAsync("/api/requester/requests", new
        {
            provider = "tmdb", providerId = "91003", mediaType = "tv", title = "Hold Series", scope = "series",
        });
        Assert.Equal(HttpStatusCode.Created, series.StatusCode);
        var seriesBody = await Json(series);
        Assert.Equal("pending", seriesBody.GetProperty("request").GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, seriesBody.GetProperty("request").GetProperty("decisionReason").ValueKind);
        Assert.DoesNotContain(factory.Grabber.Grabbed, r => r.Id == seriesBody.GetProperty("request").GetProperty("id").GetString());
    }

    [Fact]
    public async Task EverythingAutoApprovesThroughTheApprovePath()
    {
        var email = Email("everything");
        await SeedRuleAsync(email, AutoApproveMode.Everything);
        using var friend = factory.Requester(email);
        var created = await friend.PostAsJsonAsync("/api/requester/requests", new
        {
            provider = "tmdb", providerId = "91004", mediaType = "tv", title = "Auto Series", scope = "seasons", seasons = new[] { 1 },
        });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var body = await Json(created);
        var id = body.GetProperty("request").GetProperty("id").GetString()!;
        Assert.Equal("approved", body.GetProperty("request").GetProperty("status").GetString());
        Assert.Equal(RequestAutoApproveService.AutoApprovedReason, body.GetProperty("request").GetProperty("decisionReason").GetString());
        await GrabDone();
        Assert.Contains(factory.Grabber.Grabbed, r => r.Id == id);
        Assert.False(string.IsNullOrEmpty((await RowAsync(id)).GrabbedHashes));
    }

    [Fact]
    public async Task NoneDoesNotAutoApprove()
    {
        var email = Email("none-mode");
        await SeedRuleAsync(email, AutoApproveMode.None);
        // Put with none removes the row; seed a none-equivalent by ensuring no rule / moviesOnly then remove
        await using (var db = await factory.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync())
        {
            var normalized = RequestAutoApproveService.NormalizeEmail(email)!;
            var rows = await db.RequestAutoApproveRules.Where(r => r.Email == normalized).ToListAsync();
            db.RequestAutoApproveRules.RemoveRange(rows);
            await db.SaveChangesAsync();
        }
        using var friend = factory.Requester(email);
        var created = await friend.PostAsJsonAsync("/api/requester/requests", new
        {
            provider = "tmdb", providerId = "91005", mediaType = "movie", title = "Stay Pending", year = 2005, scope = "movie",
        });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.Equal("pending", (await Json(created)).GetProperty("request").GetProperty("status").GetString());
    }
}
