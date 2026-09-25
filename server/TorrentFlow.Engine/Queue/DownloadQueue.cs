namespace TorrentFlow.Engine.Queue;

/// <summary>A durable row as the queue sees it (subset of EngineTorrent).</summary>
public sealed record QueueRow(
    string Hash,
    string Status,
    string Origin,
    DateTime CreatedAt,
    string? WorkId = null,
    string? QueueKey = null,
    DateTime? ForcedAt = null,
    long? SizeBytes = null);

public sealed record RehydratePlan(IReadOnlyList<string> Active, IReadOnlyList<string> Demote);

/// <summary>
/// Chronological queue for kept (non-stream) downloads.
///
/// Every live torrent costs its peer connections plus a piece cache (measured at 80-90 MB per torrent
/// under WebTorrent), so a 13-episode season blew past 1.3 GB. Only a few transfers stay live; the rest
/// are rows that are not in the client at all — a paused torrent still owns its wires and cache, so
/// pausing is not a substitute for never adding.
///
/// Order: within a series by (season, episode) via <see cref="QueueRow.QueueKey"/>; across works by the
/// work's earliest enqueue time, so a season grabbed first finishes before a season grabbed later even
/// when its episodes were enqueued out of order. Pure so the rules are testable without a client or DB.
/// </summary>
public static class DownloadQueue
{
    public const string QueuedStatus = "queued";
    public const int DefaultMaxActiveDownloads = 2;
    /// <summary>Only kept downloads are queued — streams and prewarm are never blocked.</summary>
    public const string QueueableOrigin = "user";

    /// <summary>Parses a cap the way the TypeScript engine reads TORRENTFLOW_MAX_ACTIVE_DOWNLOADS.</summary>
    public static int ParseMaxActive(string? raw)
    {
        raw = raw?.Trim();
        if (string.IsNullOrEmpty(raw)) return DefaultMaxActiveDownloads;
        if (!double.TryParse(raw, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var parsed)
            || !double.IsFinite(parsed))
            return DefaultMaxActiveDownloads;
        return Math.Max(1, (int)Math.Truncate(parsed));
    }

    /// <summary>Zero-padded so a plain string compare orders S2E10 after S2E9.</summary>
    public static string? QueueKeyForEpisode(int? season, int? episode)
    {
        if (season is null || episode is null || season < 0 || episode < 0) return null;
        return $"s{season.Value:D5}e{episode.Value:D5}";
    }

    public static bool IsQueued(QueueRow row) => string.Equals(row.Status, QueuedStatus, StringComparison.OrdinalIgnoreCase);

    public static bool IsForced(QueueRow row) => row.ForcedAt is not null;

    /// <summary>A kept download currently occupying a transfer slot.</summary>
    public static bool IsActiveKept(QueueRow row) =>
        row.Origin == QueueableOrigin && string.Equals(row.Status, "downloading", StringComparison.OrdinalIgnoreCase);

    public static int ActiveKeptCount(IEnumerable<QueueRow> rows) => rows.Count(IsActiveKept);

    private static string GroupKey(QueueRow row) =>
        string.IsNullOrWhiteSpace(row.WorkId) ? $"hash:{row.Hash}" : $"work:{row.WorkId.Trim()}";

    /// <summary>
    /// Total order over queued rows: work group by earliest enqueue, then episode position inside the group.
    /// Rows without a queueKey (films, one-offs) sort after the numbered ones in their group.
    /// </summary>
    public static List<QueueRow> Order(IEnumerable<QueueRow> rows)
    {
        var queued = rows.Where(IsQueued).ToList();
        var anchors = new Dictionary<string, DateTime>(StringComparer.Ordinal);
        foreach (var row in queued)
        {
            var key = GroupKey(row);
            if (!anchors.TryGetValue(key, out var current) || row.CreatedAt < current) anchors[key] = row.CreatedAt;
        }
        queued.Sort((a, b) =>
        {
            var ga = GroupKey(a);
            var gb = GroupKey(b);
            if (ga != gb)
            {
                var diff = anchors[ga].CompareTo(anchors[gb]);
                return diff != 0 ? diff : string.CompareOrdinal(ga, gb);
            }
            var ka = a.QueueKey?.Trim() ?? "";
            var kb = b.QueueKey?.Trim() ?? "";
            if (ka != kb)
            {
                if (ka.Length == 0) return 1;
                if (kb.Length == 0) return -1;
                return string.CompareOrdinal(ka, kb);
            }
            var t = a.CreatedAt.CompareTo(b.CreatedAt);
            return t != 0 ? t : string.CompareOrdinal(a.Hash, b.Hash);
        });
        return queued;
    }

    /// <summary>1-based queue position per lowercase hash, for the UI.</summary>
    public static Dictionary<string, int> Positions(IEnumerable<QueueRow> rows)
    {
        var map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var i = 0;
        foreach (var row in Order(rows)) map[row.Hash.ToLowerInvariant()] = ++i;
        return map;
    }

    /// <summary>Hashes that should start now: the head of the queue, enough to refill free slots.</summary>
    public static List<string> PromotionCandidates(IReadOnlyCollection<QueueRow> rows, int cap)
    {
        var free = Math.Max(0, cap - ActiveKeptCount(rows));
        return free == 0 ? [] : Order(rows).Take(free).Select(r => r.Hash).ToList();
    }

    /// <summary>Whether a fresh add has to wait. Forced adds never do, nor anything that is not a kept download.</summary>
    public static bool ShouldQueueNewDownload(IReadOnlyCollection<QueueRow> rows, int cap, string origin, bool forced)
    {
        if (forced) return false;
        if (origin != QueueableOrigin) return false;
        return ActiveKeptCount(rows) >= cap;
    }

    /// <summary>
    /// Startup plan. A database written before the queue existed (or by a crash mid-season) can hold a dozen
    /// rows marked downloading; re-adding them all is exactly the RAM blow-up the queue prevents. Forced rows
    /// always start, the earliest remaining rows fill what is left, everything else is demoted to queued.
    /// </summary>
    public static RehydratePlan PlanRehydrate(IReadOnlyCollection<QueueRow> rows, int cap)
    {
        var kept = rows.Where(r => r.Origin == QueueableOrigin
            && (string.Equals(r.Status, "downloading", StringComparison.OrdinalIgnoreCase) || IsQueued(r))).ToList();
        var forced = kept.Where(IsForced).ToList();
        var ordered = Order(kept.Where(r => !IsForced(r)).Select(r => r with { Status = QueuedStatus }));
        var free = Math.Max(0, cap - forced.Count);
        var active = forced.Select(r => r.Hash).Concat(ordered.Take(free).Select(r => r.Hash)).ToList();
        var activeSet = active.ToHashSet(StringComparer.Ordinal);
        return new RehydratePlan(active, kept.Where(r => !activeSet.Contains(r.Hash)).Select(r => r.Hash).ToList());
    }

    /// <summary>Bytes queued rows will claim once they start, for the storage gate.</summary>
    public static long QueuedReservedBytes(IEnumerable<QueueRow> rows) =>
        rows.Where(IsQueued).Sum(r => r.SizeBytes is > 0 ? r.SizeBytes.Value : 0);
}
