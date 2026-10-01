using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Api.RemoteAccess;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Api.Notifications;

public static class NotificationKind
{
    public const string RequestNew = "request.new";
    public const string RequestApproved = "request.approved";
    public const string RequestDeclined = "request.declined";
    public const string RequestFulfilled = "request.fulfilled";
    public const string RequestFailed = "request.failed";
    public const string DownloadCompleted = "download.completed";
    public const string DownloadFailed = "download.failed";
    /// <summary>A season download's counts after its first pass, updated in place by later finds.</summary>
    public const string DownloadSummary = "download.summary";
}

public sealed record NotificationView(string Id, string Kind, string Title, string? Body, string? Link, DateTime CreatedAt, DateTime? ReadAt,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.Never)] string? PosterUrl = null);

public sealed record PushSubscriptionInput(string Endpoint, string P256dh, string Auth);

/// <summary>Who a signed-in caller is for notification purposes: a requester's user row, otherwise the local owner.</summary>
public static class NotificationRecipient
{
    public static string? Of(HttpContext http) =>
        RemoteAccessClaims.IsRequester(http.User) ? RemoteAccessClaims.UserIdOf(http.User) : LocalUser.Id;
}

/// <summary>Writes feed entries and fans each one out to the recipient's Web Push subscriptions.</summary>
public sealed class NotificationService(
    IDbContextFactory<TorrentFlowDbContext> factory,
    IPushSender push,
    TimeProvider time,
    IReleasePosters releasePosters,
    ILogger<NotificationService> logger)
{
    public const int MaxListed = 100;
    private const int MaxSubscriptionsPerUser = 10;
    private const int MaxTitle = 200;
    private const int MaxBody = 500;

    private readonly Lock _deliveryGate = new();

    /// <summary>The push fan-out of the latest publish; tests await it.</summary>
    internal Task LastDelivery { get; private set; } = Task.CompletedTask;

    public async Task<NotificationView> PublishAsync(string recipientUserId, string kind, string title, string? body, string? link, CancellationToken ct = default)
    {
        var row = new Notification
        {
            Id = Ids.New(),
            RecipientUserId = recipientUserId,
            Kind = kind,
            Title = Clip(title, MaxTitle)!,
            Body = Clip(body, MaxBody),
            Link = link,
            CreatedAt = time.GetUtcNow().UtcDateTime,
        };
        await using (var db = await factory.CreateDbContextAsync(ct))
        {
            db.Notifications.Add(row);
            await db.SaveChangesAsync(ct);
        }
        var view = ToView(row);
        lock (_deliveryGate)
        {
            var previous = LastDelivery;
            LastDelivery = Task.Run(async () =>
            {
                await previous.ConfigureAwait(false);
                await DeliverAsync(recipientUserId, view).ConfigureAwait(false);
            }, CancellationToken.None);
        }
        return view;
    }

    /// <summary>Publishing must never fail the action that caused it (a decision, a completed transfer).</summary>
    public async Task TryPublishAsync(string recipientUserId, string kind, string title, string? body, string? link)
    {
        try { await PublishAsync(recipientUserId, kind, title, body, link, CancellationToken.None); }
        catch (Exception ex) { logger.LogWarning(ex, "Could not record a {Kind} notification", kind); }
    }

    /// <summary>
    /// The one notification behind <paramref name="link"/>: published (and pushed) when <paramref name="create"/> and there is
    /// none yet; otherwise its text changes in place, keeping its time and read state, and nothing is pushed again.
    /// </summary>
    public async Task UpsertAsync(string recipientUserId, string kind, string title, string? body, string link, bool create, CancellationToken ct = default)
    {
        await using (var db = await factory.CreateDbContextAsync(ct))
        {
            var existing = await db.Notifications.FirstOrDefaultAsync(n => n.RecipientUserId == recipientUserId && n.Link == link, ct);
            if (existing is not null)
            {
                existing.Title = Clip(title, MaxTitle)!;
                existing.Body = Clip(body, MaxBody);
                await db.SaveChangesAsync(ct);
                return;
            }
        }
        if (create) await PublishAsync(recipientUserId, kind, title, body, link, ct);
    }

    public async Task<IReadOnlyList<NotificationView>> ListAsync(string userId, int limit, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var rows = await db.Notifications.AsNoTracking().Where(n => n.RecipientUserId == userId)
            .OrderByDescending(n => n.CreatedAt).ThenByDescending(n => n.Id)
            .Take(Math.Clamp(limit, 1, MaxListed)).ToListAsync(ct);
        var posters = await PostersAsync(db, rows, ct);
        return rows.Select(n => ToView(n) with { PosterUrl = posters.GetValueOrDefault(n.Id) }).ToList();
    }

    /// <summary>
    /// Each notification's work poster: a title link, a download's transfer (its hash in the link) or a request's row (its
    /// title in the body) names the work, read through <see cref="WorkPosters"/>; anything unlinked resolves by its release name.
    /// </summary>
    private async Task<Dictionary<string, string>> PostersAsync(TorrentFlowDbContext db, IReadOnlyList<Notification> rows, CancellationToken ct)
    {
        const string hashLink = "/downloads?hash=";
        var hashOf = rows.Where(n => n.Link?.StartsWith(hashLink, StringComparison.Ordinal) == true)
            .ToDictionary(n => n.Id, n => Uri.UnescapeDataString(n.Link![hashLink.Length..]).ToLowerInvariant());
        var hashes = hashOf.Values.Distinct().ToList();
        var transferKeys = hashes.Count == 0 ? [] : await db.EngineTorrents.AsNoTracking()
            .Where(t => hashes.Contains(t.Hash.ToLower()) && t.Work != null)
            .Select(t => new { Hash = t.Hash.ToLower(), t.Work!.WorkKey }).ToListAsync(ct);
        var keyByHash = transferKeys.GroupBy(t => t.Hash).ToDictionary(g => g.Key, g => g.First().WorkKey);
        var titles = rows.Where(n => n.Kind.StartsWith("request.", StringComparison.Ordinal) && n.Body != null).Select(n => n.Body!).Distinct().ToList();
        var requests = titles.Count == 0 ? [] : await db.MediaRequests.AsNoTracking().Where(r => titles.Contains(r.Title))
            .OrderByDescending(r => r.CreatedAt).Select(r => new { r.Title, r.WorkKey }).ToListAsync(ct);
        var keyByTitle = requests.GroupBy(r => r.Title).ToDictionary(g => g.Key, g => g.First().WorkKey);
        const string titleLink = "/title/";
        string? KeyOf(Notification n) =>
            n.Link?.StartsWith(titleLink, StringComparison.Ordinal) == true ? Uri.UnescapeDataString(n.Link[titleLink.Length..].Split('?', '#')[0])
            : hashOf.TryGetValue(n.Id, out var h) ? keyByHash.GetValueOrDefault(h)
            : n.Body != null && n.Kind.StartsWith("request.", StringComparison.Ordinal) ? keyByTitle.GetValueOrDefault(n.Body) : null;
        var known = await WorkPosters.LoadAsync(db, rows.Select(KeyOf), ct);
        var found = new Dictionary<string, string>(StringComparer.Ordinal);
        var unresolved = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var n in rows)
        {
            if (WorkPosters.Pick(known, KeyOf(n), null) is { } poster) found[n.Id] = poster;
            else if (!string.IsNullOrWhiteSpace(n.Body)) unresolved[n.Body] = null;
        }
        if (unresolved.Count == 0) return found;
        try
        {
            var byName = await releasePosters.ForReleasesAsync(unresolved, ct);
            foreach (var n in rows)
                if (!found.ContainsKey(n.Id) && n.Body != null && byName.TryGetValue(n.Body, out var poster)) found[n.Id] = poster;
        }
        catch (Exception ex) when (!ct.IsCancellationRequested) { logger.LogDebug(ex, "Notification posters by release name failed"); }
        return found;
    }

    public async Task<int> UnreadCountAsync(string userId, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Notifications.CountAsync(n => n.RecipientUserId == userId && n.ReadAt == null, ct);
    }

    /// <summary>False when the id is unknown or belongs to someone else — the caller cannot tell the two apart.</summary>
    public async Task<bool> MarkReadAsync(string userId, string id, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var row = await db.Notifications.FirstOrDefaultAsync(n => n.Id == id && n.RecipientUserId == userId, ct);
        if (row is null) return false;
        if (row.ReadAt is null)
        {
            row.ReadAt = time.GetUtcNow().UtcDateTime;
            await db.SaveChangesAsync(ct);
        }
        return true;
    }

    public async Task<int> MarkAllReadAsync(string userId, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var rows = await db.Notifications.Where(n => n.RecipientUserId == userId && n.ReadAt == null).ToListAsync(ct);
        var now = time.GetUtcNow().UtcDateTime;
        foreach (var row in rows) row.ReadAt = now;
        await db.SaveChangesAsync(ct);
        return rows.Count;
    }

    public async Task SubscribeAsync(string userId, PushSubscriptionInput input, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var existing = await db.PushSubscriptions.FirstOrDefaultAsync(s => s.Endpoint == input.Endpoint, ct);
        if (existing is not null)
        {
            // A browser endpoint belongs to whoever subscribed it last on this device.
            existing.UserId = userId;
            existing.P256dh = input.P256dh;
            existing.Auth = input.Auth;
        }
        else
        {
            var mine = await db.PushSubscriptions.Where(s => s.UserId == userId).OrderBy(s => s.CreatedAt).ToListAsync(ct);
            if (mine.Count >= MaxSubscriptionsPerUser) db.PushSubscriptions.RemoveRange(mine.Take(mine.Count - MaxSubscriptionsPerUser + 1));
            db.PushSubscriptions.Add(new PushSubscription
            {
                Id = Ids.New(), UserId = userId, Endpoint = input.Endpoint, P256dh = input.P256dh, Auth = input.Auth,
                CreatedAt = time.GetUtcNow().UtcDateTime,
            });
        }
        await db.SaveChangesAsync(ct);
    }

    public async Task<bool> UnsubscribeAsync(string userId, string endpoint, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var rows = await db.PushSubscriptions.Where(s => s.UserId == userId && s.Endpoint == endpoint).ToListAsync(ct);
        db.PushSubscriptions.RemoveRange(rows);
        await db.SaveChangesAsync(ct);
        return rows.Count > 0;
    }

    /// <summary>The push payload: what the notification says and where it opens. Never a file-system path.</summary>
    public static string PayloadOf(NotificationView n) => JsonSerializer.Serialize(new
    {
        id = n.Id,
        kind = n.Kind,
        title = n.Title,
        body = n.Body,
        link = n.Link ?? "/notifications",
    });

    private async Task DeliverAsync(string userId, NotificationView view)
    {
        try
        {
            List<PushSubscription> targets;
            await using (var db = await factory.CreateDbContextAsync())
                targets = await db.PushSubscriptions.AsNoTracking().Where(s => s.UserId == userId).ToListAsync();
            if (targets.Count == 0) return;
            var payload = PayloadOf(view);
            var gone = new List<string>();
            foreach (var target in targets)
            {
                var result = await push.SendAsync(new PushTarget(target.Endpoint, target.P256dh, target.Auth), payload, CancellationToken.None);
                if (result == PushSendResult.Gone) gone.Add(target.Id);
            }
            if (gone.Count == 0) return;
            await using var cleanup = await factory.CreateDbContextAsync();
            cleanup.PushSubscriptions.RemoveRange(await cleanup.PushSubscriptions.Where(s => gone.Contains(s.Id)).ToListAsync());
            await cleanup.SaveChangesAsync();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Push delivery for notification {Id} failed", view.Id);
        }
    }

    private static NotificationView ToView(Notification n) => new(n.Id, n.Kind, n.Title, n.Body, n.Link, n.CreatedAt, n.ReadAt);

    private static string? Clip(string? value, int max) =>
        value is null ? null : value.Length <= max ? value : value[..(max - 1)] + "…";
}
