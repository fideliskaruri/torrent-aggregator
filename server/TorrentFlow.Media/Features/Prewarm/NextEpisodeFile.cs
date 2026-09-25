using System.Text.Json;

namespace TorrentFlow.Media.Features.Prewarm;

/// <summary>Which file inside an already-held torrent is a given episode (src/lib/prewarm/next-episode-file.ts). Pure.</summary>
public static class NextEpisodeFile
{
    /// <summary>
    /// Files recorded in VerifiedFilesJson. Accepts the .NET engine's manifest (<c>{path, size, mtimeMs, fullPath}</c>,
    /// fullPath absolute) and the Next.js shape (<c>{path, size}</c>, path absolute).
    /// </summary>
    public static List<(string Path, long Size)> HeldFiles(string? verifiedFilesJson)
    {
        List<(string, long)> output = [];
        if (string.IsNullOrWhiteSpace(verifiedFilesJson)) return output;
        try
        {
            using var doc = JsonDocument.Parse(verifiedFilesJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return output;
            foreach (var entry in doc.RootElement.EnumerateArray())
            {
                if (entry.ValueKind != JsonValueKind.Object) continue;
                string? path = null;
                if (entry.TryGetProperty("fullPath", out var full) && full.ValueKind == JsonValueKind.String) path = full.GetString();
                if (string.IsNullOrEmpty(path) && entry.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String) path = p.GetString();
                if (string.IsNullOrEmpty(path)) continue;
                long size = 0;
                if (entry.TryGetProperty("size", out var s) && s.ValueKind == JsonValueKind.Number && s.TryGetInt64(out var n) && n >= 0) size = n;
                output.Add((path, size));
            }
        }
        catch (JsonException)
        {
            output.Clear();
        }
        return output;
    }

    /// <summary>The torrent-relative (forward-slash) path of an absolute file, or null when it is outside the save root.</summary>
    public static string? TorrentRelativeFilePath(string? savePath, string absolutePath)
    {
        var root = savePath?.Trim();
        if (string.IsNullOrEmpty(root) || !Path.IsPathFullyQualified(absolutePath)) return null;
        var relative = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(absolutePath));
        if (relative.Length == 0 || relative == "." || relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relative)) return null;
        return relative.Replace('\\', '/');
    }

    /// <summary>The torrent-relative path of season×episode inside this torrent, or null (no deterministic answer).</summary>
    public static string? EpisodeFileInTorrent(string? savePath, string? verifiedFilesJson, int? season, int? episode)
    {
        if (season is not { } s || episode is not { } e) return null;
        var files = HeldFiles(verifiedFilesJson);
        if (files.Count == 0) return null;
        if (!ReleaseText.PackEpisodeFiles(files, s).TryGetValue(e, out var absolute)) return null;
        return TorrentRelativeFilePath(savePath, absolute);
    }
}
