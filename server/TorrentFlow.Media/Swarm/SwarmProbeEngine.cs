using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Media.Common;

namespace TorrentFlow.Media.Swarm;

/// <summary>
/// The engine-backed <see cref="ISwarmProbeEngine"/> (replaces the Search module's no-op). Liveness is answered from
/// the engine's own view of the hash; an isolated probe adds the magnet as a prewarm transfer into a dedicated
/// <c>swarm-probe</c> directory and, on dispose, removes it with its data only when this probe created it.
/// </summary>
public sealed class SwarmProbeEngine(ITorrentEngine engine, MediaPaths paths, ILogger<SwarmProbeEngine> logger) : ISwarmProbeEngine
{
    internal static readonly TimeSpan RefreshInterval = TimeSpan.FromMilliseconds(250);

    public string ProbeRoot => Path.Combine(paths.SessionsDir, "swarm-probe");

    public async Task<SwarmLiveState> FindLiveAsync(string infoHash, CancellationToken cancellationToken)
    {
        var hash = InfoHashes.Normalize(infoHash);
        if (hash is null) return new SwarmLiveState("unknown");
        try
        {
            var info = await engine.GetAsync(hash, cancellationToken);
            return info is null ? new SwarmLiveState("absent") : new SwarmLiveState("live", SnapshotOf(info));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug(ex, "[swarm-probe] liveness check failed for {Hash}", hash);
            return new SwarmLiveState("unknown");
        }
    }

    public async Task<IIsolatedSwarmProbe> OpenIsolatedAsync(string magnet, CancellationToken cancellationToken)
    {
        var hash = InfoHashes.FromMagnet(magnet) ?? throw new ArgumentException("magnet has no btih info hash", nameof(magnet));
        var dir = Path.Combine(ProbeRoot, hash);
        Directory.CreateDirectory(dir);
        var added = await engine.AddAsync(new EngineAddRequest { Magnet = magnet, Purpose = TorrentPurpose.Prewarm, SavePath = dir }, cancellationToken);
        if (!added.Ok) throw new InvalidOperationException($"swarm probe could not attach: {added.Message}");
        var created = added.Details?.Action == EngineAddDetails.Started;
        var probe = new IsolatedProbe(engine, added.Hash ?? hash, dir, created, logger);
        probe.Start();
        return probe;
    }

    internal static SwarmSnapshot SnapshotOf(EngineTorrentInfo info)
    {
        var peers = Math.Max(0, info.Peers ?? 0);
        var bytes = Math.Max(0, info.BytesReceived ?? (long)(info.Progress * info.SizeBytes));
        // The engine summary exposes no per-peer byte counts; a positive download rate proves at least one sender.
        var unchoked = info.Dlspeed > 0 && peers > 0 ? 1 : 0;
        return new SwarmSnapshot(info.Files is { Count: > 0 }, peers, unchoked, bytes, Math.Max(0, info.Dlspeed), info.SizeBytes > 0 ? info.SizeBytes : null);
    }

    private sealed class IsolatedProbe(ITorrentEngine engine, string hash, string dir, bool createdByProbe, ILogger logger) : IIsolatedSwarmProbe
    {
        private readonly CancellationTokenSource _stop = new();
        private Task? _loop;
        private volatile SwarmSnapshot _snapshot = new(false, 0, 0, 0, 0);

        public SwarmSnapshot Snapshot => _snapshot;

        public void Start() => _loop = Task.Run(async () =>
        {
            while (!_stop.IsCancellationRequested)
            {
                try
                {
                    if (await engine.GetAsync(hash, _stop.Token) is { } info) _snapshot = SnapshotOf(info);
                    await Task.Delay(RefreshInterval, _stop.Token);
                }
                catch (OperationCanceledException) { return; }
                catch (Exception ex) { logger.LogDebug(ex, "[swarm-probe] snapshot refresh failed"); }
            }
        });

        public async ValueTask DisposeAsync()
        {
            await _stop.CancelAsync();
            if (_loop is not null) await _loop.ConfigureAwait(false);
            _stop.Dispose();
            if (!createdByProbe) return;
            try { await engine.RemoveAsync(hash, deleteFiles: true); }
            catch (Exception ex) { logger.LogWarning("[swarm-probe] could not remove probe torrent {Hash}: {Error}", hash, ex.Message); }
            try { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
    }
}
