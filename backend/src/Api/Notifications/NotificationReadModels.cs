using System.Text;
using TorrentFlow.Api.Catalog;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Api.Notifications;

internal static class NotificationReadModels
{
    internal static string Title(WorkRow work, WorkNameRow[] names) =>
        CatalogProjection.Title(new WorkSnapshot(work, [.. names.Where(n => n.WorkId == work.Id)], [], [], []));

    internal static string ReleaseTitle(ReleaseRow? release) => release is null ? "Your download" :
        release.Name == release.Id ? release.Files?.FirstOrDefault()?.RelativePath ?? "Your download" : release.Name;

    internal static void MapActivity(this WebApplication app)
    {
        app.MapGet("/api/activity", async (NotificationRepository db, string? filter, string? limit,
            string? cursor, CancellationToken ct) => await PageAsync(db, filter, limit, cursor, ct));
        app.MapGet("/api/activity/unread", async (NotificationRepository db, string? since, CancellationToken ct) =>
        {
            var boundary = DateTimeOffset.TryParse(since, out var date) ? date : DateTimeOffset.MinValue;
            var rows = await ActivityAsync(db, ct);
            var count = rows.Count(r => (DateTimeOffset)r["createdAt"]! > boundary &&
                r["status"] is "sent" or "completed" or "failed" or "done" or "error" or "exhausted");
            return Results.Ok(new { count = Math.Min(count, 100), capped = count > 100 });
        });
    }

    private static async Task<IResult> PageAsync(NotificationRepository db, string? filter,
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
        return Results.Json(new { items, count = items.Length, hasMore = more,
            nextCursor = more ? Encode(items[^1]) : null }, CatalogProjection.Json);
    }

    private static async Task<List<Dictionary<string, object?>>> ActivityAsync(NotificationRepository db, CancellationToken ct)
    {
        var works = await db.AllAsync<WorkRow>(ct);
        var names = await db.AllAsync<WorkNameRow>(ct);
        var releases = await db.AllAsync<ReleaseRow>(ct);
        var rows = new List<Dictionary<string, object?>>();
        var attempts = (await db.AllAsync<AttemptRow>(ct)).AsEnumerable();
        var linked = (await db.AllAsync<DownloadTargetRow>(ct)).Select(l => l.DownloadId).ToHashSet();
        var raw = (await db.AllAsync<RawIntentRow>(ct)).Where(r => r.ActorUserId == "local").Select(r => r.Id).ToHashSet();
        attempts = attempts.Concat((await db.AllAsync<DownloadRow>(ct)).Where(d =>
            d.FinishedAt is not null && !linked.Contains(d.Id) && (d.RawIntentId is null || raw.Contains(d.RawIntentId)))
            .Select(d => new AttemptRow("download:" + d.Id, null, null, d.Hash, "local", AttemptKind.Fetch,
                d.AddedAt, d.FinishedAt, "Completed", null, "Download ready", null, null, null, d.Id, null, null)));
        foreach (var a in attempts.Where(a =>
            !a.Id.StartsWith("commit:", StringComparison.Ordinal) &&
            (a.ActorUserId is null or "local")))
        {
            var work = works.FirstOrDefault(w => w.Id == a.WorkId);
            var release = releases.FirstOrDefault(r => r.Id == a.ReleaseHash);
            var status = a.Outcome?.ToLowerInvariant() switch
            {
                "fetching" or "added" or "accepted" or "sent" => "sent",
                "done" or "filed" or "completed" => "completed",
                "failed" or "error" or "exhausted" => "failed",
                _ => a.Outcome?.ToLowerInvariant() ?? (a.EndedAt is null ? "searching" : "waiting"),
            };
            rows.Add(new()
            {
                ["id"] = "hist-" + a.Id, ["type"] = "history",
                ["title"] = work is null ? ReleaseTitle(release) : Title(work, names),
                ["status"] = status, ["message"] = a.ReasonText, ["kind"] = a.Kind.ToString().ToLowerInvariant(),
                ["magnet"] = release?.Magnet, ["infoHash"] = a.ReleaseHash,
                ["category"] = work is null ? null : work.Kind == WorkKind.Film ? "movie" : "tv",
                ["createdAt"] = a.EndedAt ?? a.StartedAt,
                ["language"] = release?.Parsed.LanguageMarkers is { IsEmpty: false } markers
                    ? string.Join(", ", markers) : null,
            });
        }
        return rows.OrderByDescending(r => (DateTimeOffset)r["createdAt"]!)
            .ThenBy(r => (string)r["id"]!, StringComparer.Ordinal).ToList();
    }

    private static string Encode(Dictionary<string, object?> row) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes($"{(DateTimeOffset)row["createdAt"]!:O}|{row["id"]}"))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static (DateTimeOffset Time, string? Id)? ParseCursor(string? cursor)
    {
        if (string.IsNullOrEmpty(cursor) || cursor.Length > 256) return null;
        if (DateTimeOffset.TryParse(cursor, out var legacy)) return (legacy, null);
        try
        {
            var raw = cursor.Replace('-', '+').Replace('_', '/');
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(raw.PadRight((raw.Length + 3) / 4 * 4, '='))).Split('|', 2);
            return parts.Length == 2 && DateTimeOffset.TryParse(parts[0], out var time) ? (time, parts[1]) : null;
        }
        catch (FormatException) { return null; }
    }

}
