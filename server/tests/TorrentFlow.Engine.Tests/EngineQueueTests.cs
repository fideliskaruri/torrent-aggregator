using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Queue;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Engine.Tests;

/// <summary>Queue integration: the engine service over a real SQLite database and a fake torrent client.</summary>
public class EngineQueueTests
{
    private static EngineAddRequest Keep(int n, string? work = "show", int? ep = null, long? size = null, bool forced = false) => new()
    {
        Magnet = EngineHarness.Magnet(n),
        Purpose = TorrentPurpose.Keep,
        WorkId = work,
        QueueKey = ep is { } e ? DownloadQueue.QueueKeyForEpisode(1, e) : null,
        ExpectedSizeBytes = size,
        Forced = forced,
    };

    [Fact]
    public async Task SeasonFanOutStartsCapAndQueuesTheRestOutsideTheClient()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        // Episodes arrive out of order, as parallel searches finish.
        foreach (var ep in new[] { 3, 1, 5, 2, 4 })
            Assert.True((await h.Engine.AddAsync(Keep(ep, ep: ep))).Ok);

        var rows = await h.RowsAsync();
        Assert.Equal(2, rows.Count(r => r.Status == "downloading"));
        Assert.Equal(3, rows.Count(r => r.Status == "queued"));
        Assert.Equal(2, h.Backend.Live.Count);
        Assert.All(rows.Where(r => r.Status == "queued"), r => Assert.False(h.Backend.Contains(r.Hash)));

        var list = await h.Engine.ListAsync();
        var queued = list.Where(t => t.State == "queued").OrderBy(t => t.QueuePosition).Select(t => t.Hash).ToList();
        Assert.Equal([EngineHarness.Hash(2), EngineHarness.Hash(4), EngineHarness.Hash(5)], queued);
    }

    [Fact]
    public async Task QueuedAddReportsPositionAndAction()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(Keep(1, ep: 1));
        var r = await h.Engine.AddAsync(Keep(2, ep: 2));
        Assert.True(r.Ok);
        Assert.Equal("queued", r.Details!.Action);
        Assert.Equal(1, r.Details.QueuePosition);
        Assert.Equal("Queued — #1 in line", r.Message);
        var again = await h.Engine.AddAsync(Keep(2, ep: 2));
        Assert.Equal("queued", again.Details!.Action);
    }

    [Fact]
    public async Task StreamsAndPrewarmBypassTheQueue()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(Keep(1));
        var s = await h.Engine.AddAsync(new EngineAddRequest { Magnet = EngineHarness.Magnet(2), Purpose = TorrentPurpose.Stream });
        var p = await h.Engine.AddAsync(new EngineAddRequest { Magnet = EngineHarness.Magnet(3), Purpose = TorrentPurpose.Prewarm });
        Assert.Equal("started", s.Details!.Action);
        Assert.Equal("started", p.Details!.Action);
        Assert.Equal(3, h.Backend.Live.Count);
        Assert.Equal("stream", (await h.RowAsync(2)).Origin);
    }

    [Fact]
    public async Task CompletionParksTheTransferAndPromotesTheNextEpisode()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(Keep(1, ep: 1));
        await h.Engine.AddAsync(Keep(2, ep: 2));
        EngineTorrentCompletedEventArgs? done = null;
        h.Engine.TorrentCompleted += (_, e) => done = e;

        h.Backend.Complete(EngineHarness.Hash(1));
        await h.Engine.TickAsync();

        var first = await h.RowAsync(1);
        Assert.Equal("parked", first.Status);
        Assert.NotNull(first.VerifiedAt);
        Assert.Equal(1, first.Progress);
        Assert.False(h.Backend.Contains(first.Hash));
        Assert.Equal(first.Hash, done?.Hash);
        Assert.Equal("downloading", (await h.RowAsync(2)).Status);
        Assert.True(h.Backend.Contains(EngineHarness.Hash(2)));
        Assert.Equal("downloaded", (await h.Engine.GetAsync(first.Hash))!.State);
    }

    [Fact]
    public async Task PauseFreesTheSlotAndPromotes()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(Keep(1, ep: 1));
        await h.Engine.AddAsync(Keep(2, ep: 2));
        Assert.Equal("Paused", (await h.Engine.PauseAsync(EngineHarness.Hash(1))).Message);
        Assert.Equal("paused", (await h.RowAsync(1)).Status);
        Assert.Equal("downloading", (await h.RowAsync(2)).Status);

        // Resuming while the slot is taken waits in the queue instead of exceeding the cap.
        var resumed = await h.Engine.ResumeAsync(EngineHarness.Hash(1));
        Assert.StartsWith("Queued", resumed.Message);
        Assert.Equal("queued", (await h.RowAsync(1)).Status);
    }

    [Fact]
    public async Task DeleteFreesTheSlotAndPromotesAndRemovesFiles()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(Keep(1, ep: 1));
        await h.Engine.AddAsync(Keep(2, ep: 2));
        var file = h.Backend.Get(EngineHarness.Hash(1))!.Files[0].FullPath;
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        await File.WriteAllBytesAsync(file, [1, 2, 3]);

        Assert.True((await h.Engine.RemoveAsync(EngineHarness.Hash(1), deleteFiles: true)).Ok);
        Assert.False(File.Exists(file));
        Assert.DoesNotContain(await h.RowsAsync(), r => r.Hash == EngineHarness.Hash(1));
        Assert.Equal("downloading", (await h.RowAsync(2)).Status);
    }

    [Fact]
    public async Task DeleteWithoutFilesKeepsMedia()
    {
        await using var h = await EngineHarness.CreateAsync();
        await h.Engine.AddAsync(Keep(1));
        var file = h.Backend.Get(EngineHarness.Hash(1))!.Files[0].FullPath;
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        await File.WriteAllBytesAsync(file, [1]);
        await h.Engine.RemoveAsync(EngineHarness.Hash(1), deleteFiles: false);
        Assert.True(File.Exists(file));
    }

    [Fact]
    public async Task DeletingAQueuedRowNeverTouchesTheClient()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(Keep(1, ep: 1));
        await h.Engine.AddAsync(Keep(2, ep: 2));
        await h.Engine.RemoveAsync(EngineHarness.Hash(2), deleteFiles: true);
        Assert.Single(await h.RowsAsync());
        Assert.Equal([EngineHarness.Hash(1)], h.Backend.AddLog);
    }

    [Fact]
    public async Task FailurePromotesTheNextItem()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(Keep(1, ep: 1));
        await h.Engine.AddAsync(Keep(2, ep: 2));
        h.Backend.Update(EngineHarness.Hash(1), s => s with { State = "error", Error = "disk full" });
        await h.Engine.TickAsync();
        var failed = await h.RowAsync(1);
        Assert.Equal("error", failed.Status);
        Assert.Equal("disk full", failed.Error);
        Assert.Equal("downloading", (await h.RowAsync(2)).Status);
    }

    [Fact]
    public async Task FailedAddPromotesAndReportsTheMessage()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        h.Backend.AddOverride = spec => spec.Hash == EngineHarness.Hash(1) ? new(false, "Timed out waiting for torrent metadata") : null;
        var r = await h.Engine.AddAsync(Keep(1));
        Assert.False(r.Ok);
        Assert.Equal("error", (await h.RowAsync(1)).Status);
        Assert.Equal("started", (await h.Engine.AddAsync(Keep(2))).Details!.Action);
    }

    [Fact]
    public async Task ForceStartsImmediatelyPastTheCap()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(Keep(1, ep: 1));
        await h.Engine.AddAsync(Keep(2, ep: 2));
        await h.Engine.AddAsync(Keep(3, ep: 3));

        var r = await h.Engine.ForceAsync(EngineHarness.Hash(3));
        Assert.True(r.Ok);
        var row = await h.RowAsync(3);
        Assert.Equal("downloading", row.Status);
        Assert.NotNull(row.ForcedAt);
        Assert.Equal(2, h.Backend.Live.Count);
        Assert.Equal("queued", (await h.RowAsync(2)).Status);

        // A forced add also bypasses the cap.
        var forcedAdd = await h.Engine.AddAsync(Keep(4, forced: true));
        Assert.Equal("started", forcedAdd.Details!.Action);
        Assert.Equal(3, h.Backend.Live.Count);
    }

    [Fact]
    public async Task RehydrateStartsOnlyActiveAndForcedWithinTheCap()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        await using (var db = await h.Db.CreateDbContextAsync())
        {
            var t0 = DateTime.UtcNow.AddHours(-1);
            EngineTorrent Row(int n, string status, int ep, DateTime? forced = null, string origin = "user") => new()
            {
                Id = Data.Ids.New(), UserId = Data.LocalUser.Id, Hash = EngineHarness.Hash(n), Name = "n" + n, Magnet = EngineHarness.Magnet(n),
                Status = status, Origin = origin, WorkId = "show", QueueKey = DownloadQueue.QueueKeyForEpisode(1, ep), ForcedAt = forced,
                CreatedAt = t0.AddSeconds(n), UpdatedAt = t0, LastUsedAt = t0, SavePath = Path.Combine(h.Root, "downloads"),
            };
            // A pre-queue database: a whole season marked downloading, one forced, a paused one and a stream.
            for (var i = 1; i <= 6; i++) db.EngineTorrents.Add(Row(i, "downloading", i));
            db.EngineTorrents.Add(Row(7, "queued", 7, forced: t0));
            db.EngineTorrents.Add(Row(8, "paused", 8));
            db.EngineTorrents.Add(Row(9, "downloading", 1, origin: "stream"));
            await db.SaveChangesAsync();
        }

        await h.Engine.RehydrateAsync();

        Assert.Equal([EngineHarness.Hash(7), EngineHarness.Hash(1)], h.Backend.AddLog.Order().Reverse().ToList());
        var rows = await h.RowsAsync();
        Assert.Equal(5, rows.Count(r => r.Status == "queued"));
        Assert.Equal("paused", rows.Single(r => r.Hash == EngineHarness.Hash(8)).Status);
        Assert.False(h.Backend.Contains(EngineHarness.Hash(9)));
    }

    [Fact]
    public async Task StorageBudgetCountsQueuedSizes()
    {
        const long gb = 1_000_000_000;
        await using var h = await EngineHarness.CreateAsync(cap: 1, maxStorageBytes: 10 * gb);
        Assert.True((await h.Engine.AddAsync(Keep(1, size: 3 * gb))).Ok);
        Assert.True((await h.Engine.AddAsync(Keep(2, size: 3 * gb))).Ok);   // queued: reserves 3 GB
        Assert.True((await h.Engine.AddAsync(Keep(3, size: 3 * gb))).Ok);   // queued: reserves 6 GB
        Assert.Equal(6 * gb, await h.Engine.QueuedReservedBytesAsync());

        // Nothing is on disk yet, but 6 GB is promised: another 5 GB must not fit a 10 GB cap.
        var refused = await h.Engine.AddAsync(Keep(4, size: 5 * gb));
        Assert.False(refused.Ok);
        Assert.Equal("cap", refused.StorageLimit);
        var overridden = await h.Engine.AddAsync(Keep(4, size: 5 * gb) with { OverrideStorageCap = true });
        Assert.True(overridden.Ok);
    }

    [Fact]
    public async Task StorageSetupIsRequiredForKeptDownloads()
    {
        await using var h = await EngineHarness.CreateAsync(maxStorageBytes: null);
        var r = await h.Engine.AddAsync(Keep(1));
        Assert.False(r.Ok);
        Assert.Equal("setup", r.StorageLimit);
        Assert.Equal(Storage.StorageBudget.SetupRequiredMessage, r.Message);
    }

    [Fact]
    public async Task DuplicateAddReportsAlreadyDownloadingAndPlayPromotesOriginOnlyUpward()
    {
        await using var h = await EngineHarness.CreateAsync();
        await h.Engine.AddAsync(new EngineAddRequest { Magnet = EngineHarness.Magnet(1), Purpose = TorrentPurpose.Stream });
        var keep = await h.Engine.AddAsync(Keep(1));
        Assert.Equal("already_downloading", keep.Details!.Action);
        Assert.Equal("user", (await h.RowAsync(1)).Origin);
        Assert.True(h.Backend.Get(EngineHarness.Hash(1))!.Files.All(f => f.Selected));
        await h.Engine.AddAsync(new EngineAddRequest { Magnet = EngineHarness.Magnet(1), Purpose = TorrentPurpose.Stream });
        Assert.Equal("user", (await h.RowAsync(1)).Origin);
    }

    [Fact]
    public async Task DownloadedFilesCannotBePaused()
    {
        await using var h = await EngineHarness.CreateAsync();
        await h.Engine.AddAsync(Keep(1));
        h.Backend.Complete(EngineHarness.Hash(1));
        await h.Engine.TickAsync();
        var r = await h.Engine.PauseAsync(EngineHarness.Hash(1));
        Assert.False(r.Ok);
        Assert.Equal("Downloaded files cannot be paused.", r.Message);
        Assert.Equal("already_complete", (await h.Engine.AddAsync(Keep(1))).Details!.Action);
    }

    [Fact]
    public async Task ParkedDownloadStreamsFromDisk()
    {
        await using var h = await EngineHarness.CreateAsync();
        await h.Engine.AddAsync(Keep(1));
        h.Backend.Complete(EngineHarness.Hash(1));
        await h.Engine.TickAsync();
        await using var s = await h.Engine.OpenFileStreamAsync(EngineHarness.Hash(1), "0");
        Assert.True(s.CanSeek);
        Assert.Equal(1000, s.Length);
    }

    [Fact]
    public void MissingSourceIsRejected()
    {
        Assert.Null(Client.TorrentSource.HashFromMagnet("magnet:?dn=nothing"));
        Assert.Equal(new string('a', 40), Client.TorrentSource.NormalizeInfoHash(new string('A', 40)));
        Assert.Null(Client.TorrentSource.NormalizeInfoHash("xyz"));
    }

    [Fact]
    public void PrivateTrackersAreNotWidened()
    {
        var priv = "magnet:?xt=urn:btih:" + new string('a', 40) + "&tr=" + Uri.EscapeDataString("http://192.168.1.5:8000/announce");
        Assert.Equal(priv, Client.TorrentSource.WidenTrackers(priv, ["udp://tracker.opentrackr.org:1337/announce"]));
        var pub = "magnet:?xt=urn:btih:" + new string('a', 40);
        Assert.Contains("opentrackr", Client.TorrentSource.WidenTrackers(pub, ["udp://tracker.opentrackr.org:1337/announce"]));
    }
}
