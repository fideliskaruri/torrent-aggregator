using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Media.Features.Prewarm;

/// <summary>
/// The real <see cref="ISwarmProbeEngine"/>: measures swarms through the built-in torrent engine.
///
/// <see cref="FindLiveAsync"/> reads a transfer the engine is actively running. A transfer the engine holds but is
/// not running (queued, paused, parked, errored) reads "unknown", never "absent": absence is the permission to open
/// a probe, and a probe on a held hash would dedupe onto the user's own download.
///
/// <see cref="OpenIsolatedAsync"/> adds the magnet with purpose=prewarm (which bypasses the download queue and is
/// born evictable). Only a transfer this probe actually started is removed — with its partial data — on dispose; a
/// dedupe onto an existing transfer is read but never destroyed.
/// </summary>
public sealed class EngineSwarmProbeEngine(ITorrentEngine engine, ILogger<EngineSwarmProbeEngine> logger) : ISwarmProbeEngine
{
    internal static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(250);
    private ITorrentEngine Engine => engine;
    private ILogger Logger => logger;

    private static readonly HashSet<string> LiveStates = new(StringComparer.Ordinal) { "downloading", "stalledDL", "metaDL", "checkingDL" };

    public async Task<SwarmLiveState> FindLiveAsync(string infoHash, CancellationToken cancellationToken)
    {
        if (ReleaseText.NormalizeInfoHash(infoHash) is not { } hash) return new("unknown");
        try
        {
            var info = await engine.GetAsync(hash, cancellationToken);
            if (info is null) return new("absent");
            return LiveStates.Contains(info.State) ? new("live", ToSnapshot(info)) : new("unknown");
        }
        catch (Exception e) when (!cancellationToken.IsCancellationRequested)
        {
            // Could not run the check at all: we do NOT know there is no live download.
            logger.LogDebug(e, "Swarm liveness check failed for {Hash}", hash);
            return new("unknown");
        }
    }

    public async Task<IIsolatedSwarmProbe> OpenIsolatedAsync(string magnet, CancellationToken cancellationToken)
    {
        var hash = ReleaseText.InfoHashFromMagnet(magnet) ?? throw new ArgumentException("magnet must contain a valid BitTorrent info hash", nameof(magnet));
        // A failed add (metadata timeout) still leaves an error row behind; one this probe created must not surface
        // in the owner's downloads as a "swarm probe" transfer.
        var heldBefore = await engine.GetAsync(hash, cancellationToken) is not null;
        // The engine resolves metadata inside AddAsync and does not observe cancellation there, so the add runs
        // detached: if the caller gives up first, a transfer this probe started is still removed when it lands.
        var add = engine.AddAsync(new EngineAddRequest { Magnet = magnet, Purpose = TorrentPurpose.Prewarm, Name = "swarm probe" }, CancellationToken.None);
        EngineAddResult result;
        try
        {
            result = await add.WaitAsync(cancellationToken);
        }
        catch (OperationCanceledException)
        {
            _ = add.ContinueWith(async t =>
            {
                if (t.IsCompletedSuccessfully && (StartedByUs(t.Result) || !t.Result.Ok && !heldBefore)) await RemoveQuietlyAsync(t.Result.Hash ?? hash);
            }, TaskScheduler.Default).Unwrap();
            throw;
        }
        if (!result.Ok)
        {
            if (!heldBefore) await RemoveQuietlyAsync(result.Hash ?? hash);
            throw new InvalidOperationException(result.Message);
        }
        var probe = new Probe(this, result.Hash ?? hash, StartedByUs(result));
        await probe.RefreshAsync(cancellationToken);
        probe.StartPolling();
        return probe;
    }

    private static bool StartedByUs(EngineAddResult result) => result.Ok && result.Details?.Action == EngineAddDetails.Started;

    internal static SwarmSnapshot ToSnapshot(EngineTorrentInfo info)
    {
        var size = info.SizeBytes > 0 ? info.SizeBytes : (long?)null;
        var hasMetadata = info.State != "metaDL" && size is > 0;
        var bytes = hasMetadata ? (long)Math.Round(size!.Value * Math.Clamp(double.IsFinite(info.Progress) ? info.Progress : 0, 0, 1)) : 0;
        var peers = Math.Max(0, info.Peers ?? 0);
        // The engine reports connected peers but no per-wire counters; a peer "counts" as unchoked only once bytes
        // arrive, so this is an upper bound that stays zero for a swarm that chokes us forever.
        var unchoked = bytes > 0 || info.Dlspeed > 0 ? peers : 0;
        return new SwarmSnapshot(hasMetadata, peers, unchoked, bytes, Math.Max(0, info.Dlspeed), size);
    }

    private async Task RemoveQuietlyAsync(string hash)
    {
        try
        {
            var removed = await engine.RemoveAsync(hash, deleteFiles: true, CancellationToken.None);
            if (!removed.Ok) logger.LogDebug("Swarm probe teardown for {Hash}: {Message}", hash, removed.Message);
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "Swarm probe teardown failed for {Hash}", hash);
        }
    }

    private sealed class Probe(EngineSwarmProbeEngine owner, string hash, bool owned) : IIsolatedSwarmProbe
    {
        private readonly CancellationTokenSource _stop = new();
        private Task? _poll;
        private volatile SwarmSnapshot _snapshot = new(false, 0, 0, 0, 0);

        public SwarmSnapshot Snapshot => _snapshot;

        public async Task RefreshAsync(CancellationToken ct)
        {
            if (await owner.Engine.GetAsync(hash, ct) is { } info) _snapshot = ToSnapshot(info);
        }

        public void StartPolling() => _poll = Task.Run(async () =>
        {
            while (!_stop.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(PollInterval, _stop.Token);
                    await RefreshAsync(_stop.Token);
                }
                catch (OperationCanceledException) { break; }
                catch (Exception e) { owner.Logger.LogDebug(e, "Swarm probe poll failed for {Hash}", hash); }
            }
        });

        public async ValueTask DisposeAsync()
        {
            await _stop.CancelAsync();
            if (_poll is not null) await _poll;
            _stop.Dispose();
            // Only a transfer this probe started may be destroyed; a dedupe onto an existing one is never touched.
            if (owned) await owner.RemoveQuietlyAsync(hash);
        }
    }
}
