using MonoTorrent;
using MonoTorrent.Client;

namespace TorrentFlow.Engine.Client;

/// <summary>
/// MonoTorrent's StreamProvider allows one open stream per torrent, but HTTP range serving needs several at once
/// (a player's abandoned request is still draining while its seek arrives; subtitles read sidecars mid-playback).
/// This hands out independent seekable readers that share the single provider stream, serialising their reads and
/// re-targeting the provider stream when readers of different files interleave.
/// </summary>
internal sealed class SharedTorrentStreams(TorrentManager manager)
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private Stream? _current;
    private ITorrentManagerFile? _currentFile;
    private int _readers;

    public async Task<Stream> OpenAsync(ITorrentManagerFile file, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await EnsureAsync(file, ct);
            _readers++;
            return new Reader(this, file);
        }
        finally { _gate.Release(); }
    }

    private async Task EnsureAsync(ITorrentManagerFile file, CancellationToken ct)
    {
        if (_current is not null && ReferenceEquals(_currentFile, file)) return;
        if (_current is not null) await _current.DisposeAsync();
        _current = null;
        _currentFile = null;
        _current = await manager.StreamProvider!.CreateStreamAsync(file, prebuffer: false, ct);
        _currentFile = file;
    }

    private async ValueTask<int> ReadAsync(ITorrentManagerFile file, long position, Memory<byte> buffer, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await EnsureAsync(file, ct);
            if (_current!.Position != position) _current.Seek(position, SeekOrigin.Begin);
            return await _current.ReadAsync(buffer, ct);
        }
        finally { _gate.Release(); }
    }

    private async ValueTask ReleaseAsync()
    {
        await _gate.WaitAsync();
        try
        {
            if (--_readers > 0 || _current is null) return;
            await _current.DisposeAsync();
            _current = null;
            _currentFile = null;
        }
        finally { _gate.Release(); }
    }

    private sealed class Reader(SharedTorrentStreams owner, ITorrentManagerFile file) : Stream
    {
        private long _position;
        private int _disposed;

        public override bool CanRead => _disposed == 0;
        public override bool CanSeek => _disposed == 0;
        public override bool CanWrite => false;
        public override long Length => file.Length;

        public override long Position
        {
            get => _position;
            set => Seek(value, SeekOrigin.Begin);
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            var target = origin switch
            {
                SeekOrigin.Begin => offset,
                SeekOrigin.Current => _position + offset,
                _ => file.Length + offset,
            };
            ArgumentOutOfRangeException.ThrowIfNegative(target, nameof(offset));
            return _position = target;
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            ObjectDisposedException.ThrowIf(_disposed != 0, this);
            if (_position >= file.Length || buffer.Length == 0) return 0;
            var read = await owner.ReadAsync(file, _position, buffer, cancellationToken);
            _position += read;
            return read;
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult();

        public override void Flush() { }
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0) owner.ReleaseAsync().AsTask().GetAwaiter().GetResult();
            base.Dispose(disposing);
        }

        public override async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0) await owner.ReleaseAsync();
            GC.SuppressFinalize(this);
        }
    }
}
