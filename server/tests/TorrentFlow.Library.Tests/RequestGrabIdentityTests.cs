using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Api.Requests;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Library.Tests;

public class RequestGrabIdentityTests
{
    [Fact]
    public async Task RequestsPersistAndReuseTheCanonicalWorkBeforeSending()
    {
        using var host = new LibraryHost();
        using var http = host.CreateClient();
        await host.Settings();
        host.Search.Respond = options => new() { Query = options.Query,
            Results = [FakeSearch.Release("Example Film 2020 1080p WEB-DL")] };
        var grabber = host.Services.GetRequiredService<IRequestGrabber>();
        var request = new MediaRequest { Id = "one", WorkKey = "example-film-2020", Title = "Example Film",
            Year = 2020, MediaType = "movie", Scope = MediaRequestScope.Movie };

        Assert.Single((await grabber.GrabAsync(request, CancellationToken.None)).Hashes);
        request.Id = "two";
        Assert.Single((await grabber.GrabAsync(request, CancellationToken.None)).Hashes);

        await using var db = await host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        var work = Assert.Single(await db.Works.ToListAsync());
        Assert.Equal(request.WorkKey, work.WorkKey);
        Assert.Equal(request.Title, work.CanonicalTitle);
        Assert.Equal(2, host.Engine.Adds.Count);
        Assert.All(host.Engine.Adds, add =>
        {
            Assert.Equal(work.Id, add.WorkId);
            Assert.Equal(TorrentLane.Request, add.Lane);
        });
        Assert.Empty(await db.WatchListItems.ToListAsync());
    }
}
