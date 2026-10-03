using System.Text;
using TorrentFlow.Api.Catalog;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Api.Notifications;

internal sealed record TimelineWaitReason(string Reason, string Text, DateTimeOffset? Until, DateTimeOffset? Since);
internal sealed record TimelineEntry(string Id, string Kind, string Title, string? Episode, string? PosterUrl,
    DateTimeOffset? At, DateTimeOffset? NextCheckAt, string Lane, int? QueuePosition, TimelineWaitReason WaitReason,
    string? WorkKey = null, string? TargetId = null, string State = "expected", string Release = "episode",
    bool Followed = false, bool GrabNow = false, int? Quality = null, string? MediaType = null);

internal static class NotificationReadModels
{
    internal static string Title(WorkRow work, WorkNameRow[] names) =>
        CatalogProjection.Title(new WorkSnapshot(work, [.. names.Where(n => n.WorkId == work.Id)], [], [], []));

    internal static string ReleaseTitle(ReleaseRow? release) => release is null ? "Your download" :
        release.Name == release.Id ? release.Files?.FirstOrDefault()?.RelativePath ?? "Your download" : release.Name;

    internal static void MapActivity(this WebApplication app)
    {
        app.MapGet("/api/activity", async (NotificationRepository db, string? filter, string? limit,
            string? cursor, CancellationToken ct) => await PageAsync(db, filter, limit, cursor, null, ct));
        app.MapGet("/api/activity/unread", async (NotificationRepository db, string? since, CancellationToken ct) =>
        {
            var boundary = DateTimeOffset.TryParse(since, out var date) ? date : DateTimeOffset.MinValue;
            var rows = await ActivityAsync(db, null, ct);
            var count = rows.Count(r => (DateTimeOffset)r["createdAt"]! > boundary &&
                r["status"] is "sent" or "completed" or "failed" or "done" or "error" or "exhausted");
            return Results.Ok(new { count = Math.Min(count, 100), capped = count > 100 });
        });
        app.MapGet("/api/title/{workKey}/timeline", async (NotificationRepository db, string workKey,
            string? limit, string? cursor, CancellationToken ct) =>
            await PageAsync(db, null, limit, cursor, workKey, ct));
        app.MapGet("/api/timeline", TimelineAsync);
        app.MapPost("/api/timeline/{targetId}/grab-now", async (string targetId,
            TorrentFlow.Targets.TargetPipeline pipeline, CancellationToken ct) =>
        {
            try { return Results.Json(await pipeline.ActionAsync(targetId, TargetAction.DownloadNow, ct), CatalogProjection.Json); }
            catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
            catch (KeyNotFoundException) { return Results.NotFound(new { error = "This item is no longer scheduled." }); }
        });
    }

    private static async Task<IResult> PageAsync(NotificationRepository db, string? filter,
        string? rawLimit, string? cursor, string? workKey, CancellationToken ct)
    {
        var limit = int.TryParse(rawLimit, out var parsed) && parsed > 0 ? Math.Min(parsed, 200) : 50;
        var rows = await ActivityAsync(db, workKey, ct);
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

    private static async Task<List<Dictionary<string, object?>>> ActivityAsync(NotificationRepository db,
        string? workKey, CancellationToken ct)
    {
        var works = await db.AllAsync<WorkRow>(ct);
        var names = await db.AllAsync<WorkNameRow>(ct);
        var releases = await db.AllAsync<ReleaseRow>(ct);
        var workId = workKey is null ? null : works.FirstOrDefault(w => w.WorkKey == workKey || w.Id == workKey)?.Id;
        if (workKey is not null && workId is null) return [];
        var rows = new List<Dictionary<string, object?>>();
        var attempts = (await db.AllAsync<AttemptRow>(ct)).AsEnumerable();
        var linked = (await db.AllAsync<DownloadTargetRow>(ct)).Select(l => l.DownloadId).ToHashSet();
        var raw = (await db.AllAsync<RawIntentRow>(ct)).Where(r => r.ActorUserId == "local").Select(r => r.Id).ToHashSet();
        attempts = attempts.Concat((await db.AllAsync<DownloadRow>(ct)).Where(d =>
            d.FinishedAt is not null && !linked.Contains(d.Id) && (d.RawIntentId is null || raw.Contains(d.RawIntentId)))
            .Select(d => new AttemptRow("download:" + d.Id, null, null, d.Hash, "local", AttemptKind.Fetch,
                d.AddedAt, d.FinishedAt, "Completed", null, "Download ready", null, null, null, d.Id, null, null)));
        foreach (var a in attempts.Where(a =>
            !a.Id.StartsWith("commit:", StringComparison.Ordinal) && (workId is null || a.WorkId == workId) &&
            (a.ActorUserId is null or "local")))
        {
            var work = works.FirstOrDefault(w => w.Id == a.WorkId);
            var release = releases.FirstOrDefault(r => r.Id == a.ReleaseHash);
            string? Legacy(string key) => LegacyActivityText.Field(a.LegacyContext, key);
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
                ["title"] = work is null ? Legacy("title") ?? ReleaseTitle(release) : Title(work, names),
                ["status"] = status, ["message"] = LegacyActivityText.Read(a.ReasonText, a.Outcome),
                ["source"] = Legacy("source"), ["kind"] = Legacy("kind") ?? a.Kind.ToString().ToLowerInvariant(),
                ["query"] = Legacy("query"),
                ["magnet"] = release?.Magnet, ["infoHash"] = a.ReleaseHash, ["savePath"] = Legacy("savePath"),
                ["category"] = work is null ? Legacy("category") : work.Kind == WorkKind.Film ? "movie" : "tv",
                ["context"] = Legacy("context"), ["clientType"] = Legacy("clientType") ?? "builtin",
                ["sendKind"] = Legacy("sendKind"),
                ["createdAt"] = a.EndedAt ?? a.StartedAt,
                ["rung"] = Legacy("rung") ?? (work is null ? a.Kind.ToString().ToLowerInvariant() :
                    (work.Kind == WorkKind.Film ? "film: " : "series: ") + Title(work, names)),
                ["language"] = Legacy("language") ?? (release?.Parsed.LanguageMarkers is { IsEmpty: false } markers
                    ? string.Join(", ", markers) : "Language not stated"),
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

    private static async Task<IResult> TimelineAsync(NotificationRepository db, IEngine engine,
        IConfiguration configuration, string? workKey, CancellationToken ct)
    {
        var works = await db.AllAsync<WorkRow>(ct);
        var names = await db.AllAsync<WorkNameRow>(ct);
        var episodes = await db.AllAsync<EpisodeRow>(ct);
        var seasons = await db.AllAsync<SeasonRow>(ct);
        var followSet = (await db.AllAsync<FollowRow>(ct)).Where(f => f.Enabled).Select(f => f.WorkId).ToHashSet();
        var targets = (await db.AllAsync<TargetRow>(ct)).Where(t => t.State is not (TargetState.Done or TargetState.Removed)
            && (workKey is null || works.Any(w => w.Id == t.WorkId && w.WorkKey == workKey))).ToArray();
        var entries = new List<TimelineEntry>();
        var unavailable = false;
        var live = await engine.SnapshotAsync(ct);
        var checksEnabled = !configuration.GetValue<bool>("TorrentFlow:Scheduler:Disabled");
        var queued = targets.Where(t => t.State == TargetState.Wanted || t.State == TargetState.Fetching)
            .Where(t => live.All(s => s.Hash != t.ChosenReleaseHash || !s.Active && !s.Complete))
            .OrderByDescending(t => t.NowAt is not null).ThenBy(t => t.Priority).ThenBy(t => t.Rank)
            .ThenBy(t => t.CreatedAt).ToArray();
        foreach (var t in targets)
        {
            var work = works.FirstOrDefault(w => w.Id == t.WorkId);
            if (work is null) continue;
            var ep = episodes.FirstOrDefault(e => e.Id == t.EpisodeId);
            var season = seasons.FirstOrDefault(s => s.Id == ep?.SeasonId);
            var expected = CalendarDates.Expected(t, ep, work);
            unavailable |= t.EpisodeId is not null && expected is null;
            var future = expected > DateTimeOffset.UtcNow;
            var reason = future ? "NotAiredYet" : t.ReasonCode switch
            {
                WaitReason.DownloadWindow => "OutsideWindow", WaitReason.DownloadCap => "QueueFull",
                WaitReason.WaitingForSeeders => "WaitingForSeeders",
                _ => t.NextTryAt > DateTimeOffset.UtcNow ? "NextCheckScheduled" : "None",
            };
            var downloading = live.Any(s => s.Hash == t.ChosenReleaseHash && s.Active && !s.Complete);
            var state = downloading ? "downloading" : t.State is TargetState.Filing ? "downloading" :
                t.ChosenReleaseHash is not null || t.State is TargetState.Fetching or TargetState.Planning ? "found" :
                future ? "expected" : "searching";
            var release = CalendarDates.Release(ep is not null, expected, work);
            TimelineEntry Entry(string kind, DateTimeOffset? at) => new(kind + ":" + t.Id, kind,
                Title(work, names), ep is null ? null : $"S{season?.Number ?? 1:00}E{ep.Number:00}",
                work.PosterUrl, at, kind == "airs" ? null : t.NextTryAt,
                t.Origin == IntentOrigin.Owner ? "owner" : "background",
                kind == "queued" ? Array.IndexOf(queued, t) + 1 : null,
                new(reason, future ? "Not aired yet" : t.ReasonText ?? "Ready",
                    future ? expected : t.NextTryAt, null),
                work.WorkKey, t.Id, state, release, followSet.Contains(work.Id), t.NowAt is not null,
                t.PreferredResolution ?? t.ResolutionFloor, work.Kind == WorkKind.Film ? "movie" : "tv");
            // One row per item, always dated by its release so every role sees the same date.
            entries.Add(Entry(future ? "airs" : t.State == TargetState.Waiting && checksEnabled ? "check" :
                queued.Contains(t) ? "queued" : "airs", expected));
        }
        var followed = (await db.AllAsync<FollowRow>(ct)).Where(f => f.Enabled).Select(f => f.WorkId);
        var watched = (await db.AllAsync<WatchItemRow>(ct)).Where(w => w.UserId == "local" &&
            w.Status is WatchStatus.Watching or WatchStatus.Planned).Select(w => w.WorkId);
        foreach (var work in works.Where(w => followed.Concat(watched).Contains(w.Id) &&
            (workKey is null || w.WorkKey == workKey)))
        {
            var next = episodes.Where(e => seasons.Any(s => s.Id == e.SeasonId && s.WorkId == work.Id) &&
                e.AirAt > DateTimeOffset.UtcNow).OrderBy(e => e.AirAt).FirstOrDefault();
            var expected = next?.AirAt ?? work.DigitalAt ?? work.PhysicalAt ?? work.TheatricalAt;
            unavailable |= work.Kind == WorkKind.Series && next is null && seasons.All(s => s.WorkId != work.Id);
            if (expected <= DateTimeOffset.UtcNow || expected is null ||
                targets.Any(t => t.WorkId == work.Id && t.EpisodeId == next?.Id)) continue;
            var season = seasons.FirstOrDefault(s => s.Id == next?.SeasonId);
            entries.Add(new("airs:work:" + work.Id, "airs", Title(work, names),
                next is null ? null : $"S{season?.Number ?? 1:00}E{next.Number:00}", work.PosterUrl,
                expected, null, "background", null, new("NotAiredYet", "Not aired yet", expected, null),
                work.WorkKey, null, "expected", next is not null ? "episode" : expected == work.DigitalAt ? "digital" :
                    expected == work.PhysicalAt ? "physical" : "theatrical", followSet.Contains(work.Id), false, null,
                work.Kind == WorkKind.Film ? "movie" : "tv"));
            if (next is null && work.DigitalAt is { } digital && work.PhysicalAt is { } physical &&
                physical > digital && physical > DateTimeOffset.UtcNow && expected == digital)
                entries.Add(new("airs:physical:" + work.Id, "airs", Title(work, names), null, work.PosterUrl, physical,
                    null, "background", null, new("NotAiredYet", "Not released yet", physical, null), work.WorkKey,
                    null, "expected", "physical", followSet.Contains(work.Id), false, null, "movie"));
        }
        var recent = (await db.AllAsync<TargetRow>(ct)).Where(t => t.State == TargetState.Done &&
            t.UpdatedAt > DateTimeOffset.UtcNow.AddDays(-7) && (workKey is null ||
            works.Any(w => w.Id == t.WorkId && w.WorkKey == workKey)));
        foreach (var t in recent)
        {
            var work = works.FirstOrDefault(w => w.Id == t.WorkId);
            if (work is null) continue;
            var ep = episodes.FirstOrDefault(e => e.Id == t.EpisodeId);
            var season = seasons.FirstOrDefault(s => s.Id == ep?.SeasonId);
            entries.Add(new("done:" + t.Id, "airs", Title(work, names),
                ep is null ? null : $"S{season?.Number ?? 1:00}E{ep.Number:00}", work.PosterUrl,
                t.ExpectedAt ?? ep?.AirAt ?? t.UpdatedAt, null, "background", null,
                new("None", "In your library", null, null), work.WorkKey, t.Id, "in_library",
                ep is null ? "release" : "episode", followSet.Contains(work.Id), false, null,
                work.Kind == WorkKind.Film ? "movie" : "tv"));
        }
        return Results.Json(new { entries = entries.OrderBy(e => e.At ?? DateTimeOffset.MaxValue)
            .ThenBy(e => e.QueuePosition ?? int.MaxValue).ThenBy(e => e.Id, StringComparer.Ordinal),
            airTimesUnavailable = unavailable }, CatalogProjection.Json);
    }
}

internal static class CalendarDates
{
    public static DateTimeOffset? Expected(TargetRow target, EpisodeRow? episode, WorkRow work) =>
        target.ExpectedAt ?? episode?.AirAt ?? work.DigitalAt ?? work.PhysicalAt ?? work.TheatricalAt;

    public static string Release(bool episode, DateTimeOffset? at, WorkRow work) =>
        episode ? "episode" : at is null ? "release" : at == work.DigitalAt ? "digital" :
        at == work.PhysicalAt ? "physical" : at == work.TheatricalAt ? "theatrical" : "release";
}