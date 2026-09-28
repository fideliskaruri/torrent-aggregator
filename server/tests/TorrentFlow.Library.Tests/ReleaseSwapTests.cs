using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;

namespace TorrentFlow.Library.Tests;

public sealed class ReleaseSwapTests
{
    [Fact]
    public async Task HttpContractExposesRankedChoicesAndAcceptsOnlyBoundTokens()
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        var hash = 1.ToString("x40");
        var candidate = Release(2, "Big Buck Bunny 2008 1080p") with { SizeBytes = 1000, Leechers = 4 };
        await host.Seed(db => db.EngineTorrents.Add(new()
        {
            Id = "swap-contract", UserId = LocalUser.Id, Hash = hash, Name = "Big Buck Bunny 2008 1080p",
            Origin = "user", Status = "downloading", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
            LastUsedAt = DateTime.UtcNow
        }));
        host.Engine.Info = _ => new EngineTorrentInfo { Hash = hash, Name = "Big Buck Bunny", State = "stalledDL",
            Health = new(1, 3, 0, 120, "stalledDL") };
        host.Search.Respond = options => new() { Query = options.Query, Results = [candidate] };
        var path = $"/api/client/torrents/{hash}/alternatives";
        using var response = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(120, body.GetProperty("health").GetProperty("stalledForSeconds").GetInt64());
        var choice = Assert.Single(body.GetProperty("alternatives").EnumerateArray());
        Assert.Equal(["token", "hash", "title", "seeders", "peers", "sizeBytes", "quality", "source", "why"],
            choice.EnumerateObject().Select(p => p.Name));
        Assert.Equal(4, choice.GetProperty("peers").GetInt32());
        Assert.Equal(1080, choice.GetProperty("quality").GetInt32());
        var token = choice.GetProperty("token").GetString();
        using var foreign = await client.PostAsJsonAsync($"/api/client/torrents/{3:x40}/alternatives", new { token });
        Assert.Equal(HttpStatusCode.Conflict, foreign.StatusCode);
        Assert.Empty(host.Engine.Swaps);
        using var swapped = await client.PostAsJsonAsync(path, new { token });
        Assert.Equal(HttpStatusCode.OK, swapped.StatusCode);
        var result = await swapped.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(["ok", "message", "hash"], result.EnumerateObject().Select(p => p.Name));
        Assert.True(result.GetProperty("ok").GetBoolean());
        Assert.Equal(candidate.InfoHash, Assert.Single(host.Engine.Swaps).Request.Hash);
    }

    [Fact]
    public async Task HttpContractDistinguishesEmptyMissingInvalidAndExpired()
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        var hash = 1.ToString("x40");
        var path = $"/api/client/torrents/{hash}/alternatives";
        using var missing = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.Conflict, missing.StatusCode);
        Assert.Equal("Download no longer exists.", (await missing.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("message").GetString());
        using var expired = await client.PostAsJsonAsync(path, new { token = "expired" });
        Assert.Equal(HttpStatusCode.Conflict, expired.StatusCode);
        var refusal = await expired.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(["ok", "message"], refusal.EnumerateObject().Select(p => p.Name));
        Assert.False(refusal.GetProperty("ok").GetBoolean());
        using var invalid = await client.PostAsJsonAsync(path, new { });
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        await host.Seed(db => db.EngineTorrents.Add(new()
        {
            Id = "swap-empty", UserId = LocalUser.Id, Hash = hash, Name = "Big Buck Bunny 2008 1080p",
            Origin = "user", Status = "paused", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow, LastUsedAt = DateTime.UtcNow
        }));
        host.Engine.Info = _ => new EngineTorrentInfo { Hash = hash, Name = "Big Buck Bunny", State = "paused" };
        using var empty = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, empty.StatusCode);
        var body = await empty.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(body.GetProperty("alternatives").EnumerateArray());
        Assert.False(body.GetProperty("health").TryGetProperty("connectedSeeders", out _));
        Assert.False(body.GetProperty("health").TryGetProperty("connectedPeers", out _));
    }

    private static async Task<(LibraryHost Host, HttpClient Client, string Path)> Movie(params TorrentResult[] results)
    {
        var host = new LibraryHost();
        var client = host.CreateClient();
        var hash = 1.ToString("x40");
        await host.Seed(db => db.EngineTorrents.Add(new()
        {
            Id = "swap-best", UserId = LocalUser.Id, Hash = hash, Name = "Big Buck Bunny 2008 1080p", SizeBytes = 1000,
            Origin = "user", Status = "downloading", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow, LastUsedAt = DateTime.UtcNow
        }));
        host.Engine.Info = _ => new EngineTorrentInfo { Hash = hash, Name = "Big Buck Bunny", State = "stalledDL",
            Health = new(2, 2, 0, 300, "stalledDL") };
        host.Search.Respond = options => new() { Query = options.Query, Results = options.Sources is { Length: > 0 } only
            ? results.Where(r => only.Contains(r.Source)).ToArray() : results };
        return (host, client, $"/api/client/torrents/{hash}/alternatives");
    }

    [Fact]
    public void RankingPutsTheBestReleaseFirstWithSpecificReasons()
    {
        var ranked = ReleaseSwapService.Rank([
            Release(2, "Big Buck Bunny 2008 1080p") with { Seeders = 11, SizeBytes = 1000 },
            Release(3, "Big Buck Bunny 2008 1080p") with { Seeders = 29, SizeBytes = 1100 },
            Release(4, "Big Buck Bunny 2008 1080p") with { Seeders = 12, SizeBytes = 500 },
            Release(5, "Big Buck Bunny 2008 2160p") with { Seeders = 14, SizeBytes = 5000 }], 1080, 1000);
        Assert.Equal(["3", "4", "2", "5"], ranked.Select(r => r.Result.Id));
        Assert.Equal("Most seeders (29)", ranked[0].Why);
        Assert.Equal("Same quality, 50% smaller file", ranked[1].Why);
        Assert.Equal("Only 2160p release", ranked[3].Why);
        Assert.Equal(ranked.Count, ranked.Select(r => r.Why).Distinct().Count());
        Assert.True(ranked.Zip(ranked.Skip(1)).All(p => p.First.Score >= p.Second.Score));
        // Deterministic: input order never changes the result.
        Assert.Equal(ranked.Select(r => r.Result.Id), ReleaseSwapService.Rank(ranked.Select(r => r.Result).Reverse().ToList(), 1080, 1000).Select(r => r.Result.Id));
    }

    [Fact]
    public async Task SourceFilterSearchesOnlyThatSourceAndReportsCountsAndRecommendation()
    {
        var (host, client, path) = await Movie(
            Release(2, "Big Buck Bunny 2008 1080p") with { Seeders = 11, Source = "apibay" },
            Release(3, "Big Buck Bunny 2008 1080p") with { Seeders = 29, Source = "torrentscsv" },
            Release(4, "Big Buck Bunny 2008 1080p") with { Seeders = 8, Source = "torrentscsv" });
        using (host) using (client)
        {
            var all = await client.GetFromJsonAsync<JsonElement>(path);
            var alternatives = all.GetProperty("alternatives").EnumerateArray().ToList();
            Assert.Equal([3.ToString("x40"), 2.ToString("x40"), 4.ToString("x40")], alternatives.Select(a => a.GetProperty("hash").GetString()));
            Assert.Equal(alternatives[0].GetProperty("token").GetString(), all.GetProperty("recommendedToken").GetString());
            var counts = all.GetProperty("sources").EnumerateArray().ToDictionary(s => s.GetProperty("id").GetString()!,
                s => s.TryGetProperty("count", out var n) ? n.GetInt32() : (int?)null);
            Assert.Equal(1, counts["apibay"]);
            Assert.Equal(2, counts["torrentscsv"]);
            Assert.DoesNotContain("1337x", counts.Keys);
            Assert.Null(counts["yts"]);

            var none = await client.GetFromJsonAsync<JsonElement>(path + "?source=yts");
            Assert.Empty(none.GetProperty("alternatives").EnumerateArray());
            Assert.False(none.TryGetProperty("recommendedToken", out _));
            Assert.Equal(0, none.GetProperty("sources").EnumerateArray().Single(s => s.GetProperty("id").GetString() == "yts").GetProperty("count").GetInt32());

            var only = await client.GetFromJsonAsync<JsonElement>(path + "?source=apibay");
            Assert.Equal(["apibay"], host.Search.Requests.Last().Sources!);
            var single = Assert.Single(only.GetProperty("alternatives").EnumerateArray());
            Assert.Equal(2.ToString("x40"), single.GetProperty("hash").GetString());
            Assert.Equal(single.GetProperty("token").GetString(), only.GetProperty("recommendedToken").GetString());
            // The other source keeps its last known count instead of being dropped.
            Assert.Equal(2, only.GetProperty("sources").EnumerateArray().Single(s => s.GetProperty("id").GetString() == "torrentscsv").GetProperty("count").GetInt32());

            using var off = await client.GetAsync(path + "?source=1337x");
            Assert.Equal(HttpStatusCode.Conflict, off.StatusCode);
            Assert.Contains("turned off", (await off.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("message").GetString());
        }
    }

    [Fact]
    public async Task BestSwapPicksTheRecommendedReleaseInOneStep()
    {
        var (host, client, path) = await Movie(
            Release(2, "Big Buck Bunny 2008 1080p") with { Seeders = 11, Source = "apibay" },
            Release(3, "Big Buck Bunny 2008 1080p") with { Seeders = 29, Source = "torrentscsv" });
        using (host) using (client)
        {
            using var response = await client.PostAsJsonAsync(path, new { best = true });
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(3.ToString("x40"), Assert.Single(host.Engine.Swaps).Request.Hash);

            using var filtered = await client.PostAsJsonAsync(path, new { best = true, source = "apibay" });
            Assert.Equal(HttpStatusCode.OK, filtered.StatusCode);
            Assert.Equal(2.ToString("x40"), host.Engine.Swaps.Last().Request.Hash);
        }
    }

    [Fact]
    public async Task BestSwapRefusesWhenNothingIsBetter()
    {
        var (host, client, path) = await Movie(Release(2, "Big Buck Bunny 2008 1080p") with { Seeders = 2, Source = "apibay" });
        using (host) using (client)
        {
            using var weak = await client.PostAsJsonAsync(path, new { best = true });
            Assert.Equal(HttpStatusCode.Conflict, weak.StatusCode);
            Assert.Equal("No better release was found on any source. Your current download was kept.",
                (await weak.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("message").GetString());
            using var none = await client.PostAsJsonAsync(path, new { best = true, source = "torrentscsv" });
            Assert.Equal(HttpStatusCode.Conflict, none.StatusCode);
            Assert.Contains("on torrentscsv", (await none.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("message").GetString());
            using var off = await client.PostAsJsonAsync(path, new { best = true, source = "1337x" });
            Assert.Equal(HttpStatusCode.Conflict, off.StatusCode);
            Assert.Empty(host.Engine.Swaps);
        }
    }
    private static TorrentResult Release(int n, string title) => new()
    {
        Id = n.ToString(), Title = title, InfoHash = n.ToString("x40"),
        Magnet = $"magnet:?xt=urn:btih:{n:x40}", Seeders = 20, Source = "test", SourceUrl = "",
    };

    [Fact]
    public void PreservesSearchRankingAndExcludesCurrentTriedDuplicateWrongWorkAndQuality()
    {
        var ranked = new[] { Release(1, "Big Buck Bunny 2008 1080p"), Release(2, "Big Buck Bunny 2008 1080p"),
            Release(3, "Big Buck Bunny 2008 1080p"), Release(3, "Big Buck Bunny 2008 1080p"),
            Release(4, "Big Buck Bunny 2008 720p"), Release(5, "Other Movie 2008 1080p"),
            Release(6, "Big Buck Bunny 2008 2160p") };
        var selected = ReleaseSwapService.Select(ranked, ReleaseNames.WorkKeyFor("Big Buck Bunny", 2008),
            "Big Buck Bunny", null, null, 1080, new HashSet<string>([1.ToString("x40"), 2.ToString("x40")]));
        Assert.Equal(["3", "6"], selected.Select(r => r.Id));
    }

    [Fact]
    public void EpisodeNeverSwitchesSeasonOrAcquiresPack()
    {
        var selected = ReleaseSwapService.Select([Release(1, "Example Show S02E01 1080p"),
            Release(2, "Example Show S01E01 1080p"), Release(3, "Example Show S02 Complete 1080p"),
            Release(4, "Example Show S02E02 1080p")], "example-show", "Example Show", new EpisodeCursor(2, 1), null, 1080,
            new HashSet<string>());
        Assert.Equal("1", Assert.Single(selected).Id);
    }
}
