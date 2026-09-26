using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Controllers;

namespace TorrentFlow.Engine.Settings;

internal static class SettingsDiskInventory
{
    private static readonly HashSet<string> MediaExtensions = new(StringComparer.OrdinalIgnoreCase)
        { ".mkv", ".mp4", ".m4v", ".avi", ".mov", ".webm", ".ts", ".m2ts", ".mpg", ".mpeg", ".wmv" };

    internal static IReadOnlyList<FileInfo> MediaFiles(string? root, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root)) return [];
        var directory = new DirectoryInfo(Path.GetFullPath(root));
        if (directory.Attributes.HasFlag(FileAttributes.ReparsePoint)) return [];
        var files = new List<FileInfo>();
        var examined = 0;
        void Walk(DirectoryInfo folder, int depth)
        {
            if (depth > 12) return;
            foreach (var entry in folder.EnumerateFileSystemInfos("*", new EnumerationOptions { IgnoreInaccessible = true }))
            {
                ct.ThrowIfCancellationRequested();
                if (++examined > 50_000) throw new IOException("Recovery scan exceeds 50,000 entries. Choose a smaller download folder.");
                if (entry.Name.StartsWith('.') || entry.Attributes.HasFlag(FileAttributes.ReparsePoint)) continue;
                if (entry is DirectoryInfo child) Walk(child, depth + 1);
                else if (entry is FileInfo file && file.Length > 0 && MediaExtensions.Contains(file.Extension)) files.Add(file);
            }
        }
        Walk(directory, 0);
        return files;
    }

    private sealed record Entry(string RelativePath, string Path, string Name, long Bytes, long ModifiedMs, string Kind);

    internal static object Usage(ClientConfig config, IReadOnlyList<EngineTorrent> rows, CancellationToken ct)
    {
        rows = rows.Where(r => r.Status != "removed").ToArray();
        var recent = rows.OrderByDescending(r => r.LastUsedAt).Take(200).ToArray();
        string Policy(EngineTorrent row) => row.Origin switch { "user" => "KEPT", "stream" or "prewarm" => "EPHEMERAL", _ => "INDETERMINATE" };
        long Bytes(string policy) => recent.Where(r => Policy(r) == policy).Sum(r => Math.Max(0, r.SizeBytes));
        var files = new List<Entry>();
        var unreadable = new List<string>();
        var truncation = new HashSet<string>();
        var links = 0;
        var examined = 0;
        var root = config.DownloadRoot is { } configured ? Path.GetFullPath(configured) : null;
        var comparer = OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
        var tracked = rows.SelectMany(TorrentEngineService.VerifiedFiles).Where(f => f.FullPath is not null)
            .Select(f => Path.GetFullPath(f.FullPath!)).ToHashSet(comparer);
        var claims = rows.Where(r => !string.IsNullOrWhiteSpace(r.SavePath) && !string.IsNullOrWhiteSpace(r.Name))
            .Select(r => Path.GetFullPath(Path.Combine(r.SavePath!, r.Name))).ToList();

        void Walk(string directory, int depth)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                foreach (var entry in new DirectoryInfo(directory).EnumerateFileSystemInfos())
                {
                    ct.ThrowIfCancellationRequested();
                    if (++examined > 50_000) { truncation.Add("entries"); return; }
                    if (entry.Attributes.HasFlag(FileAttributes.ReparsePoint)) { links++; continue; }
                    if (entry is DirectoryInfo)
                    {
                        if (depth >= 12) truncation.Add("depth");
                        else Walk(entry.FullName, depth + 1);
                        if (truncation.Contains("entries")) return;
                        continue;
                    }
                    var file = (FileInfo)entry;
                    var relative = Path.GetRelativePath(root!, file.FullName).Replace('\\', '/');
                    var kind = relative.StartsWith('.') ? "internal"
                        : tracked.Contains(file.FullName) || claims.Any(c => FoldersController.IsWithin(file.FullName, c)) ? "tracked" : "orphan";
                    files.Add(new(relative, file.FullName, file.Name, file.Length, new DateTimeOffset(file.LastWriteTimeUtc).ToUnixTimeMilliseconds(), kind));
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { unreadable.Add(directory); }
        }
        if (root is not null) Walk(root, 0);
        var authoritative = root is not null && unreadable.Count == 0 && truncation.Count == 0;
        var impure = new HashSet<string>(comparer);
        foreach (var entry in files.Where(f => f.Kind != "orphan"))
        {
            var parts = entry.RelativePath.Split('/');
            for (var i = 1; i < parts.Length; i++) impure.Add(string.Join('/', parts.Take(i)));
        }
        string GroupKey(Entry entry)
        {
            var parts = entry.RelativePath.Split('/').SkipLast(1).ToArray();
            var depth = Math.Min(2, parts.Length);
            while (depth < parts.Length && impure.Contains(string.Join('/', parts.Take(depth)))) depth++;
            return string.Join('/', parts.Take(depth));
        }
        var groups = files.Where(f => f.Kind == "orphan").GroupBy(GroupKey, comparer)
            .Select(g => new
            {
                relativePath = g.Key, path = Path.Combine(root!, g.Key), name = g.Key.Split('/').Last(), loose = g.Key.Length == 0,
                bytes = g.Sum(f => f.Bytes), fileCount = g.Count(), folderDeletable = g.Key.Length > 0 && !impure.Contains(g.Key),
                files = g.OrderByDescending(f => f.Bytes).Take(12).Select(f => new { f.RelativePath, f.Path, f.Name, f.Bytes, f.ModifiedMs }).ToArray(),
                filesTruncated = g.Count() > 12, modifiedMs = g.Max(f => f.ModifiedMs),
            }).OrderByDescending(g => g.bytes).ThenBy(g => g.relativePath, comparer).ToArray();
        var diskBytes = files.Sum(f => f.Bytes);
        return new Dictionary<string, object?>
        {
            ["totalBytes"] = recent.Sum(r => Math.Max(0, r.SizeBytes)),
            ["ephemeralBytes"] = Bytes("EPHEMERAL"), ["keptBytes"] = Bytes("KEPT"), ["indeterminateBytes"] = Bytes("INDETERMINATE"),
            ["budgetBytes"] = config.MaxStorageBytes is { } cap ? Math.Min(20L * 1024 * 1024 * 1024, cap) : (long?)null,
            ["graceMs"] = 6L * 60 * 60 * 1000,
            ["items"] = recent.Select(r => new Dictionary<string, object?>
            {
                ["hash"] = r.Hash, ["name"] = r.Name, ["retentionPolicy"] = Policy(r), ["origin"] = r.Origin,
                ["sizeBytes"] = Math.Max(0, r.SizeBytes), ["progress"] = r.Progress, ["status"] = r.Status,
                ["lastUsedAt"] = r.LastUsedAt.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),
                ["savePath"] = r.SavePath, ["category"] = r.Category,
            }).ToArray(),
            ["diskBytes"] = authoritative ? diskBytes : (long?)null,
            ["orphanBytes"] = authoritative ? files.Where(f => f.Kind == "orphan").Sum(f => f.Bytes) : 0,
            ["orphans"] = authoritative ? groups.Take(100).ToArray() : [],
            ["disk"] = root is null ? null : new
            {
                root, status = unreadable.Contains(root) ? "unavailable" : authoritative ? "complete" : "partial",
                authoritative, observedBytes = diskBytes, trackedBytes = files.Where(f => f.Kind == "tracked").Sum(f => f.Bytes),
                internalBytes = files.Where(f => f.Kind == "internal").Sum(f => f.Bytes), fileCount = files.Count,
                orphanFileCount = files.Count(f => f.Kind == "orphan"), truncated = truncation.Count > 0, truncatedBy = truncation.ToArray(),
                groupsTruncated = groups.Length > 100, unreadablePaths = unreadable, linksSkipped = links,
                scannedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            },
        };
    }
}
