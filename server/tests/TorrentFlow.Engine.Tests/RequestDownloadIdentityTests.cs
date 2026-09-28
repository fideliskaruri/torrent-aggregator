using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Engine.Tests;

public class RequestDownloadIdentityTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RequestDownloadsHaveOneCanonicalIdentityBeforeAndAfterUpgrade(bool linkedWork)
    {
        using var app = new ApiFactory();
        using var http = app.CreateClient();
        await http.PutAsJsonAsync("/api/settings/client", new { baseDownloadPath = Path.Combine(app.Root, "downloads"), maxStorageBytes = 1L << 40 });
        var factory = app.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();
        const string key = "frieren-beyond-journeys-end";
        const string title = "Frieren: Beyond Journey's End";
        var now = DateTime.UtcNow;
        await using (var db = await factory.CreateDbContextAsync())
        {
            if (linkedWork)
                db.Works.Add(new Work { Id = "frieren", WorkKey = key, CanonicalTitle = title, MediaType = "tv", Year = 2023, CreatedAt = now, UpdatedAt = now });
            db.MediaRequests.Add(new MediaRequest { Id = "request", RequestedByUserId = LocalUser.Id, WorkKey = key, Title = title,
                Provider = "tvmaze", ProviderId = "69956", MediaType = "tv", Scope = "series", Status = "approved",
                Year = 2023, CreatedAt = now, UpdatedAt = now,
                // New grabs carry identity even before the whole fanout has returned its hashes.
                GrabbedHashes = linkedWork ? null : $"{EngineHarness.Hash(901).ToUpperInvariant()}, {EngineHarness.Hash(902)}" });
            foreach (var (n, name) in new[] {
                (901, "[Yameii] Frieren - Beyond Journey's End - S01E11 [English Dub] [CR WEB-DL 1080p].mkv"),
                (902, "www.UIndex.org - Frieren Beyond Journeys End S02E01 1080p WEB-DL"),
                (903, "Unrelated Show S01E01 1080p") })
                db.EngineTorrents.Add(new EngineTorrent { Id = $"transfer-{n}", UserId = LocalUser.Id, Hash = EngineHarness.Hash(n),
                    Name = name, Status = "paused", Origin = "user", SavePath = Path.Combine(app.Root, "downloads"),
                    WorkId = linkedWork && n != 903 ? "frieren" : null, CreatedAt = now, UpdatedAt = now, LastUsedAt = now });
            await db.SaveChangesAsync();
        }
        var payload = await http.GetFromJsonAsync<JsonElement>("/api/client/torrents");
        var rows = payload.GetProperty("torrents").EnumerateArray().ToList();
        Assert.Equal(3, rows.Count);
        foreach (var row in rows.Where(r => r.GetProperty("hash").GetString() != EngineHarness.Hash(903)))
        {
            Assert.Equal(key, row.GetProperty("workKey").GetString());
            Assert.Equal(title, row.GetProperty("workTitle").GetString());
            Assert.Equal("tv", row.GetProperty("workMediaType").GetString());
            Assert.False(row.TryGetProperty("targetScope", out _));
            Assert.False(row.TryGetProperty("season", out _));
        }
        var unrelated = rows.Single(r => r.GetProperty("hash").GetString() == EngineHarness.Hash(903));
        Assert.False(unrelated.TryGetProperty("workKey", out _));
        await using var check = await factory.CreateDbContextAsync();
        Assert.Empty(await check.WatchListItems.ToListAsync());
        Assert.Empty(await check.AcquisitionTargets.ToListAsync());
    }
}
