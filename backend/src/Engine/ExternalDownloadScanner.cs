using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;
using MonoTorrent;
using MonoTorrent.BEncoding;

namespace TorrentFlow.Engine;

public sealed record ExternalDownloadCandidate(string Id, string Source, string Hash, string Name,
    long SizeBytes, string SavePath, bool DataExists, bool Complete,
    [property: JsonIgnore] ImmutableArray<string> Files,
    [property: JsonIgnore] byte[] TorrentBytes);
public sealed record ExternalDownloadScan(ImmutableArray<ExternalDownloadCandidate> Candidates,
    ImmutableArray<string> Warnings);

// A foreign-client disk format adapter, not an Engine admission or identity resolver.
public sealed class ExternalDownloadScanner
{
    private const int MaxBytes = 32 * 1024 * 1024;

    public ExternalDownloadScan Scan(string? scanRoot, CancellationToken ct)
    {
        var root = string.IsNullOrWhiteSpace(scanRoot)
            ? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) : Path.GetFullPath(scanRoot);
        var rows = ImmutableArray.CreateBuilder<ExternalDownloadCandidate>();
        var warnings = ImmutableArray.CreateBuilder<string>();
        void Guard(string source, Action action)
        {
            try { action(); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException
                or FormatException or BEncodingException or TorrentException or InvalidOperationException
                or InvalidCastException or OverflowException)
            {
                if (warnings.Count < 100)
                    warnings.Add($"{source}: " + (ex is BEncodingException or TorrentException or InvalidCastException
                        or FormatException or OverflowException
                        ? "A client metadata file could not be read. Export the torrent from the original client and scan again."
                        : ex.Message));
            }
        }
        foreach (var source in new[] { "qBittorrent", "Transmission" })
        {
            var folder = Path.Combine(root, source == "qBittorrent" ? "qBittorrent" : "transmission");
            var torrents = Path.Combine(folder, source == "qBittorrent" ? "BT_backup" : "torrents");
            var resumes = source == "qBittorrent" ? torrents : Path.Combine(folder, "resume");
            Guard(source, () =>
            {
                var metadata = new Dictionary<string, (Torrent Torrent, byte[] Bytes)>(StringComparer.OrdinalIgnoreCase);
                var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var file in Entries(torrents, "*.torrent"))
                {
                    ct.ThrowIfCancellationRequested();
                    Guard(source, () =>
                    {
                        var bytes = Read(file);
                        var torrent = Torrent.Load(bytes);
                        metadata[torrent.InfoHashes.V1OrV2.ToHex()] = (torrent, bytes);
                    });
                }
                foreach (var file in Entries(resumes, source == "qBittorrent" ? "*.fastresume" : "*.resume"))
                {
                    ct.ThrowIfCancellationRequested();
                    Guard(source, () =>
                    {
                        var resume = BEncodedValue.Decode<BEncodedDictionary>(Read(file));
                        var hash = Path.GetFileNameWithoutExtension(file).Split('.').Last();
                        foreach (var key in new[] { "info-hash", "info_hash", "hash" })
                            if (resume.TryGetValue(key, out var value) && value is BEncodedString text)
                                hash = text.Span.Length == 20 ? Convert.ToHexString(text.Span) : text.Text;
                        if (!metadata.TryGetValue(hash, out var entry))
                            throw new IOException("Torrent metadata is unavailable. Export the torrent from the original client and scan again.");
                        var torrent = entry.Torrent;
                        var save = new[] { "save_path", "qBt-savePath", "save-path", "destination", "download-dir", "path" }
                            .Select(k => resume.TryGetValue(k, out var v) && v is BEncodedString s ? s.Text : null)
                            .FirstOrDefault(s => !string.IsNullOrWhiteSpace(s));
                        if (save is null || !Path.IsPathFullyQualified(save))
                            throw new IOException("The original absolute save folder is unavailable.");
                        save = Path.GetFullPath(save);
                        NoLinks(save);
                        string Bind(string relative)
                        {
                            relative = relative.Replace('/', Path.DirectorySeparatorChar);
                            if (Path.IsPathRooted(relative) || relative.Split(Path.DirectorySeparatorChar)
                                .Any(s => s is "." or ".." || s.Contains(':')))
                                throw new IOException("A torrent file escapes its original save folder.");
                            var path = Path.GetFullPath(Path.Combine(save, relative));
                            if (!path.StartsWith(Path.TrimEndingDirectorySeparator(save) + Path.DirectorySeparatorChar,
                                OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
                                throw new IOException("A torrent file escapes its original save folder.");
                            NoLinks(path);
                            return path;
                        }
                        static string Existing(string p) => File.Exists(p) ? p :
                            new[] { ".!qB", ".part", ".!ut" }.Select(s => p + s).FirstOrDefault(File.Exists) ?? p;
                        var flat = torrent.Files.Select(f => Bind(f.Path)).ToArray();
                        var nested = torrent.Files.Select(f => Bind(Path.Combine(torrent.Name, f.Path))).ToArray();
                        var flatFound = flat.Any(p => File.Exists(Existing(p)));
                        var nestedFound = nested.Any(p => File.Exists(Existing(p)));
                        if (flatFound && nestedFound && !flat.SequenceEqual(nested))
                            throw new IOException("Both payload layouts exist. Choose one in the original client before importing.");
                        var paths = nestedFound && torrent.Files.Count > 1 ? nested : flat;
                        if (resume.TryGetValue("mapped_files", out var mapped) && mapped is BEncodedList list)
                            for (var i = 0; i < Math.Min(list.Count, paths.Length); i++)
                                if (list[i] is BEncodedString name && !string.IsNullOrWhiteSpace(name.Text))
                                {
                                    var renamed = Bind(name.Text);
                                    if (renamed != paths[i] && File.Exists(paths[i]))
                                        throw new IOException("Both original and renamed payloads exist.");
                                    paths[i] = renamed;
                                }
                        paths = paths.Select(Existing).ToArray();
                        foreach (var path in paths) NoLinks(path);
                        var complete = paths.Zip(torrent.Files).All(p => File.Exists(p.First) &&
                            new FileInfo(p.First).Length == p.Second.Length && Path.GetExtension(p.First) is not ".!qB" and not ".part" and not ".!ut");
                        hash = torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
                        var id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
                            $"{source}\n{hash}\n{save}\n{nestedFound && torrent.Files.Count > 1}"))).ToLowerInvariant();
                        rows.Add(new(id, source, hash, torrent.Name, torrent.Size, save,
                            paths.Any(p => File.Exists(p) && new FileInfo(p).Length > 0), complete, [.. paths], entry.Bytes));
                        used.Add(hash);
                    });
                }
                foreach (var (hash, entry) in metadata)
                    if (!used.Contains(hash) && warnings.Count < 100)
                        warnings.Add($"{source}: {entry.Torrent.Name} has metadata but no readable original save path; not offered for import.");
            });
        }
        return new([.. rows.DistinctBy(r => r.Id)], warnings.ToImmutable());
    }

    private static IEnumerable<string> Entries(string root, string pattern)
    {
        NoLinks(root);
        return Directory.Exists(root) ? Directory.EnumerateFiles(root, pattern).Take(10000) : [];
    }

    private static void NoLinks(string path)
    {
        for (FileSystemInfo? item = Directory.Exists(path) ? new DirectoryInfo(path) : new FileInfo(path); item is not null;
            item = Directory.GetParent(item.FullName))
            if (item.Exists && (item.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Filesystem links are not imported.");
    }

    private static byte[] Read(string path)
    {
        NoLinks(path);
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (file.Length > MaxBytes) throw new IOException("Client metadata exceeds the 32 MiB limit.");
        var bytes = new byte[checked((int)file.Length)];
        file.ReadExactly(bytes);
        var position = 0;
        void Value(int depth)
        {
            if (depth > 32 || position >= bytes.Length) throw new FormatException("Malformed or deeply nested client metadata.");
            var c = bytes[position++];
            if (c is (byte)'d' or (byte)'l')
            {
                while (position < bytes.Length && bytes[position] != 'e') Value(depth + 1);
                if (position >= bytes.Length) throw new FormatException("Unterminated client metadata.");
                position++;
            }
            else if (c == 'i')
            {
                var end = Array.IndexOf(bytes, (byte)'e', position);
                if (end < 0 || end - position > 21) throw new FormatException("Invalid client metadata integer.");
                position = end + 1;
            }
            else
            {
                if (c is < (byte)'0' or > (byte)'9') throw new FormatException("Invalid client metadata value.");
                var length = c - '0';
                while (position < bytes.Length && bytes[position] != ':')
                {
                    var digit = bytes[position++] - '0';
                    if (digit is < 0 or > 9 || length > MaxBytes / 10) throw new FormatException("Invalid client metadata string.");
                    length = checked(length * 10 + digit);
                }
                if (position >= bytes.Length || length > bytes.Length - ++position) throw new FormatException("Truncated client metadata.");
                position += length;
            }
        }
        Value(0);
        if (position != bytes.Length) throw new FormatException("Trailing client metadata.");
        return bytes;
    }
}
