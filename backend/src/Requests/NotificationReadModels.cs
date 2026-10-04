using System.Text;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Requests;

public sealed record ActivityPage(object[] Items, int Count, bool HasMore, string? NextCursor);
public sealed record ActivityUnreadCount(int Count, bool Capped);

public static class NotificationReadModels
{
    public static string Title(WorkRow work, IEnumerable<WorkNameRow> names)
    {
        var workNames = names.Where(n => n.WorkId == work.Id);
        return workNames.FirstOrDefault(n => n.Label == NameLabel.English)?.Value
            ?? workNames.FirstOrDefault()?.Value ?? work.WorkKey;
    }

    public static string ReleaseTitle(ReleaseRow? release) => release is null ? "Your download" :
        release.Name == release.Id ? release.Files?.FirstOrDefault()?.RelativePath ?? "Your download" : release.Name;

    public static async Task<ActivityPage> PageAsync(NotificationRepository db, string? filter,
        string? rawLimit, string? cursor, CancellationToken ct)
    {
        var limit = int.TryParse(rawLimit, out var parsed) && parsed > 0 ? Math.Min(parsed, 200) : 50;
        var rows = await ActivityAsync(db, ct);
        if (filter == "sent") rows = rows.Where(r => r["status"] is "sent").ToList();
        if (ParseCursor(cursor) is { } boundary)
            rows = rows.Where(r => (DateTimeOffset)r["createdAt"]! < boundary.Time ||
                (DateTimeOffset)r["createdAt"]! == boundary.Time &&
                boundary.Id is not null && string.CompareOrdinal((string)r["id"]!, boundary.Id) > 0).ToList();
        var items = rows.Take(limit).ToArray();
        var more = rows.Count > limit;
        return new(items.Cast<object>().ToArray(), items.Length, more,
            more ? Encode(items[^1]) : null);
    }

    public static async Task<ActivityUnreadCount> UnreadCountAsync(NotificationRepository db,
        string? since, CancellationToken ct)
    {
        var boundary = DateTimeOffset.TryParse(since, out var date) ? date : DateTimeOffset.MinValue;
        var rows = await ActivityAsync(db, ct);
        var count = rows.Count(r => (DateTimeOffset)r["createdAt"]! > boundary &&
            r["status"] is "sent" or "completed" or "failed" or "done" or "error" or "exhausted");
        return new(Math.Min(count, 100), count > 100);
    }

    private static async Task<List<Dictionary<string, object?>>> ActivityAsync(
        NotificationRepository db, CancellationToken ct)
    {
        var works = await db.AllAsync<WorkRow>(ct);
        var names = await db.AllAsync<WorkNameRow>(ct);
        var releases = await db.AllAsync<ReleaseRow>(ct);
        var rows = new List<Dictionary<string, object?>>();
        var attempts = (await db.AllAsync<AttemptRow>(ct)).AsEnumerable();
        var linked = (await db.AllAsync<DownloadTargetRow>(ct)).Select(l => l.DownloadId).ToHashSet();
        var raw = (await db.AllAsync<RawIntentRow>(ct)).Where(r => r.ActorUserId == "local")
            .Select(r => r.Id).ToHashSet();
        attempts = attempts.Concat((await db.AllAsync<DownloadRow>(ct)).Where(d =>
            d.FinishedAt is not null && !linked.Contains(d.Id) &&
            (d.RawIntentId is null || raw.Contains(d.RawIntentId)))
            .Select(d => new AttemptRow
            {
                Id = "download:" + d.Id, TargetId = null, WorkId = null, ReleaseHash = d.Hash,
                ActorUserId = "local", Kind = AttemptKind.Fetch, StartedAt = d.AddedAt,
                EndedAt = d.FinishedAt, Outcome = "Completed", ReasonCode = null,
                ReasonText = "Download ready", Decision = null, LegacyContext = null, BatchId = null,
                DownloadId = d.Id, DeadlineAt = null, Swap = null,
            }));
        foreach (var attempt in attempts.Where(a => (a.Kind != AttemptKind.LegacyEvent || a.TargetId is not null) &&
            a.ActorUserId is null or "local"))
        {
            var work = works.FirstOrDefault(w => w.Id == attempt.WorkId);
            var release = releases.FirstOrDefault(r => r.Id == attempt.ReleaseHash);
            var status = attempt.Outcome?.ToLowerInvariant() switch
            {
                "fetching" or "added" or "accepted" or "sent" => "sent",
                "done" or "filed" or "completed" => "completed",
                "failed" or "error" or "exhausted" => "failed",
                _ => attempt.Outcome?.ToLowerInvariant() ??
                    (attempt.EndedAt is null ? "searching" : "waiting"),
            };
            rows.Add(new()
            {
                ["id"] = "hist-" + attempt.Id,
                ["type"] = "history",
                ["title"] = work is null ? ReleaseTitle(release) : Title(work, names),
                ["status"] = status,
                ["message"] = attempt.ReasonText,
                ["kind"] = attempt.Kind.ToString().ToLowerInvariant(),
                ["magnet"] = release?.Magnet,
                ["infoHash"] = attempt.ReleaseHash,
                ["category"] = work is null ? null : work.Kind == WorkKind.Film ? "movie" : "tv",
                ["createdAt"] = attempt.EndedAt ?? attempt.StartedAt,
                ["language"] = release?.Parsed.LanguageMarkers is { IsEmpty: false } markers
                    ? string.Join(", ", markers) : null,
            });
        }
        return rows.OrderByDescending(r => (DateTimeOffset)r["createdAt"]!)
            .ThenBy(r => (string)r["id"]!, StringComparer.Ordinal).ToList();
    }

    private static string Encode(Dictionary<string, object?> row) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(
            $"{(DateTimeOffset)row["createdAt"]!:O}|{row["id"]}"))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static (DateTimeOffset Time, string? Id)? ParseCursor(string? cursor)
    {
        if (string.IsNullOrEmpty(cursor) || cursor.Length > 256) return null;
        if (DateTimeOffset.TryParse(cursor, out var legacy)) return (legacy, null);
        try
        {
            var raw = cursor.Replace('-', '+').Replace('_', '/');
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(
                raw.PadRight((raw.Length + 3) / 4 * 4, '='))).Split('|', 2);
            return parts.Length == 2 && DateTimeOffset.TryParse(parts[0], out var time)
                ? (time, parts[1]) : null;
        }
        catch (FormatException) { return null; }
    }
}
