using System.Text.Json;
using TorrentFlow.Core.Contracts.Metadata;

namespace TorrentFlow.Metadata.Browse;

public enum LocalFilePresence { Unknown, Present, Absent }

public enum StatVerdict { Exists, Missing, Unknown }

/// <summary>src/lib/library/local-file-presence.ts: does the filesystem still hold a torrent's recorded files?</summary>
public static class LocalFiles
{
    public sealed record Evidence(int FilesRecorded, int FilesFound, int FilesMissing, StatVerdict SavePath);

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

    /// <summary>
    /// recordedFilePaths: the trimmed non-empty on-disk locations in a verifiedFilesJson array. The TS engine records an
    /// absolute <c>path</c>; the .NET engine records a torrent-relative <c>path</c> plus the absolute <c>fullPath</c>,
    /// which the content layout rewrites on a move and nulls for discarded junk. An entry that carries
    /// <c>fullPath</c> is located by it alone.
    /// </summary>
    public static List<string> RecordedFilePaths(string? verifiedFilesJson, bool trim = true)
    {
        if (string.IsNullOrWhiteSpace(verifiedFilesJson)) return [];
        try
        {
            using var doc = JsonDocument.Parse(verifiedFilesJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return [];
            return doc.RootElement.EnumerateArray()
                .Select(e => e.ValueKind != JsonValueKind.Object ? ""
                    : e.TryGetProperty("fullPath", out var full) ? full.ValueKind == JsonValueKind.String ? full.GetString()! : ""
                    : e.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String ? p.GetString()! : "")
                .Select(p => trim ? p.Trim() : p)
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

    /// <summary>A one-shot lookup (no memo) keyed by lower-cased hash; tests and pure rules use this.</summary>
    public static Func<string, LocalFilePresence> Lookup(IEnumerable<Data.Entities.EngineTorrent> rows, Func<string, StatVerdict>? stat = null)
    {
        var byHash = new Dictionary<string, LocalFilePresence>(StringComparer.Ordinal);
        foreach (var row in rows) byHash[row.Hash.Trim().ToLowerInvariant()] = Classify(Collect(row.SavePath, row.VerifiedFilesJson, stat));
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


/// <summary>
/// localFilePresenceLookup with its 30 s memo: one disk probe per torrent row per window, so a browse render does not
/// stat every recorded file on each request. Singleton; the memo is instance state rather than a module global.
/// </summary>
public sealed class LocalFilePresenceCache(TimeProvider time)
{
    public static readonly TimeSpan PresenceTtl = TimeSpan.FromSeconds(30);
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, (DateTimeOffset At, LocalFilePresence Value)> _memo = new(StringComparer.Ordinal);

    /// <summary>Replaceable for tests; defaults to the real filesystem.</summary>
    public Func<string, StatVerdict> Stat { get; init; } = LocalFiles.DiskStat;

    public LocalFilePresence Presence(string hash, string? savePath, string? verifiedFilesJson)
    {
        var now = time.GetUtcNow();
        var key = $"{hash}|{savePath ?? ""}|{verifiedFilesJson?.Length ?? 0}";
        if (_memo.TryGetValue(key, out var hit) && now - hit.At < PresenceTtl) return hit.Value;
        var value = LocalFiles.Classify(LocalFiles.Collect(savePath, verifiedFilesJson, Stat));
        _memo[key] = (now, value);
        return value;
    }

    public Func<string, LocalFilePresence> Lookup(IEnumerable<Data.Entities.EngineTorrent> rows)
    {
        var byHash = new Dictionary<string, LocalFilePresence>(StringComparer.Ordinal);
        foreach (var row in rows) byHash[row.Hash.Trim().ToLowerInvariant()] = Presence(row.Hash, row.SavePath, row.VerifiedFilesJson);
        return hash => byHash.GetValueOrDefault(hash.Trim().ToLowerInvariant(), LocalFilePresence.Unknown);
    }

    public void Reset() => _memo.Clear();
}