using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Media.Common;

public sealed record MediaClientConfig(string ClientType, string? BaseDownloadPath, string? SavePath, string? PreProbeScope)
{
    public bool IsBuiltin => ClientType == "builtin";
}

/// <summary>Reads the owner's client settings row (the Engine module provisions it; absent means built-in defaults).</summary>
public sealed class MediaSettings(IDbContextFactory<TorrentFlowDbContext> dbFactory)
{
    public async Task<MediaClientConfig> GetAsync(CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var row = await db.ClientSettings.AsNoTracking().FirstOrDefaultAsync(s => s.UserId == LocalUser.Id, ct);
        return row is null
            ? new MediaClientConfig("builtin", null, null, null)
            : new MediaClientConfig(string.IsNullOrWhiteSpace(row.ClientType) ? "builtin" : row.ClientType, row.BaseDownloadPath, row.SavePath, row.PreProbeScope);
    }
}

/// <summary>Filesystem locations for ffmpeg output. Mirrors the TS <c>.sessions</c> layout (vod/, subtitles/ reserved).</summary>
public sealed class MediaPaths
{
    public MediaPaths(IOptions<MediaOptions> options, IConfiguration configuration, IHostEnvironment env)
    {
        var dataDir = configuration["TorrentFlow:DataDirectory"] ?? Path.Combine(env.ContentRootPath, "data");
        SessionsDir = Path.GetFullPath(options.Value.SessionsDirectory is { Length: > 0 } s ? s : Path.Combine(dataDir, ".sessions"));
        ProbeDir = Path.Combine(Path.GetFullPath(dataDir), ".torrentflow", "swarm-probe");
    }

    internal MediaPaths(string sessionsDir)
    {
        SessionsDir = Path.GetFullPath(sessionsDir);
        ProbeDir = Path.Combine(SessionsDir, "swarm-probe");
    }

    public string SessionsDir { get; }
    public string VodDir => Path.Combine(SessionsDir, "vod");
    public string SubtitlesDir => Path.Combine(SessionsDir, "subtitles");
    public string ProbeDir { get; }
}

/// <summary>One completed, on-disk file of a verified transfer.</summary>
public sealed record CompletedFile(string RelativePath, string AbsolutePath, long Length, long MtimeMs, string RootPath);

/// <summary>
/// Port of src/lib/library/completed-media.ts (primary path): a transfer whose files were verified on disk at
/// completion is served straight from disk, with size + mtime re-checked so a replaced file is never trusted.
/// </summary>
public sealed class CompletedMedia(IDbContextFactory<TorrentFlowDbContext> dbFactory)
{
    public const double CompleteProgress = 0.9999;
    private static readonly string[] DeadStatuses = ["removed", "error", "missingFiles"];

    public async Task<IReadOnlyList<CompletedFile>?> GetManifestAsync(string infoHash, CancellationToken ct = default)
    {
        var files = await CompletedFilesAsync(infoHash, ct);
        return files is { Count: > 0 } && files.Any(f => MediaFiles.IsVideo(f.RelativePath)) ? files : null;
    }

    public async Task<CompletedFile?> ResolveAsync(string infoHash, string requestedPath, CancellationToken ct = default)
    {
        var requested = requestedPath.Replace('\\', '/').TrimStart('/');
        var files = await CompletedFilesAsync(infoHash, ct);
        return files?.FirstOrDefault(f => string.Equals(f.RelativePath, requested,
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal));
    }

    public async Task<List<CompletedFile>?> CompletedFilesAsync(string infoHash, CancellationToken ct = default)
    {
        var hash = infoHash.ToLowerInvariant();
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var row = await db.EngineTorrents.AsNoTracking()
            .Where(r => r.UserId == LocalUser.Id && r.Hash == hash && r.Progress >= CompleteProgress
                && !DeadStatuses.Contains(r.Status) && (r.VerifiedBitfield != null || r.VerifiedAt != null) && r.VerifiedFilesJson != null)
            .OrderByDescending(r => r.UpdatedAt)
            .FirstOrDefaultAsync(ct);
        return row is null ? null : FilesFromRow(row);
    }

    internal static List<CompletedFile>? FilesFromRow(EngineTorrent row)
    {
        if (row.Progress < CompleteProgress || string.IsNullOrWhiteSpace(row.SavePath)) return null;
        var root = Path.GetFullPath(row.SavePath);
        var result = new List<CompletedFile>();
        foreach (var fp in Fingerprints(row.VerifiedFilesJson, root))
        {
            var rel = Path.GetRelativePath(root, fp.Path).Replace('\\', '/');
            if (rel.Length == 0 || rel.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(rel)) continue;
            if (DiskLength(fp.Path, fp.Size, fp.MtimeMs) is not { } length) continue;
            result.Add(new CompletedFile(rel, fp.Path, length, fp.MtimeMs, root));
        }
        return result;
    }

    /// <summary>
    /// The TS engine recorded <c>{path: absolute, size, mtimeMs}</c>; the .NET engine records
    /// <c>{path: torrent-relative, size, mtimeMs, fullPath}</c>. Both are accepted.
    /// </summary>
    internal static IEnumerable<(string Path, long Size, long MtimeMs)> Fingerprints(string? json, string root)
    {
        if (string.IsNullOrWhiteSpace(json)) yield break;
        JsonElement arr;
        try { arr = JsonDocument.Parse(json).RootElement; }
        catch (JsonException) { yield break; }
        if (arr.ValueKind != JsonValueKind.Array) yield break;
        foreach (var e in arr.EnumerateArray())
        {
            if (e.ValueKind != JsonValueKind.Object) continue;
            var full = e.Str("fullPath");
            var path = e.Str("path");
            string? abs = full is { Length: > 0 } && Path.IsPathFullyQualified(full) ? full
                : path is { Length: > 0 } && Path.IsPathFullyQualified(path) ? path
                : path is { Length: > 0 } ? Path.Combine(root, path.Replace('/', Path.DirectorySeparatorChar)) : null;
            if (abs is null) continue;
            if (e.Num("size") is not { } size || !double.IsFinite(size) || size < 0) continue;
            if (e.Num("mtimeMs") is not { } mtime || !double.IsFinite(mtime)) continue;
            yield return (Path.GetFullPath(abs), (long)Math.Truncate(size), (long)Math.Truncate(mtime));
        }
    }

    /// <summary>The file's length when it still matches the recorded fingerprint, else null.</summary>
    internal static long? DiskLength(string path, long expectedLength, long? expectedMtimeMs)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length != expectedLength) return null;
            if (expectedMtimeMs is { } mt && Math.Abs(new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds() - mt) > 2000) return null;
            return info.Length;
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }
}
