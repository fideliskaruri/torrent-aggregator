using System.Security.Cryptography;
using System.Text;

namespace TorrentFlow.Store;

internal sealed record LegacyTorrentFile(int Index, string Path, long Bytes);

internal sealed class LegacyTorrentVerifier
{
    private readonly byte[] bytes;
    private int offset;
    private int infoStart;
    private int infoEnd;

    private LegacyTorrentVerifier(byte[] bytes) => this.bytes = bytes;

    internal static (IReadOnlyList<LegacyTorrentFile> Files, bool Verified) Inspect(string torrentPath, string hash,
        string payloadDirectory)
    {
        var bytes = File.ReadAllBytes(torrentPath);
        if (bytes.Length > 16 * 1024 * 1024) throw new InvalidDataException("Torrent metadata exceeds the converter limit.");
        var parser = new LegacyTorrentVerifier(bytes);
        var torrent = (Dictionary<string, object>)parser.Read(0);
        if (parser.offset != bytes.Length) throw new InvalidDataException("Trailing torrent metadata.");
        var actualHash = Convert.ToHexStringLower(SHA1.HashData(bytes.AsSpan(parser.infoStart, parser.infoEnd - parser.infoStart)));
        if (actualHash != hash) throw new InvalidDataException("Torrent info hash differs from the legacy row.");
        var info = (Dictionary<string, object>)torrent["info"];
        var files = new List<LegacyTorrentFile>();
        if (info.TryGetValue("files", out var entries))
        {
            foreach (var entry in (List<object>)entries)
            {
                var file = (Dictionary<string, object>)entry;
                var components = ((List<object>)file["path"]).Select(p => Text((byte[])p)).ToArray();
                if (components.Any(p => p is "" or "." or ".." || p.IndexOfAny(['\\', '/', ':', '\0']) >= 0))
                    throw new InvalidDataException("Unsafe torrent path.");
                files.Add(new(files.Count, Path.Combine(components), (long)file["length"]));
            }
        }
        else
        {
            var name = Text((byte[])info["name"]);
            if (name.IndexOfAny(['\\', '/', ':', '\0']) >= 0 || name is "" or "." or "..")
                throw new InvalidDataException("Unsafe torrent name.");
            files.Add(new(0, name, (long)info["length"]));
        }
        if (files.Any(f => f.Bytes < 0)) throw new InvalidDataException("Negative torrent file length.");
        if (files.Any(f => Path.GetExtension(f.Path).ToLowerInvariant() is ".exe" or ".dll" or ".bat" or ".cmd"
            or ".com" or ".ps1" or ".vbs" or ".lnk" or ".scr" or ".msi"))
            throw new InvalidDataException("Executable payload in staged torrent; refusing relocation.");
        var pieceLength = checked((int)(long)info["piece length"]);
        var hashes = (byte[])info["pieces"];
        if (pieceLength is < 1 or > 64 * 1024 * 1024 || hashes.Length % 20 != 0)
            throw new InvalidDataException("Unsupported torrent piece metadata.");
        long total = files.Sum(f => f.Bytes);
        if ((total + pieceLength - 1) / pieceLength != hashes.Length / 20)
            throw new InvalidDataException("Torrent piece count mismatch.");
        foreach (var file in files)
        {
            var path = Path.Combine(payloadDirectory, file.Path);
            if (!File.Exists(path) || new FileInfo(path).Length != file.Bytes) return (files, false);
        }
        var buffer = new byte[pieceLength];
        var buffered = 0;
        var piece = 0;
        foreach (var file in files)
        {
            var path = Path.Combine(payloadDirectory, file.Path);
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Payload file is a symbolic link.");
            using var input = File.OpenRead(path);
            int read;
            while ((read = input.Read(buffer, buffered, pieceLength - buffered)) > 0)
            {
                buffered += read;
                if (buffered != pieceLength) continue;
                if (!SHA1.HashData(buffer).AsSpan().SequenceEqual(hashes.AsSpan(piece++ * 20, 20))) return (files, false);
                buffered = 0;
            }
        }
        if (buffered > 0 && !SHA1.HashData(buffer.AsSpan(0, buffered)).AsSpan().SequenceEqual(hashes.AsSpan(piece * 20, 20)))
            return (files, false);
        return (files, true);
    }
    private static string Text(byte[] value) => new UTF8Encoding(false, true).GetString(value);
    private object Read(int depth)
    {
        if (depth > 64 || offset >= bytes.Length) throw new InvalidDataException("Malformed torrent metadata.");
        switch (bytes[offset++])
        {
            case (byte)'i':
                var end = Array.IndexOf(bytes, (byte)'e', offset);
                if (end < offset) throw new InvalidDataException("Malformed torrent integer.");
                var number = long.Parse(Encoding.ASCII.GetString(bytes, offset, end - offset), System.Globalization.CultureInfo.InvariantCulture);
                offset = end + 1;
                return number;
            case (byte)'l':
                var list = new List<object>();
                while (offset < bytes.Length && bytes[offset] != 'e') list.Add(Read(depth + 1));
                if (offset++ >= bytes.Length) throw new InvalidDataException("Unterminated torrent list.");
                return list;
            case (byte)'d':
                var dictionary = new Dictionary<string, object>(StringComparer.Ordinal);
                while (offset < bytes.Length && bytes[offset] != 'e')
                {
                    var key = Text((byte[])Read(depth + 1));
                    var start = offset;
                    dictionary.Add(key, Read(depth + 1));
                    if (depth == 0 && key == "info") { infoStart = start; infoEnd = offset; }
                }
                if (offset++ >= bytes.Length) throw new InvalidDataException("Unterminated torrent dictionary.");
                return dictionary;
            default:
                offset--;
                var colon = Array.IndexOf(bytes, (byte)':', offset);
                if (colon < offset) throw new InvalidDataException("Malformed torrent byte string.");
                var length = int.Parse(Encoding.ASCII.GetString(bytes, offset, colon - offset), System.Globalization.CultureInfo.InvariantCulture);
                offset = colon + 1;
                if (length < 0 || length > bytes.Length - offset) throw new InvalidDataException("Invalid torrent byte string length.");
                var data = bytes.AsSpan(offset, length).ToArray();
                offset += length;
                return data;
        }
    }
}
