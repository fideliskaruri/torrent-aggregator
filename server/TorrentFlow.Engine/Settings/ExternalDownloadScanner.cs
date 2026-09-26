using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using MonoTorrent;
using MonoTorrent.BEncoding;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Clients.External;

namespace TorrentFlow.Engine.Settings;

public sealed record ExternalDownloadCandidate(
    string Id, string Source, string Hash, string Name, long SizeBytes, string SavePath,
    bool DataExists, bool Complete,
    [property: JsonIgnore] byte[]? TorrentBytes,
    [property: JsonIgnore] string? Magnet,
    bool CreateContainingDirectory,
    [property: JsonIgnore] IReadOnlyDictionary<string, string>? FilePaths = null);

public sealed record ExternalDownloadScan(IReadOnlyList<ExternalDownloadCandidate> Candidates, IReadOnlyList<string> Warnings);

public sealed class ExternalDownloadScanOptions
{
    public string? ScanRoot { get; set; }
    public bool? AllowConfiguredApis { get; set; }
    public string? ContentRoot { get; set; }
    public string? SnapshotRoot { get; set; }
    public List<string> LegacyRoots { get; set; } = [];
}

public sealed class ExternalDownloadScanner(
    IOptions<ExternalDownloadScanOptions> options, ILogger<ExternalDownloadScanner> logger,
    IServiceScopeFactory? scopeFactory = null)
{
    private const int MaxFileBytes = 32 * 1024 * 1024;
    private const int MaxEntries = 10000;

    public async Task<ExternalDownloadScan> ScanAsync(CancellationToken ct = default)
    {
        var rows = new List<ExternalDownloadCandidate>();
        var warnings = new List<string>();
        var fixture = !string.IsNullOrWhiteSpace(options.Value.ScanRoot);
        var local = fixture ? Path.GetFullPath(options.Value.ScanRoot!) : Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var roaming = fixture ? local : Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var roots = new[]
        {
            ("qBittorrent", Path.Combine(local, "qBittorrent", "BT_backup")),
            ("Transmission", Path.Combine(local, "transmission")),
            ("uTorrent", Path.Combine(roaming, "uTorrent")),
            ("BitTorrent", Path.Combine(roaming, "BitTorrent")),
            ("Deluge", Path.Combine(roaming, "deluge", "state")),
        };
        foreach (var (source, root) in roots)
        {
            ct.ThrowIfCancellationRequested();
            Guard(source, () => ScanFiles(source, root, rows, warnings, ct), warnings);
        }
        var legacyRoots = fixture ? new[] { Path.Combine(local, "nextjs") }
            : new[] { options.Value.ContentRoot ?? Directory.GetCurrentDirectory() }.Concat(options.Value.LegacyRoots);
        var databases = new HashSet<string>(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        foreach (var root in legacyRoots)
        {
            Guard("TorrentFlow Next.js", () =>
            {
                var full = Path.GetFullPath(root);
                databases.Add(Path.Combine(full, "dev.db"));
                databases.Add(Path.Combine(full, "prisma", "dev.db"));
                var envFile = Path.Combine(full, ".env");
                var url = !fixture ? Environment.GetEnvironmentVariable("DATABASE_URL") : null;
                if (url is null && File.Exists(envFile) && !HasLink(envFile))
                    url = Encoding.UTF8.GetString(ReadBounded(envFile)).Split('\n').Select(l => l.Trim())
                        .FirstOrDefault(l => l.StartsWith("DATABASE_URL=", StringComparison.Ordinal))?["DATABASE_URL=".Length..].Trim().Trim('"', '\'');
                if (url?.StartsWith("file:", StringComparison.OrdinalIgnoreCase) == true)
                {
                    var value = Uri.UnescapeDataString(url[5..]);
                    var resolved = Path.GetFullPath(value, full);
                    if (!fixture || Within(resolved, local)) databases.Add(resolved);
                }
            }, warnings);
        }
        foreach (var path in databases)
        {
            ct.ThrowIfCancellationRequested();
            try { await ScanDatabaseAsync(path, rows, warnings, ct); }
            catch (Exception ex) when (Recoverable(ex)) { Warn("TorrentFlow Next.js", ex, warnings); }
        }
        if ((options.Value.AllowConfiguredApis ?? !fixture) && scopeFactory is not null)
            await ScanApisAsync(rows, warnings, ct);
        return new(rows.DistinctBy(r => r.Id).ToList(), warnings);
    }

    private void ScanFiles(string source, string root, List<ExternalDownloadCandidate> rows, List<string> warnings, CancellationToken ct)
    {
        if (!Directory.Exists(root)) return;
        if (HasLink(root)) throw new IOException("Source directory contains a filesystem link.");
        var torrentDirectory = source == "Transmission" ? Path.Combine(root, "torrents") : root;
        var metadata = new Dictionary<string, (byte[] Bytes, Torrent Torrent, string File)>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in Files(torrentDirectory, "*.torrent"))
        {
            ct.ThrowIfCancellationRequested();
            Guard(source, () =>
            {
                var bytes = ReadBencoded(file);
                var torrent = Torrent.Load(bytes);
                metadata[torrent.InfoHashes.V1OrV2.ToHex()] = (bytes, torrent, Path.GetFileName(file));
            }, warnings);
        }
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Record(BEncodedDictionary resume, string key, string? torrentFile = null)
        {
            Guard(source, () =>
            {
                var hash = Hash(resume, key);
                var info = torrentFile is null ? default : metadata.Values.FirstOrDefault(m => m.File.Equals(torrentFile, StringComparison.OrdinalIgnoreCase));
                if (info.Torrent is not null) hash = info.Torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
                if (hash is not null && info.Torrent is null) metadata.TryGetValue(hash, out info);
                if (hash is null) throw new FormatException("Resume record has no valid torrent hash.");
                var save = Text(resume, "save_path", "qBt-savePath", "save-path", "destination", "download-dir", "path");
                var name = info.Torrent?.Name ?? Text(resume, "name", "qBt-name") ?? hash;
                var magnet = Text(resume, "magnet", "magnet-uri", "magnet_uri", "qBt-magnetUri");
                if (string.IsNullOrEmpty(magnet)) magnet = BuildMagnet(hash, name, resume);
                if (source is "uTorrent" or "BitTorrent" && info.Torrent?.Files.Count == 1 && save is not null
                    && Path.GetFileName(save).Equals(info.Torrent.Name, StringComparison.OrdinalIgnoreCase))
                    save = Path.GetDirectoryName(save);
                var candidate = Candidate(source, hash, name, save, info.Bytes, magnet,
                    Number(resume, "total_size", "total-size", "size", "length"), Number(resume, "seed_mode", "completed") == 1,
                    resume.TryGetValue("mapped_files", out var mapped) && mapped is BEncodedList mappedList
                        ? mappedList.OfType<BEncodedString>().Select(s => s.Text).ToArray() : null);
                if (candidate is not null) rows.Add(candidate);
                used.Add(hash);
            }, warnings);
        }
        if (source is "uTorrent" or "BitTorrent" or "Deluge")
        {
            var file = Path.Combine(root, source == "Deluge" ? "torrents.fastresume" : "resume.dat");
            if (File.Exists(file))
                Guard(source, () =>
                {
                    var dictionary = BEncodedValue.Decode<BEncodedDictionary>(ReadBencoded(file));
                    foreach (var pair in dictionary.Take(MaxEntries))
                    {
                        ct.ThrowIfCancellationRequested();
                        Guard(source, () =>
                        {
                            var entry = pair.Value is BEncodedString bytes
                                ? BEncodedValue.Decode<BEncodedDictionary>(CheckedBencode(bytes.Span.ToArray()))
                                : pair.Value as BEncodedDictionary;
                            if (entry is not null) Record(entry, pair.Key.Text, source == "Deluge" ? null : Path.GetFileName(pair.Key.Text));
                        }, warnings);
                    }
                }, warnings);
        }
        else
        {
            var resumeRoot = source == "Transmission" ? Path.Combine(root, "resume") : root;
            foreach (var file in Files(resumeRoot, source == "Transmission" ? "*.resume" : "*.fastresume"))
            {
                ct.ThrowIfCancellationRequested();
                Guard(source, () => Record(BEncodedValue.Decode<BEncodedDictionary>(ReadBencoded(file)), Path.GetFileNameWithoutExtension(file)), warnings);
            }
        }
        foreach (var (hash, info) in metadata)
            if (!used.Contains(hash))
                warnings.Add($"{source}: {info.Torrent.Name} has metadata but no readable original save path; not offered for import.");
    }

    private async Task ScanApisAsync(List<ExternalDownloadCandidate> rows, List<string> warnings, CancellationToken ct)
    {
        try
        {
            using var scope = scopeFactory!.CreateScope();
            var clients = scope.ServiceProvider.GetRequiredService<ExternalClientRegistry>();
            var settings = scope.ServiceProvider.GetRequiredService<ClientSettingsStore>();
            var secrets = scope.ServiceProvider.GetRequiredService<SecretProtector>();
            var config = await settings.GetStoredConnectionConfigAsync(secrets, ct);
            foreach (var type in new[] { config.ClientType, config.ExternalClientType }.Distinct().Where(t => t is "qbittorrent" or "transmission"))
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(20));
                try
                {
                    var client = clients.Get(type!);
                    foreach (var row in (await client.ListAsync(config, timeout.Token)).Take(MaxEntries))
                    {
                        byte[]? metadata = null;
                        try { metadata = await client.ReadTorrentAsync(config, row.Hash, timeout.Token); }
                        catch (Exception ex) when (!ct.IsCancellationRequested && (Recoverable(ex) || ex is OperationCanceledException))
                        { Warn(type!, ex, warnings); }
                        Guard(type!, () =>
                        {
                            var hash = TorrentSource.HashFromMagnet(row.Magnet) ?? TorrentSource.NormalizeInfoHash(row.Hash);
                            if (hash is null) return;
                            var candidate = Candidate(type == "qbittorrent" ? "qBittorrent API" : "Transmission RPC",
                                hash, row.Name, row.SavePath, metadata, row.Magnet ?? TorrentSource.BuildMagnet(hash, row.Name, []),
                                row.SizeBytes, row.Progress >= .9999);
                            if (candidate is not null) rows.Add(candidate);
                        }, warnings);
                    }
                }
                catch (Exception ex) when (!ct.IsCancellationRequested && (Recoverable(ex) || ex is OperationCanceledException))
                { Warn(type!, ex, warnings); }
            }
        }
        catch (Exception ex) when (Recoverable(ex)) { Warn("Configured clients", ex, warnings); }
    }

    private async Task ScanDatabaseAsync(string sourceFile, List<ExternalDownloadCandidate> output, List<string> warnings, CancellationToken ct)
    {
        if (!File.Exists(sourceFile)) return;
        if (HasLink(sourceFile)) throw new IOException("Legacy database contains a filesystem link.");
        // SQLite readers may update -shm. Only open our disposable copy, never the foreign database.
        var scratch = options.Value.SnapshotRoot ?? options.Value.ScanRoot
            ?? throw new InvalidOperationException("A private snapshot directory is required to read the legacy database.");
        var directory = Path.Combine(scratch, "legacy-scan-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var copy = Path.Combine(directory, "source.db");
            foreach (var suffix in new[] { "", "-wal" })
            {
                var path = sourceFile + suffix;
                if (!File.Exists(path)) continue;
                if (HasLink(path)) throw new IOException("Legacy database sidecar contains a link.");
                await using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                if (input.Length > 512L * 1024 * 1024) throw new IOException("Legacy database exceeds the 512 MiB scan limit.");
                await using var target = File.Create(copy + suffix);
                await input.CopyToAsync(target, ct);
            }
            await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = copy, Pooling = false }.ToString());
            await connection.OpenAsync(ct);
            foreach (var table in new[] { "EngineTorrent", "DownloadHistory" })
            {
                await using var columns = connection.CreateCommand();
                columns.CommandText = $"PRAGMA table_info(\"{table}\")";
                var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                await using (var reader = await columns.ExecuteReaderAsync(ct))
                    while (await reader.ReadAsync(ct)) names.Add(reader.GetString(1));
                var fields = new[] { "hash", "infoHash", "name", "title", "sizeBytes", "savePath", "progress", "status", "magnet", "torrentUrl" }.Where(names.Contains).ToArray();
                if (fields.Length == 0) continue;
                await using var command = connection.CreateCommand();
                command.CommandText = $"SELECT {string.Join(",", fields.Select(x => $"\"{x}\""))} FROM \"{table}\" LIMIT {MaxEntries}";
                await using var readerRows = await command.ExecuteReaderAsync(ct);
                while (await readerRows.ReadAsync(ct))
                {
                    Guard("TorrentFlow Next.js", () =>
                    {
                        string? Get(string key) => Array.IndexOf(fields, key) is >= 0 and var i && !readerRows.IsDBNull(i) ? Convert.ToString(readerRows.GetValue(i), System.Globalization.CultureInfo.InvariantCulture) : null;
                        if (Get("status") is "removed" or "failed") return;
                        var magnet = Get("magnet");
                        var hash = TorrentSource.HashFromMagnet(magnet) ?? TorrentSource.NormalizeInfoHash(Get("hash") ?? Get("infoHash"));
                        if (hash is null) return;
                        var name = Get("name") ?? Get("title") ?? hash;
                        var size = long.TryParse(Get("sizeBytes"), out var n) ? n : 0;
                        var candidate = Candidate("TorrentFlow Next.js", hash, name, Get("savePath"), null,
                            magnet ?? TorrentSource.BuildMagnet(hash, name, []), size, Get("status") is "downloaded" or "seeding");
                        if (candidate is not null) output.Add(candidate);
                    }, warnings);
                }
            }
        }
        finally { Directory.Delete(directory, true); }
    }

    private static ExternalDownloadCandidate? Candidate(string source, string hash, string name, string? path,
        byte[]? bytes, string? magnet, long size, bool reportedComplete, string[]? mappedFiles = null)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path))
            throw new FormatException($"{name}: original absolute save path unavailable.");
        var save = Path.GetFullPath(path);
        if (HasLink(save)) throw new IOException($"{name}: payload path contains a link.");
        var exists = false;
        var complete = false;
        var create = false;
        Dictionary<string, string>? filePaths = null;
        if (bytes is not null)
        {
            var torrent = Torrent.Load(bytes);
            size = torrent.Size;
            string[] Paths(bool nested) => torrent.Files.Select(f =>
            {
                var relative = f.Path.Replace('/', Path.DirectorySeparatorChar);
                if (Path.IsPathRooted(relative) || relative.Split(Path.DirectorySeparatorChar).Any(s => s is ".." or "." || s.Contains(':')))
                    throw new FormatException("Unsafe torrent path.");
                var full = Path.GetFullPath(Path.Combine(save, nested ? torrent.Name : "", relative));
                if (!Within(full, save) || HasLink(full)) throw new FormatException("Unsafe or linked torrent file.");
                return full;
            }).ToArray();
            var flat = Paths(false);
            var nested = Paths(true);
            static string ExistingPath(string path) => File.Exists(path) ? path
                : new[] { ".!qB", ".part", ".!ut" }.Select(s => path + s).FirstOrDefault(File.Exists) ?? path;
            var flatFound = flat.Count(p => File.Exists(ExistingPath(p)));
            var nestedFound = nested.Count(p => File.Exists(ExistingPath(p)));
            if (flatFound > 0 && nestedFound > 0 && !flat.SequenceEqual(nested))
                throw new IOException($"{name}: ambiguous existing payload layout; not imported.");
            create = torrent.Files.Count > 1 && nestedFound > 0;
            var actual = create ? nested : flat;
            // A missing multi-file release defaults to the client's conventional containing folder.
            if (flatFound == 0 && nestedFound == 0) create = torrent.Files.Count > 1;
            filePaths = new Dictionary<string, string>(StringComparer.Ordinal);
            for (var index = 0; index < actual.Length; index++)
            {
                var original = actual[index];
                var mapped = mappedFiles is not null && index < mappedFiles.Length ? mappedFiles[index] : null;
                if (!string.IsNullOrEmpty(mapped))
                {
                    var mappedPath = Path.GetFullPath(Path.Combine(save, mapped.Replace('/', Path.DirectorySeparatorChar)));
                    if (!Within(mappedPath, save)) throw new IOException("Renamed file escapes the original save directory.");
                    if (File.Exists(original) && mappedPath != original) throw new IOException("Ambiguous renamed payload; both filenames exist.");
                    actual[index] = mappedPath;
                }
                actual[index] = ExistingPath(actual[index]);
                if (HasLink(actual[index])) throw new IOException("Linked payload file.");
                if (actual[index] != original) filePaths[torrent.Files[index].Path] = actual[index];
            }
            exists = actual.Any(p => File.Exists(p) && new FileInfo(p).Length > 0);
            complete = actual.Zip(torrent.Files).All(pair => File.Exists(pair.First) && new FileInfo(pair.First).Length == pair.Second.Length);
        }
        else
        {
            if (Path.GetFileName(name) != name || name is "." or "..") throw new FormatException("Unsafe torrent name.");
            var named = Path.Combine(save, name);
            if (HasLink(named)) throw new IOException("Linked payload path.");
            exists = File.Exists(named) && new FileInfo(named).Length > 0;
            if (Directory.Exists(named))
            {
                exists = new DirectoryInfo(named).EnumerateFiles("*", new EnumerationOptions
                    { RecurseSubdirectories = true, MaxRecursionDepth = 12, AttributesToSkip = FileAttributes.ReparsePoint, IgnoreInaccessible = true })
                    .Take(MaxEntries).Any(f => f.Length > 0);
                create = true;
            }
            complete = reportedComplete && exists;
        }
        var id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{source}\n{hash}\n{save}\n{create}"))).ToLowerInvariant();
        return new(id, source, hash.ToLowerInvariant(), name, Math.Max(0, size), save, exists, complete, bytes, magnet, create, filePaths);
    }

    private static IEnumerable<string> Files(string root, string pattern)
    {
        if (!Directory.Exists(root)) return [];
        if (HasLink(root)) throw new IOException("Source path contains a link.");
        return Directory.EnumerateFiles(root, pattern, new EnumerationOptions
            { AttributesToSkip = FileAttributes.ReparsePoint, IgnoreInaccessible = false }).Take(MaxEntries);
    }

    private static bool Within(string path, string root) => path.StartsWith(Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar,
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    internal static bool HasLink(string path)
    {
        if ((File.Exists(path) || Directory.Exists(path)) && File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint)) return true;
        for (var p = Directory.GetParent(path); p is not null; p = p.Parent)
            if (p.Exists && p.Attributes.HasFlag(FileAttributes.ReparsePoint)) return true;
        return false;
    }

    private static string? Text(BEncodedDictionary d, params string[] keys) =>
        keys.Select(k => d.TryGetValue(k, out var v) && v is BEncodedString s ? s.Text : null).FirstOrDefault(s => !string.IsNullOrWhiteSpace(s));
    private static long Number(BEncodedDictionary d, params string[] keys) =>
        keys.Select(k => d.TryGetValue(k, out var v) && v is BEncodedNumber n ? n.Number : 0).FirstOrDefault(n => n != 0);

    private static string? Hash(BEncodedDictionary d, string key)
    {
        var magnetHash = TorrentSource.HashFromMagnet(Text(d, "magnet", "magnet-uri", "magnet_uri", "qBt-magnetUri"));
        if (magnetHash is not null) return magnetHash;
        foreach (var field in new[] { "info-hash", "info_hash", "hash" })
            if (d.TryGetValue(field, out var v) && v is BEncodedString s)
            {
                if (s.Span.Length == 20) return Convert.ToHexString(s.Span).ToLowerInvariant();
                if (TorrentSource.NormalizeInfoHash(s.Text) is { } h) return h;
            }
        if (TorrentSource.NormalizeInfoHash(key) is { } direct) return direct;
        // Transmission names its resume files <display-name>.<hash>.resume.
        return TorrentSource.NormalizeInfoHash(key.Split('.').Last());
    }

    private static string BuildMagnet(string hash, string name, BEncodedDictionary resume)
    {
        var trackers = new List<string>();
        if (resume.TryGetValue("trackers", out var value) && value is BEncodedList tiers)
            foreach (var tier in tiers)
                if (tier is BEncodedString text) trackers.Add(text.Text);
                else if (tier is BEncodedList list) trackers.AddRange(list.OfType<BEncodedString>().Select(s => s.Text));
        return TorrentSource.BuildMagnet(hash, name, trackers);
    }

    private static byte[] ReadBounded(string path)
    {
        if (HasLink(path)) throw new IOException("Source file contains a link.");
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (file.Length > MaxFileBytes) throw new IOException("Source file exceeds the 32 MiB limit.");
        var bytes = new byte[checked((int)file.Length)];
        file.ReadExactly(bytes);
        return bytes;
    }
    private static byte[] ReadBencoded(string path) => CheckedBencode(ReadBounded(path));
    internal static byte[] CheckedBencode(byte[] bytes)
    {
        // Bound nesting BEFORE calling the recursive library decoder; byte strings may contain arbitrary 'd'/'l'/'e'.
        var i = 0;
        void Value(int depth)
        {
            if (depth > 32 || i >= bytes.Length) throw new FormatException("Malformed or deeply nested bencode.");
            var c = bytes[i++];
            if (c is (byte)'d' or (byte)'l')
            {
                while (i < bytes.Length && bytes[i] != 'e') Value(depth + 1);
                if (i >= bytes.Length) throw new FormatException("Unterminated bencode container.");
                i++;
            }
            else if (c == 'i')
            {
                var end = Array.IndexOf(bytes, (byte)'e', i);
                if (end < 0 || end - i > 21) throw new FormatException("Invalid bencode integer.");
                i = end + 1;
            }
            else
            {
                if (c < '0' || c > '9') throw new FormatException("Invalid bencode value.");
                var length = c - '0';
                while (i < bytes.Length && bytes[i] != ':')
                {
                    var digit = bytes[i++] - '0';
                    if (digit is < 0 or > 9 || length > MaxFileBytes / 10) throw new FormatException("Invalid bencode string length.");
                    length = checked(length * 10 + digit);
                }
                if (i >= bytes.Length || length > bytes.Length - ++i) throw new FormatException("Truncated bencode string.");
                i += length;
            }
        }
        Value(0);
        if (i != bytes.Length) throw new FormatException("Trailing bencode data.");
        return bytes;
    }

    private static bool Recoverable(Exception ex) => ex is IOException or UnauthorizedAccessException or ArgumentException or BEncodingException or InvalidCastException
        or FormatException or InvalidOperationException or TorrentException or SqliteException or HttpRequestException
        or System.Text.Json.JsonException or OverflowException;
    private void Guard(string source, Action action, List<string> warnings)
    {
        try { action(); }
        catch (Exception ex) when (Recoverable(ex)) { Warn(source, ex, warnings); }
    }
    private void Warn(string source, Exception ex, List<string> warnings)
    {
        logger.LogWarning(ex, "Could not scan a torrent entry from {Source}", source);
        if (warnings.Count < 100) warnings.Add($"{source}: {ex.Message}");
    }
}
