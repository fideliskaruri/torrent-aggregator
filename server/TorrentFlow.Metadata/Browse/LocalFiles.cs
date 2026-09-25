using System.Collections.Concurrent;
using System.Text.Json;
using TorrentFlow.Core.Contracts.Metadata;

namespace TorrentFlow.Metadata.Browse;

public enum LocalFilePresence { Unknown, Present, Absent }

public enum StatVerdict { Exists, Missing, Unknown }

/// <summary>src/lib/library/local-file-presence.ts: does the filesystem still hold a torrent's recorded files?</summary>
public static class LocalFiles
{
    public static readonly TimeSpan PresenceTtl = TimeSpan.FromSeconds(30);
    private static readonly ConcurrentDictionary<string, (DateTimeOffset At, LocalFilePresence Value)> Cache = new(StringComparer.Ordinal);

    public sealed record Evidence(int FilesRecorded, int FilesFound, int FilesMissing, StatVerdict SavePath);

    public static void ResetCache() => Cache.Clear();

    public static LocalFilePresence Classify(Evidence evidence)
    {
        if (evidence.FilesFound > 0) return LocalFilePresence.Present;
        if (evidence.FilesRecorded > 0 && evidence.FilesMissing == evidence.FilesRecorded) return LocalFilePresence.Absent;
        return evidence.SavePath == StatVerdict.Missing ? LocalFilePresence.Absent : LocalFilePresence.Unknown;
    }

    public static StatVerdict DiskStat(string target)
    {
        try { return File.Exists(target) || Directory.Exists(target) ? StatVerdict.Exists : StatVerdict.Missing; }
        catch { return StatVerdict.Unknown; }
    }

    /// <summary>recordedFilePaths: trimmed non-empty <c>path</c> strings of a verifiedFilesJson array.</summary>
    public static List<string> RecordedFilePaths(string? verifiedFilesJson, bool trim = true)
    {
        if (string.IsNullOrWhiteSpace(verifiedFilesJson)) return [];
        try
        {
            using var doc = JsonDocument.Parse(verifiedFilesJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return [];
            return doc.RootElement.EnumerateArray()
                .Select(e => e.ValueKind == JsonValueKind.Object && e.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String
                    ? trim ? p.GetString()!.Trim() : p.GetString()! : "")
                .Where(p => p.Length > 0).ToList();
        }
        catch (JsonException) { return []; }
    }

    public static Evidence Collect(string? savePath, string? verifiedFilesJson, Func<string, StatVerdict>? stat = null)
    {
        stat ??= DiskStat;
        var paths = RecordedFilePaths(verifiedFilesJson);
        int found = 0, missing = 0;
        foreach (var verdict in paths.Select(stat))
        {
            if (verdict == StatVerdict.Exists) found++;
            else if (verdict == StatVerdict.Missing) missing++;
        }
        var save = savePath?.Trim();
        return new(paths.Count, found, missing, string.IsNullOrEmpty(save) ? StatVerdict.Unknown : stat(save));
    }

    public static LocalFilePresence Presence(string hash, string? savePath, string? verifiedFilesJson,
        Func<string, StatVerdict>? stat = null, DateTimeOffset? now = null)
    {
        var at = now ?? DateTimeOffset.UtcNow;
        var key = $"{hash}|{savePath ?? ""}|{verifiedFilesJson?.Length ?? 0}";
        if (Cache.TryGetValue(key, out var hit) && at - hit.At < PresenceTtl) return hit.Value;
        var value = Classify(Collect(savePath, verifiedFilesJson, stat));
        Cache[key] = (at, value);
        return value;
    }

    /// <summary>localFilePresenceLookup: one memoised probe per row, looked up by lower-cased hash.</summary>
    public static Func<string, LocalFilePresence> Lookup(IEnumerable<Data.Entities.EngineTorrent> rows, Func<string, StatVerdict>? stat = null)
    {
        var byHash = new Dictionary<string, LocalFilePresence>(StringComparer.Ordinal);
        foreach (var row in rows) byHash[row.Hash.Trim().ToLowerInvariant()] = Presence(row.Hash, row.SavePath, row.VerifiedFilesJson, stat);
        return hash => byHash.GetValueOrDefault(hash.Trim().ToLowerInvariant(), LocalFilePresence.Unknown);
    }

    /// <summary>builtin-engine-lifecycle.ts persistedTorrentIsDownloaded.</summary>
    public static bool PersistedTorrentIsDownloaded(double progress, string? verifiedBitfield, string? verifiedFilesJson)
    {
        var paths = RecordedFilePaths(verifiedFilesJson, trim: false);
        return progress >= 0.9999 && !string.IsNullOrWhiteSpace(verifiedBitfield) && paths.Count > 0
            && paths.Any(ReleaseNames.IsSupportedVideoFileName);
    }
}

/// <summary>Default <see cref="ITorrentPresenceProbe"/>: no in-process engine handle is visible to Metadata.</summary>
public sealed class UnknownTorrentPresenceProbe : ITorrentPresenceProbe
{
    public TorrentPresence Presence(string userId, string infoHash) => TorrentPresence.Unknown;
}
