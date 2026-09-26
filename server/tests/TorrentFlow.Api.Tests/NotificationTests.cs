using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Api.Notifications;
using TorrentFlow.Api.RemoteAccess;
using TorrentFlow.Api.Requests;
using TorrentFlow.Data;
using TorrentFlow.Core.Contracts.Engine;

namespace TorrentFlow.Api.Tests;

public sealed class FakePushSender : IPushSender
{
    public ConcurrentQueue<(PushTarget Target, string Payload)> Sent { get; } = new();
    public Task<PushSendResult> SendAsync(PushTarget target, string payload, CancellationToken ct)
    {
        Sent.Enqueue((target, payload));
        return Task.FromResult(target.Endpoint.Contains("/gone", StringComparison.Ordinal) ? PushSendResult.Gone
            : target.Endpoint.Contains("/fail", StringComparison.Ordinal) ? PushSendResult.Failed : PushSendResult.Delivered);
    }
}

public sealed class NotificationHostFactory : RequesterHostFactory
{
    public FakePushSender Push { get; } = new();
    public FakeTransfers Transfers { get; } = new();
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IPushSender>();
            services.AddSingleton<IPushSender>(Push);
            services.RemoveAll<IRequestGrabber>();
            services.AddSingleton<IRequestGrabber>(new FakeGrabber());
            services.RemoveAll<IRequestTransfers>();
            services.AddSingleton<IRequestTransfers>(Transfers);
        });
    }
}

public sealed class NotificationTests(NotificationHostFactory factory) : IClassFixture<NotificationHostFactory>
{
    private NotificationService Service => factory.Services.GetRequiredService<NotificationService>();
    private async Task<string> User(string email) =>
        await factory.Services.GetRequiredService<RequesterDirectory>().GetOrCreateUserIdAsync(email, CancellationToken.None);
    private static string Email() => $"{Guid.NewGuid():N}@example.com";
    private static async Task<JsonElement> Json(HttpResponseMessage response)
    {
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    internal static PushSubscriptionInput Subscription(string path)
    {
        using var ec = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var p = ec.ExportParameters(false);
        var key = new byte[65];
        key[0] = 4;
        p.Q.X!.CopyTo(key, 1);
        p.Q.Y!.CopyTo(key, 33);
        return new("https://fcm.googleapis.com/" + path, Convert.ToBase64String(key), Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)));
    }

    [Fact]
    public async Task FeedAndReadOperationsAreScopedToVerifiedRequester()
    {
        var email = Email();
        using var friend = factory.Requester(email);
        using var other = factory.Requester(Email());
        using var owner = factory.Local();
        await friend.GetAsync("/api/me");
        var user = await User(email);
        var own = await Service.PublishAsync(user, NotificationKind.RequestApproved, "Only mine", "A title", "/requests");
        var owners = await Service.PublishAsync(LocalUser.Id, NotificationKind.DownloadCompleted, "Owner secret", null, "/downloads");
        var feed = await Json(await friend.GetAsync("/api/notifications"));
        Assert.Equal(own.Id, Assert.Single(feed.GetProperty("items").EnumerateArray()).GetProperty("id").GetString());
        Assert.Equal(1, feed.GetProperty("unreadCount").GetInt32());
        Assert.Equal(1, (await Json(await friend.GetAsync("/api/me"))).GetProperty("unreadNotifications").GetInt32());
        Assert.Empty((await Json(await other.GetAsync("/api/notifications"))).GetProperty("items").EnumerateArray());
        Assert.Equal(HttpStatusCode.NotFound, (await other.PostAsync($"/api/notifications/read/{own.Id}", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await friend.PostAsync($"/api/notifications/read/{owners.Id}", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await friend.PostAsync($"/api/notifications/read/{own.Id}", null)).StatusCode);
        var once = Assert.Single(await Service.ListAsync(user, 100, default)).ReadAt;
        Assert.NotNull(once);
        await friend.PostAsync($"/api/notifications/read/{own.Id}", null);
        Assert.Equal(once, Assert.Single(await Service.ListAsync(user, 100, default)).ReadAt);
        await Service.PublishAsync(user, NotificationKind.RequestFulfilled, "Done", null, "/library");
        await friend.PostAsync("/api/notifications/read-all", null);
        Assert.Equal(0, await Service.UnreadCountAsync(user, default));
        Assert.Null((await Service.ListAsync(LocalUser.Id, 100, default)).Single(n => n.Id == owners.Id).ReadAt);
        Assert.Contains((await Json(await owner.GetAsync("/api/notifications"))).GetProperty("items").EnumerateArray(),
            n => n.GetProperty("id").GetString() == owners.Id);
    }

    [Fact]
    public async Task NotificationEndpointsRequireAuthenticationAndDoNotOpenOwnerApis()
    {
        using var anonymous = factory.Tunnel(null);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/notifications")).StatusCode);
        using var friend = factory.Requester(Email());
        Assert.Equal(HttpStatusCode.Forbidden, (await friend.GetAsync("/api/settings")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await friend.GetAsync("/api/notifications-extra")).StatusCode);
        var keyResponse = await friend.GetAsync("/api/notifications/push/public-key");
        Assert.Contains("no-store", keyResponse.Headers.CacheControl!.ToString());
        var key = await Json(keyResponse);
        Assert.False(key.TryGetProperty("privateKey", out _));
        Assert.NotEmpty(key.GetProperty("publicKey").GetString()!);
    }

    [Fact]
    public async Task SubscriptionEndpointsValidateAndScopeDeletion()
    {
        var email = Email();
        using var friend = factory.Requester(email);
        using var other = factory.Requester(Email());
        var input = Subscription("valid-" + Guid.NewGuid());
        Assert.Equal(HttpStatusCode.NoContent, (await friend.PostAsJsonAsync("/api/notifications/push/subscription", input)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await friend.PostAsJsonAsync("/api/notifications/push/subscription", input)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await friend.PostAsJsonAsync("/api/notifications/push/subscription", input with { Endpoint = "https://127.0.0.1/secret" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await friend.PostAsJsonAsync("/api/notifications/push/subscription", input with { P256dh = "bad" })).StatusCode);
        using var invalidDelete = new HttpRequestMessage(HttpMethod.Delete, "/api/notifications/push/subscription") { Content = JsonContent.Create(new { input.Endpoint }) };
        Assert.Equal(HttpStatusCode.NoContent, (await other.SendAsync(invalidDelete)).StatusCode);
        await using var db = await factory.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        Assert.Equal(1, await db.PushSubscriptions.CountAsync(s => s.Endpoint == input.Endpoint));
        using var delete = new HttpRequestMessage(HttpMethod.Delete, "/api/notifications/push/subscription") { Content = JsonContent.Create(new { input.Endpoint }) };
        Assert.Equal(HttpStatusCode.NoContent, (await friend.SendAsync(delete)).StatusCode);
        Assert.Equal(0, await db.PushSubscriptions.CountAsync(s => s.Endpoint == input.Endpoint));
    }

    [Fact]
    public async Task FanoutTargetsOnlyRecipientAndPrunesGoneButNotTransientFailures()
    {
        var user = await User(Email());
        var other = await User(Email());
        var gone = Subscription("gone-" + Guid.NewGuid());
        var failed = Subscription("fail-" + Guid.NewGuid());
        var good = Subscription("good-" + Guid.NewGuid());
        var foreign = Subscription("foreign-" + Guid.NewGuid());
        foreach (var input in new[] { gone, failed, good }) await Service.SubscribeAsync(user, input, default);
        await Service.SubscribeAsync(other, foreign, default);
        var published = await Service.PublishAsync(user, NotificationKind.RequestApproved, new string('x', 300), new string('b', 700), "/requests");
        await Service.LastDelivery;
        Assert.Equal(200, published.Title.Length);
        Assert.Equal(500, published.Body!.Length);
        var deliveries = factory.Push.Sent.Where(x => x.Payload.Contains(published.Id, StringComparison.Ordinal)).ToList();
        Assert.Equal(3, deliveries.Count);
        Assert.DoesNotContain(deliveries, x => x.Target.Endpoint == foreign.Endpoint);
        await using var db = await factory.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        Assert.False(await db.PushSubscriptions.AnyAsync(s => s.Endpoint == gone.Endpoint));
        Assert.True(await db.PushSubscriptions.AnyAsync(s => s.Endpoint == failed.Endpoint));
        Assert.True(await db.PushSubscriptions.AnyAsync(s => s.Endpoint == good.Endpoint));
    }

    [Fact]
    public async Task EngineEventsPublishOwnerAlertsButIgnoreStreamingAndPrewarm()
    {
        var engine = DispatchProxy.Create<ITorrentEngine, NotificationEventEngine>();
        var events = (NotificationEventEngine)(object)engine;
        using var watcher = new DownloadNotificationWatcher(engine, Service);
        await watcher.StartAsync(default);
        var title = Guid.NewGuid().ToString("N");
        events.Completed(new("one", title, null, TorrentOrigin.User));
        events.Failed(new("two", title, TorrentOrigin.User));
        events.Completed(new("three", title + "-stream", null, TorrentOrigin.Stream));
        events.Failed(new("four", title + "-prewarm", TorrentOrigin.Prewarm));
        var deadline = DateTime.UtcNow.AddSeconds(5);
        IReadOnlyList<NotificationView> feed;
        do
        {
            await Task.Delay(25);
            feed = await Service.ListAsync(LocalUser.Id, 100, default);
        } while (feed.Count(n => n.Body == title) < 2 && DateTime.UtcNow < deadline);
        await watcher.StopAsync(default);
        Assert.Single(feed, n => n.Body == title && n.Kind == NotificationKind.DownloadCompleted);
        Assert.Single(feed, n => n.Body == title && n.Kind == NotificationKind.DownloadFailed);
        Assert.DoesNotContain(feed, n => n.Body == title + "-stream" || n.Body == title + "-prewarm");
    }

    [Fact]
    public async Task FeedLimitDoesNotLimitUnreadCountAndSubscriptionsAreBounded()
    {
        var user = await User(Email());
        for (var i = 0; i < 11; i++) await Service.SubscribeAsync(user, Subscription(Guid.NewGuid().ToString("N")), default);
        await using var db = await factory.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        Assert.Equal(10, await db.PushSubscriptions.CountAsync(s => s.UserId == user));
        for (var i = 0; i < 3; i++) await Service.PublishAsync(user, "test", "Update", null, null);
        Assert.Single(await Service.ListAsync(user, 1, default));
        Assert.Equal(3, await Service.UnreadCountAsync(user, default));
        Assert.Equal(3, await Service.MarkAllReadAsync(user, default));
        await Service.LastDelivery;
    }

    [Theory]
    [InlineData("http://fcm.googleapis.com/a")]
    [InlineData("https://fcm.googleapis.com.evil.example/a")]
    [InlineData("https://fcm.googleapis.com:8443/a")]
    [InlineData("https://user@fcm.googleapis.com/a")]
    [InlineData("https://localhost/a")]
    public void PushDestinationsCannotTargetArbitraryServers(string endpoint) =>
        Assert.False(NotificationEndpoints.ValidEndpoint(endpoint));

    [Theory]
    [InlineData(404, PushSendResult.Gone)]
    [InlineData(410, PushSendResult.Gone)]
    [InlineData(500, PushSendResult.Failed)]
    [InlineData(201, PushSendResult.Delivered)]
    public async Task SenderMapsProviderStatus(int status, PushSendResult expected)
    {
        var keys = factory.Services.GetRequiredService<VapidKeyStore>();
        var sender = new WebPushSender(new StatusClientFactory(status), keys, NullLogger<WebPushSender>.Instance);
        var subscription = Subscription("test");
        Assert.Equal(expected, await sender.SendAsync(new(subscription.Endpoint, subscription.P256dh, subscription.Auth), "{}", default));
    }

    [Fact]
    public void VapidKeysPersistAndOnlyPublicKeyIsPublished()
    {
        var store = factory.Services.GetRequiredService<VapidKeyStore>();
        var keys = store.Keys;
        Assert.Equal(keys, new VapidKeyStore(Path.GetDirectoryName(store.FilePath)!).Keys);
        Assert.Equal(65, Convert.FromBase64String(keys.PublicKey.Replace('-', '+').Replace('_', '/').PadRight(88, '=')).Length);
    }

    [Fact]
    public async Task RequestCreationApprovalDeclineAndFulfillmentPublishToCorrectRecipients()
    {
        var email = Email();
        using var friend = factory.Requester(email);
        using var owner = factory.Local();
        var title = "Notification " + Guid.NewGuid().ToString("N");
        var created = await Json(await friend.PostAsJsonAsync("/api/requester/requests",
            new { provider = "tmdb", providerId = "893242", mediaType = "movie", title, year = 2000, scope = "movie" }));
        var id = created.GetProperty("request").GetProperty("id").GetString()!;
        Assert.Contains(await Service.ListAsync(LocalUser.Id, 100, default), n => n.Kind == NotificationKind.RequestNew && n.Body == title);
        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsync($"/api/requests/{id}/approve", null)).StatusCode);
        var decisions = factory.Services.GetRequiredService<RequestDecisionService>();
        await decisions.LastGrab;
        var user = await User(email);
        Assert.Contains(await Service.ListAsync(user, 100, default), n => n.Kind == NotificationKind.RequestApproved && n.Body == title);
        await using (var db = await factory.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync())
        {
            var row = await db.MediaRequests.SingleAsync(r => r.Id == id);
            foreach (var hash in row.GrabbedHashes!.Split(',')) factory.Transfers.Done[hash] = true;
        }
        await decisions.SweepAsync(default);
        await decisions.SweepAsync(default);
        Assert.Single(await Service.ListAsync(user, 100, default), n => n.Kind == NotificationKind.RequestFulfilled);

        var declined = await Json(await friend.PostAsJsonAsync("/api/requester/requests",
            new { provider = "tmdb", providerId = "893243", mediaType = "movie", title = title + " decline", year = 2000, scope = "movie" }));
        var declineId = declined.GetProperty("request").GetProperty("id").GetString();
        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsJsonAsync($"/api/requests/{declineId}/decline", new { reason = "Unavailable" })).StatusCode);
        Assert.Contains(await Service.ListAsync(user, 100, default), n => n.Kind == NotificationKind.RequestDeclined && n.Body!.Contains("Unavailable"));
    }

    private sealed class StatusClientFactory(int status) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(new StatusHandler(status));
    }

    private sealed class StatusHandler(int status) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent("") });
    }
}

public class NotificationEventEngine : DispatchProxy
{
    private EventHandler<EngineTorrentCompletedEventArgs>? _completed;
    private EventHandler<EngineTorrentFailedEventArgs>? _failed;
    public void Completed(EngineTorrentCompletedEventArgs args) => _completed?.Invoke(this, args);
    public void Failed(EngineTorrentFailedEventArgs args) => _failed?.Invoke(this, args);
    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        switch (targetMethod?.Name)
        {
            case "add_TorrentCompleted": _completed += (EventHandler<EngineTorrentCompletedEventArgs>)args![0]!; break;
            case "remove_TorrentCompleted": _completed -= (EventHandler<EngineTorrentCompletedEventArgs>)args![0]!; break;
            case "add_TorrentFailed": _failed += (EventHandler<EngineTorrentFailedEventArgs>)args![0]!; break;
            case "remove_TorrentFailed": _failed -= (EventHandler<EngineTorrentFailedEventArgs>)args![0]!; break;
            default: throw new NotSupportedException(targetMethod?.Name);
        }
        return null;
    }
}
