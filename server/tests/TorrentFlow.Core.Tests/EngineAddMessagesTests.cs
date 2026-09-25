using TorrentFlow.Core.Contracts.Engine;

namespace TorrentFlow.Core.Tests;

/// <summary>Parity with src/lib/clients/messages.test.ts.</summary>
public sealed class EngineAddMessagesTests
{
    [Theory]
    [InlineData(EngineAddDetails.Started, 12, 1, "Download started (12% · 1 peer)")]
    [InlineData(EngineAddDetails.AlreadyDownloading, 40, 2, "Download already in progress (40% · 2 peers)")]
    [InlineData(EngineAddDetails.AlreadyComplete, 100, 99, "Already complete (100%)")]
    [InlineData(EngineAddDetails.AlreadyDownloading, 51.6, 2, "Download already in progress (52% · 2 peers)")]
    public void BuiltinTransfersUseTheOwnerFacingCopy(string action, double pct, int peers, string expected) =>
        Assert.Equal(expected, EngineAddMessages.Format(new EngineAddResult(true, "", new EngineAddDetails(action, pct, peers))));

    [Fact]
    public void QueuedAddsKeepTheQueueMessage() =>
        Assert.Equal("Queued — #2 in line", EngineAddMessages.Format(
            new EngineAddResult(true, "Queued — #2 in line", new EngineAddDetails(EngineAddDetails.Queued, 0, 0, 2))));

    [Fact]
    public void ExternalAndFailedMessagesPassThrough()
    {
        Assert.Equal("Added to qBittorrent", EngineAddMessages.Format(new EngineAddResult(true, "Added to qBittorrent")));
        Assert.Equal("Timed out", EngineAddMessages.Format(new EngineAddResult(false, "Timed out", new EngineAddDetails(EngineAddDetails.Started, 0, 0))));
    }
}
