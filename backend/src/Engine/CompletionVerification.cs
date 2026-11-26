using System.Buffers;
using System.Collections.Immutable;
using System.Security.Cryptography;
using TorrentFlow.Domain;

namespace TorrentFlow.Engine;

public sealed partial class MonoTorrentEngine
{
    private readonly SemaphoreSlim verificationGate = new(1, 1);
    private readonly System.Collections.Concurrent.ConcurrentDictionary<(string Hash, int File), (string Message, DateTimeOffset At)> verificationWarnings = new();

    // Authenticated metadata is captured once. Supplied streams remain owned by the publication guard.
    public async Task<ImmutableArray<VerifiedPayload>> VerifyFilesAsync(string hash,
        ImmutableArray<FileBinding> bindings, CancellationToken ct, IReadOnlyDictionary<int, Stream>? openedFiles = null)
    {
        await verificationGate.WaitAsync(ct);
        try
        {
            var torrent = await LoadCachedTorrentAsync(hash)
                ?? throw new IOException("The original torrent metadata is required to verify these files.");
            var hashes = torrent.CreatePieceHashes();
            var files = torrent.Files;
            var offsets = files.Select(f => f.OffsetInTorrent).ToArray();
            var paths = bindings.ToDictionary(b => b.FileIndex);
            // Reuse only within this guarded call. Never cache path-based verification across mutations.
            var sharedPieces = openedFiles is not null && bindings.Where(b => b.Selected).All(b => openedFiles.ContainsKey(b.FileIndex))
                ? bindings.Where(b => b.Selected && b.FileIndex >= 0 && b.FileIndex < files.Count && files[b.FileIndex].Length > 0)
                    .SelectMany(b => new[] { files[b.FileIndex].StartPieceIndex, files[b.FileIndex].EndPieceIndex }.Distinct())
                    .GroupBy(p => p).Where(g => g.Count() > 1).Select(g => g.Key).ToHashSet()
                : [];
            var verifiedSharedPieces = new HashSet<int>();
            var output = ImmutableArray.CreateBuilder<VerifiedPayload>();
            var buffer = ArrayPool<byte>.Shared.Rent(128 * 1024);
            try
            {
                foreach (var binding in bindings.Where(b => b.Selected))
                {
                    ct.ThrowIfCancellationRequested();
                    try
                    {
                        if (binding.FileIndex < 0 || binding.FileIndex >= files.Count)
                            throw new InvalidDataException("The reserved file is not in this torrent.");
                        var file = files[binding.FileIndex];
                        if (openedFiles?.ContainsKey(binding.FileIndex) != true) RefusePayloadLinks(binding.AbsolutePath);
                        using var ownSelected = openedFiles?.ContainsKey(binding.FileIndex) == true ? null :
                            new FileStream(binding.AbsolutePath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete,
                                128 * 1024, FileOptions.SequentialScan);
                        var selectedStream = ownSelected ?? openedFiles![binding.FileIndex];
                        if (selectedStream.Length != file.Length) throw new InvalidDataException("The selected completed file changed size.");
                        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                        var firstPiece = file.StartPieceIndex;
                        var lastPiece = file.EndPieceIndex;
                        for (var piece = firstPiece; piece <= lastPiece && file.Length > 0; piece++)
                        {
                            // Pure v2 has per-file piece numbering but compact physical offsets.
                            // V1/hybrid offsets include the authenticated cross-file padding.
                            var v2Only = torrent.InfoHashes.V1 is null;
                            var start = v2Only ? file.OffsetInTorrent + (long)(piece - firstPiece) * torrent.PieceLength
                                : (long)piece * torrent.PieceLength;
                            var count = (int)Math.Min(torrent.PieceLength,
                                (v2Only ? file.OffsetInTorrent + file.Length : torrent.Size) - start);
                            if (verifiedSharedPieces.Contains(piece))
                            {
                                var held = openedFiles![binding.FileIndex];
                                if (held.Length != file.Length) throw new IOException("A guarded file changed size.");
                                var end = Math.Min(start + count, file.OffsetInTorrent + file.Length);
                                for (var position = Math.Max(start, file.OffsetInTorrent); position < end;)
                                {
                                    var length = (int)Math.Min(buffer.Length, end - position);
                                    held.Position = position - file.OffsetInTorrent;
                                    await held.ReadExactlyAsync(buffer.AsMemory(0, length), ct);
                                    DeletionMeasurement.Add("verifyReadBytes", length);
                                    digest.AppendData(buffer.AsSpan(0, length));
                                    position += length;
                                }
                                continue;
                            }
                            DeletionMeasurement.Add("verifyPiecePasses");
                            var expected = hashes.GetHash(piece);
                            using var sha1 = IncrementalHash.CreateHash(HashAlgorithmName.SHA1);
                            var merkle = new MerkleAccumulator();
                            var index = Array.BinarySearch(offsets, start);
                            if (index < 0) index = Math.Max(0, ~index - 1);
                            for (var position = start; position < start + count;)
                            {
                                while (index + 1 < files.Count && offsets[index + 1] <= position) index++;
                                var part = files[index];
                                var dataEnd = part.OffsetInTorrent + part.Length;
                                var length = (int)Math.Min(buffer.Length, start + count - position);
                                if (position < dataEnd) length = (int)Math.Min(length, dataEnd - position);
                                else if (index + 1 < files.Count) length = (int)Math.Min(length, offsets[index + 1] - position);
                                if (length <= 0) throw new InvalidDataException("Invalid torrent file offsets.");
                                if (position < dataEnd)
                                {
                                    if (!paths.TryGetValue(index, out var source)) throw new IOException("A shared torrent piece is unavailable.");
                                    Stream? owned = null;
                                    try
                                    {
                                        Stream stream;
                                        if (index == binding.FileIndex) stream = selectedStream;
                                        else if (openedFiles?.TryGetValue(index, out var held) == true) stream = held;
                                        else
                                        {
                                            RefusePayloadLinks(source.AbsolutePath);
                                            owned = new FileStream(source.AbsolutePath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
                                            stream = owned;
                                        }
                                        // Skipped files contain only the boundary bytes we requested. Their
                                        // unneeded tail may not be allocated; authenticate the touching piece,
                                        // not the size of the unrelated remainder of that file.
                                        if (stream.Length < position - part.OffsetInTorrent + length)
                                            throw new IOException("Required shared-piece bytes are not available yet.");
                                        stream.Position = position - part.OffsetInTorrent;
                                        await stream.ReadExactlyAsync(buffer.AsMemory(0, length), ct);
                                        DeletionMeasurement.Add("verifyReadBytes", length);
                                    }
                                    finally { owned?.Dispose(); }
                                }
                                else Array.Clear(buffer, 0, length); // authenticated padding is virtual zero data
                                if (!expected.V1Hash.IsEmpty) sha1.AppendData(buffer.AsSpan(0, length));
                                if (!expected.V2Hash.IsEmpty && position < dataEnd) merkle.Append(buffer.AsSpan(0, length));
                                if (index == binding.FileIndex && position < dataEnd) digest.AppendData(buffer.AsSpan(0, length));
                                position += length;
                            }
                            if (!expected.V1Hash.IsEmpty && !sha1.GetHashAndReset().AsSpan().SequenceEqual(expected.V1Hash.Span))
                                throw new InvalidDataException("The completed file does not match its original torrent pieces.");
                            if (!expected.V2Hash.IsEmpty)
                            {
                                var owner = files[index];
                                var minimumLeaves = owner.StartPieceIndex == owner.EndPieceIndex ? 1 : torrent.PieceLength / (16 * 1024);
                                if (!merkle.Finish(minimumLeaves).AsSpan().SequenceEqual(expected.V2Hash.Span))
                                    throw new InvalidDataException("The completed file does not match its original torrent pieces.");
                            }
                            if (sharedPieces.Contains(piece)) verifiedSharedPieces.Add(piece);
                        }
                        verificationWarnings.TryRemove((hash, binding.FileIndex), out _);
                        output.Add(new(binding.FileIndex, binding.AbsolutePath, file.Length,
                            Convert.ToHexString(digest.GetHashAndReset()), null));
                    }
                    catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
                    {
                        var key = (hash, binding.FileIndex);
                        var now = DateTimeOffset.UtcNow;
                        if (!verificationWarnings.TryGetValue(key, out var prior) || prior.Message != ex.Message ||
                            now - prior.At >= TimeSpan.FromMinutes(5))
                        {
                            if (verificationWarnings.Count >= 4096) verificationWarnings.Clear();
                            verificationWarnings[key] = (ex.Message, now);
                            log($"Completion verification failed for {hash} file {binding.FileIndex}: {ex}");
                        }
                        output.Add(new(binding.FileIndex, binding.AbsolutePath, 0, null,
                            new(ex is InvalidDataException ? "hash_mismatch" : "verification_unavailable", ex.Message, null, true)));
                    }
                }
            }
            finally { ArrayPool<byte>.Shared.Return(buffer); }
            return output.ToImmutable();
        }
        finally { verificationGate.Release(); }
    }

    // O(log(piece size)) storage, including v2's virtual zero-hash leaves.
    private sealed class MerkleAccumulator
    {
        private readonly byte[]?[] levels = new byte[32][];
        private readonly byte[] block = new byte[16 * 1024];
        private int used, leaves;
        public void Append(ReadOnlySpan<byte> bytes)
        {
            while (!bytes.IsEmpty)
            {
                var take = Math.Min(block.Length - used, bytes.Length);
                bytes[..take].CopyTo(block.AsSpan(used)); used += take; bytes = bytes[take..];
                if (used == block.Length) { Push(SHA256.HashData(block)); used = 0; }
            }
        }
        private void Push(byte[] value)
        {
            leaves++;
            for (var level = 0; ; level++)
            {
                if (levels[level] is not { } left) { levels[level] = value; return; }
                var pair = new byte[64]; left.CopyTo(pair, 0); value.CopyTo(pair, 32);
                levels[level] = null; value = SHA256.HashData(pair);
            }
        }
        public byte[] Finish(int minimum)
        {
            if (used > 0) Push(SHA256.HashData(block.AsSpan(0, used)));
            var count = 1;
            while (count < Math.Max(leaves, minimum)) count = checked(count * 2);
            while (leaves < count) Push(new byte[32]);
            return levels.Single(v => v is not null)!;
        }
    }
}
