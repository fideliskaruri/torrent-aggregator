using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;

namespace TorrentFlow.Library.Features.Activity;

public sealed record ActivityCursor(DateTime Time, string? Id);
public sealed record ActivityRow(string Id, string Type, string Title, string Status, string? Message,
    string? Source, string? Kind, string? Query, string? Magnet, string? InfoHash, string? SavePath,
    string? Category, string? Context, string? ClientType, string? SendKind, DateTime CreatedAt)
{
    public Dictionary<string, object?> Json() => LibraryJson.Row(this);
}

public sealed class ActivityService(IDbContextFactory<TorrentFlowDbContext> factory)
{
    public static string Encode(ActivityRow item) => Convert.ToBase64String(Encoding.UTF8.GetBytes($"{LibraryJson.Iso(item.CreatedAt)}|{item.Id}"))
        .TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public static ActivityCursor? Parse(string? raw)
    {
        raw = raw?.Trim();
        if (string.IsNullOrEmpty(raw) || raw.Length > 256) return null;
        if (!Regex.IsMatch(raw, "^[A-Za-z0-9_-]+$"))
            return DateTime.TryParse(raw, out var legacy) ? new(legacy.ToUniversalTime(), null) : null;
        try
        {
            var text = raw.Replace('-', '+').Replace('_', '/');
            text = text.PadRight((text.Length + 3) / 4 * 4, '=');
            var bytes = Convert.FromBase64String(text);
            if (Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') != raw) return null;
            var decoded = Encoding.UTF8.GetString(bytes).Split('|', 2);
            return decoded.Length == 2 && decoded[1].Length <= 128 && Regex.IsMatch(decoded[1], "^(grab|hist)-.+$") &&
                DateTime.TryParse(decoded[0], out var date) ? new(date.ToUniversalTime(), decoded[1]) : null;
        }
        catch (FormatException) { return null; }
    }
    public static int Limit(string? raw) => int.TryParse(Regex.Match(raw ?? "", @"^[+-]?\d+").Value, out var value) && value > 0 ? Math.Min(value, 200) : 50;
    private static bool After(ActivityRow row, ActivityCursor c) => row.CreatedAt < c.Time ||
        row.CreatedAt == c.Time && c.Id != null && string.CompareOrdinal(row.Id, c.Id) > 0;
    public static IReadOnlyList<ActivityRow> Reconcile(IEnumerable<ActivityRow> rows)
    {
        var all = rows.ToList();
        var history = all.Where(x => x.Type == "history").OrderByDescending(x => x.CreatedAt).ToList();
        var result = new List<ActivityRow>();
        foreach (var grab in all.Where(x => x.Type == "grab").OrderByDescending(x => x.CreatedAt))
        {
            var identity = grab.InfoHash ?? grab.Magnet?.Trim();
            var twin = identity == null ? null : history.Where(h => h.Status == grab.Status &&
                (h.InfoHash ?? h.Magnet?.Trim()) == identity && Math.Abs((h.CreatedAt - grab.CreatedAt).TotalMilliseconds) <= 1000)
                .OrderBy(h => Math.Abs((h.CreatedAt - grab.CreatedAt).TotalMilliseconds)).FirstOrDefault();
            if (twin == null) { result.Add(grab); continue; }
            history.Remove(twin);
            result.Add(grab with { Message = twin.Message ?? grab.Message, Source = grab.Source ?? twin.Source,
                Magnet = grab.Magnet ?? twin.Magnet, InfoHash = grab.InfoHash ?? twin.InfoHash,
                SavePath = grab.SavePath ?? twin.SavePath, Category = grab.Category ?? twin.Category,
                Context = twin.Context ?? grab.Context, ClientType = twin.ClientType ?? grab.ClientType,
                SendKind = twin.SendKind ?? grab.SendKind, CreatedAt = twin.CreatedAt > grab.CreatedAt ? twin.CreatedAt : grab.CreatedAt });
        }
        return result.Concat(history).OrderByDescending(x => x.CreatedAt).ThenBy(x => x.Id, StringComparer.Ordinal).ToList();
    }
    private static ActivityRow Map(GrabJob x) => new($"grab-{x.Id}", "grab", x.Title, x.Status, x.Message, x.Source, x.Kind, x.Query,
        x.Magnet, LibraryJson.Hash(x.InfoHash) ?? LibraryJson.Hash(x.Magnet), x.SavePath, x.Category, null, null, null, x.CreatedAt);
    private static ActivityRow Map(DownloadHistory x) => new($"hist-{x.Id}", "history", x.Title, x.Status, x.Message, x.Source, null, null,
        x.Magnet, LibraryJson.Hash(x.InfoHash) ?? LibraryJson.Hash(x.Magnet), x.SavePath, x.Category, x.Context, x.ClientType, x.SendKind, x.CreatedAt);

    public async Task<object> Page(string? filter, string? rawLimit, string? rawCursor, CancellationToken ct)
    {
        var limit = Limit(rawLimit);
        var cursor = Parse(rawCursor);
        var take = limit + 11;
        await using var db = await factory.CreateDbContextAsync(ct);
        var g = db.GrabJobs.AsNoTracking().Where(x => x.UserId == LocalUser.Id && x.Retention != "stream" && (filter != "sent" || x.Status == "sent"));
        var h = db.DownloadHistories.AsNoTracking().Where(x => x.UserId == LocalUser.Id && x.Retention != "stream" && (filter != "sent" || x.Status == "sent"));
        var gp = g;
        var hp = h;
        var overlap = new List<ActivityRow>();
        if (cursor != null)
        {
            var boundary = cursor.Time;
            var prefix = cursor.Id?.Split('-', 2)[0];
            var id = cursor.Id?.Split('-', 2).ElementAtOrDefault(1);
            gp = gp.Where(x => x.CreatedAt < boundary || x.CreatedAt == boundary &&
                (prefix == "grab" && string.Compare(x.Id, id) > 0));
            hp = hp.Where(x => x.CreatedAt < boundary || x.CreatedAt == boundary &&
                (prefix == "grab" || prefix == "hist" && string.Compare(x.Id, id) > 0));
            var end = boundary.AddSeconds(1);
            overlap.AddRange((await g.Where(x => x.CreatedAt > boundary && x.CreatedAt < end).OrderBy(x => x.CreatedAt).ThenByDescending(x => x.Id).Take(limit + 10).ToListAsync(ct)).Select(Map));
            overlap.AddRange((await h.Where(x => x.CreatedAt > boundary && x.CreatedAt < end).OrderBy(x => x.CreatedAt).ThenByDescending(x => x.Id).Take(limit + 10).ToListAsync(ct)).Select(Map));
        }
        var jobs = await gp.OrderByDescending(x => x.CreatedAt).ThenBy(x => x.Id).Take(take).ToListAsync(ct);
        var histories = await hp.OrderByDescending(x => x.CreatedAt).ThenBy(x => x.Id).Take(take).ToListAsync(ct);
        var merged = Reconcile(jobs.Select(Map).Concat(histories.Select(Map)).Concat(overlap)).Where(x => cursor == null || After(x, cursor)).ToList();
        var items = merged.Take(limit).ToList();
        var more = items.Count > 0 && (merged.Count > limit || jobs.Count >= take || histories.Count >= take);
        return LibraryJson.Object(("items", items.Select(x => x.Json())), ("count", items.Count), ("hasMore", more), ("nextCursor", more ? Encode(items[^1]) : null));
    }

    public async Task<object> Unread(string? rawSince, CancellationToken ct)
    {
        DateTime? since = DateTime.TryParse(rawSince, out var date) ? date.ToUniversalTime() : null;
        string[] statuses = ["sent", "completed", "downloaded", "done", "failed", "error", "exhausted"];
        await using var db = await factory.CreateDbContextAsync(ct);
        var jobs = await db.GrabJobs.Where(x => x.UserId == LocalUser.Id && x.Retention != "stream" && statuses.Contains(x.Status) && (since == null || x.CreatedAt > since))
            .OrderByDescending(x => x.CreatedAt).ThenBy(x => x.Id).Take(101).ToListAsync(ct);
        var history = await db.DownloadHistories.Where(x => x.UserId == LocalUser.Id && x.Retention != "stream" && statuses.Contains(x.Status) && (since == null || x.CreatedAt > since))
            .OrderByDescending(x => x.CreatedAt).ThenBy(x => x.Id).Take(101).ToListAsync(ct);
        var rows = Reconcile(jobs.Select(Map).Concat(history.Select(Map)));
        return new { count = Math.Min(rows.Count, 100), capped = rows.Count > 100 || jobs.Count >= 101 || history.Count >= 101 };
    }
}
