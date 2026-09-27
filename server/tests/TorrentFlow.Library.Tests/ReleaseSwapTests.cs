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
