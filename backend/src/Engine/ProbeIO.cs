using System.Collections.Concurrent;
using MonoTorrent;
using MonoTorrent.Client;
using MonoTorrent.PiecePicking;
using MonoTorrent.PieceWriter;
using ReusableTasks;

namespace TorrentFlow.Engine;

internal sealed class ProbeIO
{
    private readonly ConcurrentDictionary<TorrentManager, int[]> selections = new();

    public void Register(TorrentManager manager) => selections[manager] = [];
    public void Select(TorrentManager manager, int[] pieces) => selections[manager] = pieces;
    public void Invalidate(TorrentManager manager) => selections.TryRemove(manager, out _);

    public IPieceRequester CreateRequester(PieceRequesterSettings settings) =>
        new Requester(new StandardPieceRequester(settings), selections);

    public IBlockCache CreateCache(IPieceWriter writer, long capacity, CachePolicy policy, MemoryPool pool) =>
        new Cache(new MemoryCache(pool, capacity, policy, writer),
            new MemoryCache(pool, 0, CachePolicy.WritesOnly, writer), selections);

    private sealed class Requester(IPieceRequester inner, ConcurrentDictionary<TorrentManager, int[]> selections) : IPieceRequester
    {
        public bool InEndgameMode => inner.InEndgameMode;
        public void Initialise(IPieceRequesterData data, IMessageEnqueuer enqueuer, ReadOnlySpan<ReadOnlyBitField> ignoring)
        {
            if (data is TorrentManager manager && selections.TryGetValue(manager, out var pieces))
            {
                var excluded = new BitField(data.PieceCount).SetAll(true);
                foreach (var piece in pieces) excluded[piece] = false;
                inner.Initialise(data, enqueuer, [.. ignoring, excluded]);
            }
            else inner.Initialise(data, enqueuer, ignoring);
        }
        public void AddRequests(ReadOnlySpan<(IRequester Peer, ReadOnlyBitField Available)> peers) => inner.AddRequests(peers);
        public void AddRequests(IRequester peer, ReadOnlyBitField available, ReadOnlySpan<ReadOnlyBitField> peers) =>
            inner.AddRequests(peer, available, peers);
        public bool ValidatePiece(IRequester peer, PieceSegment piece, out bool complete, HashSet<IRequester> peers) =>
            inner.ValidatePiece(peer, piece, out complete, peers);
        public bool IsInteresting(IRequester peer, ReadOnlyBitField field) => inner.IsInteresting(peer, field);
        public void CancelRequests(IRequester peer, int start, int end) => inner.CancelRequests(peer, start, end);
        public void RequestRejected(IRequester peer, PieceSegment piece) => inner.RequestRejected(peer, piece);
        public int CurrentRequestCount() => inner.CurrentRequestCount();
    }

    // Probe blocks bypass the shared cache entirely. Admission can therefore invalidate
    // their picker, drain disk I/O and recheck the same manager without stale cache reads.
    private sealed class Cache(IBlockCache inner, IBlockCache probe,
        ConcurrentDictionary<TorrentManager, int[]> selections) : IBlockCache
    {
        private bool IsProbe(ITorrentManagerInfo torrent) => torrent is TorrentManager manager && selections.ContainsKey(manager);
        public long CacheHits => inner.CacheHits;
        public long CacheUsed => inner.CacheUsed;
        public long Capacity => inner.Capacity;
        public CachePolicy Policy => inner.Policy;
        public IPieceWriter Writer => inner.Writer;
        public event EventHandler<BlockInfo> ReadFromCache { add => inner.ReadFromCache += value; remove => inner.ReadFromCache -= value; }
        public event EventHandler<BlockInfo> ReadThroughCache { add => inner.ReadThroughCache += value; remove => inner.ReadThroughCache -= value; }
        public event EventHandler<BlockInfo> WrittenToCache { add => inner.WrittenToCache += value; remove => inner.WrittenToCache -= value; }
        public event EventHandler<BlockInfo> WrittenThroughCache { add => inner.WrittenThroughCache += value; remove => inner.WrittenThroughCache -= value; }
        public ReusableTask<bool> ReadAsync(ITorrentManagerInfo torrent, BlockInfo block, Memory<byte> buffer) =>
            IsProbe(torrent) ? probe.ReadAsync(torrent, block, buffer) : inner.ReadAsync(torrent, block, buffer);
        public ReusableTask<bool> ReadFromCacheAsync(ITorrentManagerInfo torrent, BlockInfo block, Memory<byte> buffer) =>
            IsProbe(torrent) ? ReusableTask.FromResult(false) : inner.ReadFromCacheAsync(torrent, block, buffer);
        public ReusableTask WriteAsync(ITorrentManagerInfo torrent, BlockInfo block, Memory<byte> buffer, bool skip) =>
            IsProbe(torrent) ? probe.WriteAsync(torrent, block, buffer, true) : inner.WriteAsync(torrent, block, buffer, skip);
        public ReusableTask SetCapacityAsync(long capacity) => inner.SetCapacityAsync(capacity);
        public ReusableTask SetPolicyAsync(CachePolicy policy) => inner.SetPolicyAsync(policy);
        public async ReusableTask SetWriterAsync(IPieceWriter writer)
        {
            await inner.SetWriterAsync(writer);
            await probe.SetWriterAsync(writer);
        }
        public void Dispose() => inner.Dispose();
    }
}
