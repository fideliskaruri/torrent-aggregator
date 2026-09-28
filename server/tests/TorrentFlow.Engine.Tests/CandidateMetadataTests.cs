using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Client;

namespace TorrentFlow.Engine.Tests;

public sealed class CandidateMetadataTests
{
    [Fact]
    public async Task MetadataTimeoutDoesNotAdmitDeadCandidateOrLeavePayload()
    {
        await using var h = await EngineHarness.CreateAsync();
        h.Backend.Metadata = (_, _) => throw new OperationCanceledException("metadata deadline");
        var result = await h.Engine.AddAsync(new() { Purpose = "keep", Magnet = EngineHarness.Magnet(81), RequireMetadata = true });
        Assert.False(result.Ok);
        Assert.Contains("file list", result.Message);
        Assert.Empty(await h.RowsAsync());
        Assert.Empty(h.Backend.AddLog);
        Assert.Empty(Directory.GetFiles(h.Root, "*.mkv", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task QueuedCandidatesConfirmMetadataWithoutBypassingDownloadCap()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(new() { Purpose = "keep", Magnet = EngineHarness.Magnet(80) });
        var bytes = ExternalDownloadScannerTests.TorrentBytes("Example Show S06E25 1080p.mkv", [1, 2, 3]);
        var hash = TorrentSource.HashFromTorrent(bytes)!;
        var calls = 0;
        h.Backend.Metadata = (_, _) => { calls++; return Task.FromResult(bytes); };
        var request = new EngineAddRequest { Purpose = "keep", Magnet = $"magnet:?xt=urn:btih:{hash}", RequireMetadata = true };
        var result = await h.Engine.AddAsync(request);
        Assert.True(result.Ok, result.Message);
        Assert.Equal(EngineAddDetails.Queued, result.Details!.Action);
        Assert.Single(h.Backend.AddLog);
        Assert.Equal(EngineTorrentStatus.Queued, (await h.RowsAsync()).Single(r => r.Hash == hash).Status);
        Assert.True((await h.Engine.AddAsync(request)).Ok);
        Assert.Equal(1, calls);
        Assert.Empty(Directory.GetFiles(h.Root, "*.mkv", SearchOption.AllDirectories));
        Assert.True((await h.Engine.RemoveAsync(hash, deleteFiles: true)).Ok);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WrongMetadataIsRejectedBeforeAdmission(bool suppliedTorrent)
    {
        await using var h = await EngineHarness.CreateAsync();
        var bytes = ExternalDownloadScannerTests.TorrentBytes("other.mkv", [1]);
        h.Backend.Metadata = (_, _) => Task.FromResult(bytes);
        var result = await h.Engine.AddAsync(new() { Purpose = "keep", Magnet = EngineHarness.Magnet(82),
            TorrentBytes = suppliedTorrent ? bytes : null, RequireMetadata = true });
        Assert.False(result.Ok);
        Assert.Contains("did not match", result.Message);
        Assert.Empty(await h.RowsAsync());
    }

    [Fact]
    public async Task CancellationPropagatesWithoutAdmittingCandidate()
    {
        await using var h = await EngineHarness.CreateAsync();
        using var cts = new CancellationTokenSource();
        h.Backend.Metadata = async (_, ct) => { await cts.CancelAsync(); ct.ThrowIfCancellationRequested(); return []; };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => h.Engine.AddAsync(new()
            { Purpose = "keep", Magnet = EngineHarness.Magnet(83), RequireMetadata = true }, cts.Token));
        Assert.Empty(await h.RowsAsync());
    }

    [Fact]
    public async Task MetadataProbesHaveOneGlobalFourCandidateBound()
    {
        await using var h = await EngineHarness.CreateAsync();
        var occupied = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var active = 0;
        var peak = 0;
        var gate = new object();
        h.Backend.Metadata = async (_, ct) =>
        {
            lock (gate)
            {
                peak = Math.Max(peak, ++active);
                if (active == 4) occupied.TrySetResult();
            }
            try
            {
                await release.Task.WaitAsync(ct);
                return ExternalDownloadScannerTests.TorrentBytes("wrong.mkv", [1]);
            }
            finally { lock (gate) active--; }
        };
        var probes = Enumerable.Range(90, 8).Select(i => h.Engine.AddAsync(new()
            { Purpose = "keep", Magnet = EngineHarness.Magnet(i), RequireMetadata = true })).ToArray();
        try
        {
            await occupied.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(4, peak);
        }
        finally { release.TrySetResult(); }
        Assert.All(await Task.WhenAll(probes), result => Assert.False(result.Ok));
        Assert.Equal(4, peak);
        Assert.Empty(await h.RowsAsync());
    }
}
