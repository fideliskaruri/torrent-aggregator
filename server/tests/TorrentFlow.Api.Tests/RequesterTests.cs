using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TorrentFlow.Api.RemoteAccess;
using TorrentFlow.Api.Requests;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Metadata.Search;

namespace TorrentFlow.Api.Tests;

/// <summary>Canned catalog results so requester tests never reach TMDB or AniList.</summary>
public sealed class FakeCatalog : IRequesterCatalog
{
    public static WorkSearchHit Hit(string title, int? year, string category, string providerId, bool series, string provider = "tmdb") => new()
    {
        WorkKey = TorrentFlow.Metadata.Text.WorkKeys.WorkKeyFor(title, series ? null : year),
        Title = title, Year = year, Category = category, Provider = provider, ProviderId = providerId, Aliases = [],
        MediaType = category == "movies" ? "movie" : category == "series" ? "tv" : "anime",
        TitleMediaType = category == "movies" ? "movie" : category == "series" ? "tv" : "anime",
        IsSeries = series, PosterUrl = "https://image.tmdb.org/t/p/w342/p.jpg", Overview = "overview",
        Href = "/title/x?provider=tmdb",
    };

    public List<WorkSearchHit> Hits { get; } =
    [
        Hit("Dune", 2021, "movies", "438631", series: false),
        Hit("Severance", 2022, "series", "95396", series: true),
        Hit("Frieren", 2023, "anime", "154587", series: true, provider: "anilist"),
    ];

    public bool Fail { get; set; }

    public Task<WorkSearchOutcome> SearchAsync(string scope, string query, int take, CancellationToken ct)
    {
        if (Fail) throw new HttpRequestException("simulated catalog outage with a secret path C:\\data");
        return Task.FromResult(new WorkSearchOutcome(Hits.Take(take).ToList(), query, query, ["movies"], [], false));
    }

    public Task<IReadOnlyList<int>> SeasonsAsync(RequestDraft work, CancellationToken ct) =>
        Fail ? throw new HttpRequestException("simulated catalog outage with a secret path C:\\data")
            : Task.FromResult<IReadOnlyList<int>>([0, 1, 2, 2, 3]);
}

public class RequesterHostFactory : RemoteHostFactory
{
    public FakeCatalog Catalog { get; } = new();

    protected override IDictionary<string, string?> Settings => new Dictionary<string, string?>(base.Settings)
    {
        ["TorrentFlow:Requests:CreatesPerMinute"] = "100",
    };

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IRequesterCatalog>();
            services.AddSingleton<IRequesterCatalog>(Catalog);
        });
    }

    public HttpClient Requester(string email) => Tunnel(Token(email: email));

    public async Task SeedOwnerLibraryAsync(Action<TorrentFlowDbContext> seed)
    {
        var factory = Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();
        await using var db = await factory.CreateDbContextAsync();
        seed(db);
        await db.SaveChangesAsync();
    }
}

public sealed class RequesterTests(RequesterHostFactory factory) : IClassFixture<RequesterHostFactory>
{
    private static readonly string[] Leaks = ["filePath", "magnet", "infoHash", "\"href\"", "playback", "LocalUser", "C:\\"];

    private static async Task<JsonElement> Json(HttpResponseMessage response)
    {
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return doc.RootElement.Clone();
    }

    private static string Email(string name) => $"{name}-{Guid.NewGuid():N}@example.com";

    private static object Movie(string title = "Dune", int year = 2021, string id = "438631") => new
    {
        provider = "tmdb", providerId = id, mediaType = "movie", title, year, posterUrl = "https://image.tmdb.org/t/p/w342/p.jpg", scope = "movie",
    };

    private static object Seasons(params int[] seasons) => new
    {
        provider = "tmdb", providerId = "1399", mediaType = "tv", title = "Game of Thrones", year = 2011, scope = "seasons", seasons,
    };

    private static object Series() => new { provider = "tmdb", providerId = "1399", mediaType = "tv", title = "Game of Thrones", scope = "series" };

    private static Task<HttpResponseMessage> Create(HttpClient client, object body) => client.PostAsJsonAsync("/api/requester/requests", body);

    [Fact]
    public async Task ASignedInFriendBecomesARequesterWithOneUserRow()
    {
        var email = Email("Friend").ToUpperInvariant();
        using var client = factory.Requester(email);
        var me = await client.GetAsync("/api/me");
        Assert.Equal(HttpStatusCode.OK, me.StatusCode);
        var body = await Json(me);
        Assert.Equal("requester", body.GetProperty("role").GetString());
        Assert.Equal("tunnel", body.GetProperty("via").GetString());
        Assert.Equal(email.ToLowerInvariant(), body.GetProperty("email").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("pendingRequests").ValueKind);
        await client.GetAsync("/api/me");

        var db = await factory.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        await using (db)
        {
            var users = await db.Users.Where(u => u.Email == email.ToLowerInvariant()).ToListAsync();
            var user = Assert.Single(users);
            Assert.NotEqual(LocalUser.Id, user.Id);
        }
    }

    [Fact]
    public async Task ConcurrentFirstSightCreatesOneUserRow()
    {
        var email = Email("race");
        var clients = Enumerable.Range(0, 8).Select(_ => factory.Requester(email)).ToList();
        try
        {
            var responses = await Task.WhenAll(clients.Select(c => c.GetAsync("/api/me")));
            Assert.All(responses, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));
        }
        finally { clients.ForEach(c => c.Dispose()); }

        await using var db = await factory.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        Assert.Single(await db.Users.Where(u => u.Email == email).ToListAsync());
    }

    [Fact]
    public async Task SearchesAreRateLimitedByEmail()
    {
        using var limited = new RateLimitedFactory();
        using var client = limited.Requester(Email("search-rate"));
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/requester/titles?q=dune")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/requester/titles?q=dune")).StatusCode);
        var third = await client.GetAsync("/api/requester/titles?q=dune");
        Assert.Equal(HttpStatusCode.TooManyRequests, third.StatusCode);
        Assert.Equal("rate_limited", (await Json(third)).GetProperty("code").GetString());

        using var other = limited.Requester(Email("search-rate-other"));
        Assert.Equal(HttpStatusCode.OK, (await other.GetAsync("/api/requester/titles?q=dune")).StatusCode);
    }

    [Fact]
    public async Task RequestersGetTheShellFilesAndAllowListedApis()
    {
        using var client = factory.Requester(Email("shell"));
        foreach (var path in new[] { "/", "/requests", "/downloads", "/settings", "/assets/app.js", "/manifest.webmanifest", "/api/health", "/api/features", "/api/me" })
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(path)).StatusCode);
    }

    /// <summary>Every routed endpoint without requester metadata is refused, so new endpoints are owner-only by default.</summary>
    [Fact]
    public async Task EveryEndpointOutsideTheAllowListIs403ForARequester()
    {
        var sources = factory.Services.GetRequiredService<IEnumerable<EndpointDataSource>>();
        var endpoints = sources.SelectMany(s => s.Endpoints).OfType<RouteEndpoint>().ToList();
        Assert.True(endpoints.Count > 50, $"only {endpoints.Count} endpoints were found");

        var allowed = endpoints.Where(e => e.Metadata.GetMetadata<RequesterAccess>() is not null)
            .Select(e => $"{Methods(e)} {Normalize(e.RoutePattern)}").Order(StringComparer.Ordinal).ToList();
        Assert.Equal(new[]
        {
            "GET,HEAD {**path:regex(^(?!api/|assets/).*$)}",
            "GET api/features",
            "GET api/health",
            "GET api/me",
            "GET api/requester/requests",
            "GET api/requester/seasons",
            "GET api/requester/titles",
            "POST api/requester/requests",
            "POST api/requester/requests/{id}/cancel",
        }.Order(StringComparer.Ordinal), allowed);

        using var client = factory.Requester(Email("table"));
        var checkedCount = 0;
        var nonApi = new List<string>();
        foreach (var endpoint in endpoints.Where(e => e.Metadata.GetMetadata<RequesterAccess>() is null))
        {
            var pattern = Normalize(endpoint.RoutePattern);
            if (!pattern.StartsWith("api/", StringComparison.OrdinalIgnoreCase)) nonApi.Add(pattern);
            var path = "/" + SamplePath(endpoint.RoutePattern);
            var methods = endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods is { Count: > 0 } list ? list : ["GET"];
            foreach (var method in methods)
            {
                using var request = new HttpRequestMessage(new HttpMethod(method), path);
                if (method is "POST" or "PUT" or "PATCH") request.Content = JsonContent.Create(new { });
                var response = await client.SendAsync(request);
                Assert.True(response.StatusCode == HttpStatusCode.Forbidden, $"{method} {path} ({pattern}) gave {(int)response.StatusCode}");
                Assert.Equal("requester_forbidden", (await Json(response)).GetProperty("code").GetString());
                checkedCount++;
            }
        }
        Assert.True(checkedCount > 50);
        // A new page-level endpoint must be reviewed here rather than slipping in beside the SPA fallback.
        Assert.Equal(new[] { "activity", "client" }, nonApi.Order());
    }

    [Theory]
    [InlineData("/API/settings/remote-access")]
    [InlineData("//api/settings/remote-access")]
    [InlineData("/api//settings/remote-access")]
    [InlineData("/api/me/extra")]
    [InlineData("/api")]
    [InlineData("/api/requests")]
    [InlineData("/api/watchlist")]
    [InlineData("/api/search?q=dune")]
    [InlineData("/api/search/titles?q=dune")]
    [InlineData("/api/stream/abc")]
    [InlineData("/api./watchlist")]
    [InlineData("/%61pi/watchlist")]
    public async Task PathTricksAreStillRefused(string path)
    {
        using var client = factory.Requester(Email("tricks"));
        // An absolute URI keeps "//api/..." as a path instead of a protocol-relative host.
        var response = await client.GetAsync(client.BaseAddress!.GetLeftPart(UriPartial.Authority) + path);
        Assert.True(response.StatusCode == HttpStatusCode.Forbidden, $"{path} gave {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
    }

    [Fact]
    public void RequesterPathsAllowOnlyTheListedApis()
    {
        Assert.True(RequesterPaths.IsAllowed(new PathString("/")));
        Assert.True(RequesterPaths.IsAllowed(new PathString("/requests")));
        Assert.True(RequesterPaths.IsAllowed(new PathString("/assets/app.js")));
        Assert.True(RequesterPaths.IsAllowed(new PathString("/api/me")));
        Assert.True(RequesterPaths.IsAllowed(new PathString("/API/Requester/titles")));
        Assert.False(RequesterPaths.IsAllowed(new PathString("/api/me/x")));
        Assert.False(RequesterPaths.IsAllowed(new PathString("/api/requests")));
        Assert.False(RequesterPaths.IsAllowed(new PathString("/api/requesters")));
        Assert.False(RequesterPaths.IsAllowed(new PathString("//api/watchlist")));
        Assert.False(RequesterPaths.IsAllowed(new PathString("/api%2Fwatchlist")));
    }

    [Fact]
    public async Task SearchShowsLibraryAndRequestFlagsWithoutLeakingOwnerData()
    {
        await factory.SeedOwnerLibraryAsync(db => db.WatchListItems.Add(new WatchListItem
        {
            Id = Ids.New(), UserId = LocalUser.Id, MediaType = "tv", ExternalId = "95396", Title = "Severance", Status = "watching",
            MonitorMode = "ongoing", LatestReleaseMagnet = "magnet:?xt=urn:btih:secret", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow, LastChecked = DateTime.UtcNow,
        }));
        using var client = factory.Requester(Email("search"));
        Assert.Equal(HttpStatusCode.Created, (await Create(client, Movie())).StatusCode);

        var response = await client.GetAsync("/api/requester/titles?q=dune");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var text = await response.Content.ReadAsStringAsync();
        foreach (var leak in Leaks) Assert.DoesNotContain(leak, text, StringComparison.OrdinalIgnoreCase);
        var results = (await Json(response)).GetProperty("results").EnumerateArray().ToList();
        var dune = results.Single(r => r.GetProperty("title").GetString() == "Dune");
        Assert.False(dune.GetProperty("inLibrary").GetBoolean());
        Assert.Equal("pending", dune.GetProperty("requestStatus").GetString());
        Assert.Equal("438631", dune.GetProperty("providerId").GetString());
        var severance = results.Single(r => r.GetProperty("title").GetString() == "Severance");
        Assert.True(severance.GetProperty("inLibrary").GetBoolean());
        Assert.Equal(JsonValueKind.Null, severance.GetProperty("requestStatus").ValueKind);

        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/api/requester/titles?q=%20")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/api/requester/titles?q=" + new string('a', 201))).StatusCode);
    }

    [Fact]
    public async Task SearchFailuresDoNotEchoTheCause()
    {
        using var failing = new RequesterHostFactory();
        failing.Catalog.Fail = true;
        using var client = failing.Requester(Email("fail"));
        var response = await client.GetAsync("/api/requester/titles?q=dune");
        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.DoesNotContain("C:\\", await response.Content.ReadAsStringAsync());

        var seasons = await client.GetAsync("/api/requester/seasons?provider=tmdb&providerId=1399&mediaType=tv&title=Game%20of%20Thrones");
        Assert.Equal(HttpStatusCode.BadGateway, seasons.StatusCode);
        var text = await seasons.Content.ReadAsStringAsync();
        Assert.DoesNotContain("C:\\", text);
        Assert.Contains("seasons_failed", text);
    }

    [Fact]
    public async Task SeasonsAreCleanedForThePicker()
    {
        using var client = factory.Requester(Email("seasons"));
        var response = await client.GetAsync("/api/requester/seasons?provider=tmdb&providerId=1399&mediaType=tv&title=Game%20of%20Thrones");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(new[] { 1, 2, 3 }, (await Json(response)).GetProperty("seasons").EnumerateArray().Select(e => e.GetInt32()));
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/api/requester/seasons?provider=evil&mediaType=tv&title=x")).StatusCode);
    }

    [Fact]
    public async Task DuplicateAndOverlappingOpenRequestsAre409()
    {
        using var client = factory.Requester(Email("dup"));
        var created = await Create(client, Movie());
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var request = (await Json(created)).GetProperty("request");
        Assert.Equal("pending", request.GetProperty("status").GetString());
        Assert.Equal("movie", request.GetProperty("scope").GetString());

        var again = await Create(client, Movie());
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
        Assert.Equal("duplicate", (await Json(again)).GetProperty("code").GetString());

        Assert.Equal(HttpStatusCode.Created, (await Create(client, Seasons(1, 2))).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await Create(client, Seasons(2, 3))).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await Create(client, Series())).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await Create(client, Seasons(3))).StatusCode);

        // Another person may ask for the same title.
        using var other = factory.Requester(Email("dup-other"));
        Assert.Equal(HttpStatusCode.Created, (await Create(other, Movie())).StatusCode);
    }

    [Fact]
    public async Task TitlesAlreadyInTheLibraryAreRefused()
    {
        await factory.SeedOwnerLibraryAsync(db => db.AcquisitionTargets.Add(new AcquisitionTarget
        {
            Id = Ids.New(), UserId = LocalUser.Id, TargetKey = "arrival-2016:title", WorkKey = "arrival-2016", Scope = "title", Status = "downloaded",
            FilePath = "D:\\Media\\Arrival.mkv", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
        }));
        using var client = factory.Requester(Email("library"));
        var response = await Create(client, Movie("Arrival", 2016, "329865"));
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var text = await response.Content.ReadAsStringAsync();
        Assert.Contains("in_library", text);
        Assert.DoesNotContain("Media", text);
    }

    [Fact]
    public async Task OpenRequestsAreCappedPerPerson()
    {
        using var client = factory.Requester(Email("cap"));
        for (var i = 0; i < 10; i++)
            Assert.Equal(HttpStatusCode.Created, (await Create(client, Movie($"Film {i}", 2000 + i, (1000 + i).ToString(System.Globalization.CultureInfo.InvariantCulture)))).StatusCode);
        var over = await Create(client, Movie("Film 10", 2010, "1010"));
        Assert.Equal(HttpStatusCode.Conflict, over.StatusCode);
        Assert.Equal("too_many_open", (await Json(over)).GetProperty("code").GetString());

        // Cancelling one frees a slot.
        var mine = (await Json(await client.GetAsync("/api/requester/requests"))).GetProperty("requests").EnumerateArray().ToList();
        Assert.Equal(10, mine.Count);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync($"/api/requester/requests/{mine[0].GetProperty("id").GetString()}/cancel", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await Create(client, Movie("Film 10", 2010, "1010"))).StatusCode);
    }

    [Fact]
    public async Task CreatesAreRateLimitedByEmailNotByForwardedAddress()
    {
        using var limited = new RateLimitedFactory();
        var email = Email("rate");
        using var client = limited.Requester(email);
        Assert.Equal(HttpStatusCode.Created, (await Create(client, Movie("A", 2001, "1"))).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await Create(client, Movie("B", 2002, "2"))).StatusCode);
        using var spoofed = limited.Requester(email);
        spoofed.DefaultRequestHeaders.Add("X-Forwarded-For", "203.0.113.77");
        var third = await Create(spoofed, Movie("C", 2003, "3"));
        Assert.Equal(HttpStatusCode.TooManyRequests, third.StatusCode);

        using var someoneElse = limited.Requester(Email("rate-other"));
        Assert.Equal(HttpStatusCode.Created, (await Create(someoneElse, Movie("C", 2003, "3"))).StatusCode);
    }

    [Fact]
    public async Task OnlyYourOwnPendingRequestsCanBeCancelled()
    {
        using var client = factory.Requester(Email("cancel"));
        var id = (await Json(await Create(client, Movie("Heat", 1995, "949")))).GetProperty("request").GetProperty("id").GetString();

        using var other = factory.Requester(Email("cancel-other"));
        Assert.Equal(HttpStatusCode.NotFound, (await other.PostAsync($"/api/requester/requests/{id}/cancel", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync("/api/requester/requests/nope/cancel", null)).StatusCode);

        var cancelled = await client.PostAsync($"/api/requester/requests/{id}/cancel", null);
        Assert.Equal(HttpStatusCode.OK, cancelled.StatusCode);
        Assert.Equal("cancelled", (await Json(cancelled)).GetProperty("request").GetProperty("status").GetString());
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsync($"/api/requester/requests/{id}/cancel", null)).StatusCode);

        // A cancelled request no longer blocks asking again.
        Assert.Equal(HttpStatusCode.Created, (await Create(client, Movie("Heat", 1995, "949"))).StatusCode);
        var mine = await client.GetAsync("/api/requester/requests");
        var text = await mine.Content.ReadAsStringAsync();
        foreach (var leak in Leaks.Append("watchListItemId").Append("acquisitionTargetId").Append("requestedBy"))
            Assert.DoesNotContain(leak, text, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(2, (await Json(mine)).GetProperty("requests").GetArrayLength());
    }

    [Theory]
    [InlineData("{\"provider\":\"tmdb\",\"mediaType\":\"movie\",\"title\":\"X\",\"scope\":\"seasons\",\"seasons\":[1]}", "film")]
    [InlineData("{\"provider\":\"tmdb\",\"mediaType\":\"tv\",\"title\":\"X\",\"scope\":\"seasons\",\"seasons\":[]}", "season")]
    [InlineData("{\"provider\":\"tmdb\",\"mediaType\":\"tv\",\"title\":\"X\",\"scope\":\"seasons\",\"seasons\":[0]}", "Season numbers")]
    [InlineData("{\"provider\":\"tmdb\",\"mediaType\":\"tv\",\"title\":\"X\",\"scope\":\"movie\"}", "series")]
    [InlineData("{\"provider\":\"evil\",\"mediaType\":\"movie\",\"title\":\"X\",\"scope\":\"movie\"}", "provider")]
    [InlineData("{\"provider\":\"tmdb\",\"providerId\":\"../x\",\"mediaType\":\"movie\",\"title\":\"X\",\"scope\":\"movie\"}", "providerId")]
    [InlineData("{\"provider\":\"tmdb\",\"mediaType\":\"movie\",\"title\":\"\",\"scope\":\"movie\"}", "title")]
    [InlineData("{\"provider\":\"tmdb\",\"mediaType\":\"movie\",\"title\":\"X\",\"scope\":\"movie\",\"userId\":\"local\"}", "Unknown field")]
    [InlineData("{\"provider\":\"tmdb\",\"mediaType\":\"movie\",\"title\":\"X\",\"scope\":\"movie\",\"year\":\"2020\"}", "year")]
    [InlineData("[1]", "object")]
    public async Task InvalidCreatesAre400(string json, string message)
    {
        using var client = factory.Requester(Email("invalid"));
        var response = await client.PostAsync("/api/requester/requests", new StringContent(json, System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains(message, (await Json(response)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task UntrustedPostersAreDropped()
    {
        using var client = factory.Requester(Email("poster"));
        var response = await Create(client, new
        {
            provider = "tmdb", providerId = "27205", mediaType = "movie", title = "Inception", year = 2010, scope = "movie",
            posterUrl = "https://tracker.example.net/pixel.gif", note = "  please \u202Ethanks  ",
        });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var request = (await Json(response)).GetProperty("request");
        Assert.Equal(JsonValueKind.Null, request.GetProperty("posterUrl").ValueKind);
        Assert.Equal("please  thanks", request.GetProperty("note").GetString());
    }

    [Fact]
    public async Task TheOwnerSeesEveryRequestAndThePendingCount()
    {
        var email = Email("owner-view");
        using (var client = factory.Requester(email))
            Assert.Equal(HttpStatusCode.Created, (await Create(client, Movie("Alien", 1979, "348"))).StatusCode);

        using var owner = factory.Local();
        var list = await owner.GetAsync("/api/requests");
        Assert.Equal(HttpStatusCode.OK, list.StatusCode);
        var body = await Json(list);
        var rows = body.GetProperty("requests").EnumerateArray().ToList();
        var created = rows.Select(r => r.GetProperty("createdAt").GetDateTime()).ToList();
        Assert.Equal(created.OrderByDescending(d => d), created);
        var row = rows.First(r => r.GetProperty("requestedBy").GetString() == email);
        Assert.Equal("Alien", row.GetProperty("title").GetString());
        Assert.True(body.GetProperty("pendingCount").GetInt32() >= 1);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.GetAsync("/api/requests?status=bogus")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await owner.GetAsync("/api/requests?status=pending")).StatusCode);

        var me = await Json(await owner.GetAsync("/api/me"));
        Assert.Equal("owner", me.GetProperty("role").GetString());
        Assert.True(me.GetProperty("pendingRequests").GetInt32() >= 1);

        using var tunnelOwner = factory.Tunnel(factory.Token());
        Assert.Equal(HttpStatusCode.OK, (await tunnelOwner.GetAsync("/api/requests")).StatusCode);
    }

    [Fact]
    public async Task TheOwnerCannotUseTheRequesterApi()
    {
        using var owner = factory.Local();
        var response = await owner.GetAsync("/api/requester/requests");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("requester_only", (await Json(response)).GetProperty("code").GetString());
        using var tunnelOwner = factory.Tunnel(factory.Token());
        Assert.Equal(HttpStatusCode.Forbidden, (await Create(tunnelOwner, Movie())).StatusCode);
    }

    [Fact]
    public async Task CrossSiteRequesterWritesAreRefused()
    {
        using var client = factory.Requester(Email("csrf"));
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/requester/requests") { Content = JsonContent.Create(Movie()) };
        request.Headers.Add("Sec-Fetch-Site", "cross-site");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(request)).StatusCode);
    }

    [Fact]
    public async Task RequestersOffKeepsTodaysNotEnabledAnswer()
    {
        using var off = new RequestersOffFactory();
        using var client = off.Requester(Email("off"));
        var response = await client.GetAsync("/api/requester/requests");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("remote_access_not_enabled", (await Json(response)).GetProperty("code").GetString());
    }

    [Theory]
    [InlineData("movie", new int[0], "movie", new int[0], true)]
    [InlineData("series", new int[0], "seasons", new[] { 4 }, true)]
    [InlineData("seasons", new[] { 1, 2 }, "seasons", new[] { 2, 3 }, true)]
    [InlineData("seasons", new[] { 1, 2 }, "seasons", new[] { 3 }, false)]
    [InlineData("movie", new int[0], "series", new int[0], false)]
    public void OverlapRules(string a, int[] seasonsA, string b, int[] seasonsB, bool expected) =>
        Assert.Equal(expected, RequestRules.Overlaps(a, seasonsA, b, seasonsB));

    [Theory]
    [InlineData("https://image.tmdb.org/t/p/w342/a.jpg", true)]
    [InlineData("https://s4.anilist.co/file/a.png", true)]
    [InlineData("https://is1-ssl.mzstatic.com/image/a.jpg", true)]
    [InlineData("http://image.tmdb.org/t/p/w342/a.jpg", false)]
    [InlineData("https://image.tmdb.org.evil.net/a.jpg", false)]
    [InlineData("https://user@image.tmdb.org/a.jpg", false)]
    [InlineData("https://image.tmdb.org:8443/a.jpg", false)]
    [InlineData("javascript:alert(1)", false)]
    public void PosterHostsAreAllowListed(string url, bool kept) =>
        Assert.Equal(kept, RequestRules.SafePosterUrl(url) is not null);

    private static string Methods(RouteEndpoint e) =>
        e.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods is { Count: > 0 } m ? string.Join(",", m) : "*";

    private static string Normalize(RoutePattern pattern) => (pattern.RawText ?? "").Trim('/');

    private static string SamplePath(RoutePattern pattern) => string.Join('/', pattern.PathSegments.Select(segment => string.Concat(segment.Parts.Select(part => part switch
    {
        RoutePatternLiteralPart literal => literal.Content,
        RoutePatternSeparatorPart separator => separator.Content,
        RoutePatternParameterPart parameter => SampleValue(parameter),
        _ => "x",
    }))));

    private static string SampleValue(RoutePatternParameterPart parameter)
    {
        var constraints = string.Join(",", parameter.ParameterPolicies.Select(p => p.Content ?? ""));
        if (constraints.Contains("int", StringComparison.OrdinalIgnoreCase) || constraints.Contains("long", StringComparison.OrdinalIgnoreCase)) return "1";
        if (constraints.Contains("guid", StringComparison.OrdinalIgnoreCase)) return Guid.Empty.ToString();
        return "abc";
    }

    private sealed class RateLimitedFactory : RequesterHostFactory
    {
        protected override IDictionary<string, string?> Settings => new Dictionary<string, string?>(base.Settings)
        {
            ["TorrentFlow:Requests:CreatesPerMinute"] = "2",
            ["TorrentFlow:Requests:SearchesPerMinute"] = "2",
        };
    }

    private sealed class RequestersOffFactory : RequesterHostFactory
    {
        protected override IDictionary<string, string?> Settings => new Dictionary<string, string?>(base.Settings)
        {
            ["TorrentFlow:RemoteAccess:AllowRequesters"] = "false",
        };
    }
}
