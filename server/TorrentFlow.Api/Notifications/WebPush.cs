using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Lib.Net.Http.WebPush;
using Lib.Net.Http.WebPush.Authentication;
using LibPushSubscription = Lib.Net.Http.WebPush.PushSubscription;

namespace TorrentFlow.Api.Notifications;

public sealed record PushTarget(string Endpoint, string P256dh, string Auth);

public enum PushSendResult { Delivered, Gone, Failed }

/// <summary>Sends one encrypted Web Push message; a seam so tests need no push service.</summary>
public interface IPushSender
{
    Task<PushSendResult> SendAsync(PushTarget target, string payload, CancellationToken ct);
}

public sealed record VapidKeys(string PublicKey, string PrivateKey);

/// <summary>
/// The server's VAPID keypair (P-256, base64url), generated on first use and kept in <c>push-vapid.json</c> in the
/// data directory. The private key never leaves that file: it is not logged and no endpoint returns it.
/// </summary>
public sealed class VapidKeyStore(string dataDirectory)
{
    public const string FileName = "push-vapid.json";
    private readonly Lock _gate = new();
    private VapidKeys? _keys;

    public string FilePath => Path.Combine(dataDirectory, FileName);

    public VapidKeys Keys
    {
        get
        {
            lock (_gate) return _keys ??= LoadOrCreate();
        }
    }

    private VapidKeys LoadOrCreate()
    {
        if (File.Exists(FilePath))
        {
            try
            {
                var stored = JsonSerializer.Deserialize<VapidKeys>(File.ReadAllText(FilePath));
                if (stored is { PublicKey.Length: > 0, PrivateKey.Length: > 0 }) return stored;
            }
            catch (JsonException ex)
            {
                throw new InvalidOperationException("The saved Web Push keys are invalid. Restore push-vapid.json from backup.", ex);
            }
            throw new InvalidOperationException("The saved Web Push keys are incomplete. Restore push-vapid.json from backup.");
        }
        using var ec = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var p = ec.ExportParameters(includePrivateParameters: true);
        var publicKey = new byte[65];
        publicKey[0] = 0x04;
        p.Q.X!.CopyTo(publicKey, 1);
        p.Q.Y!.CopyTo(publicKey, 33);
        var keys = new VapidKeys(Base64Url(publicKey), Base64Url(p.D!));
        Directory.CreateDirectory(dataDirectory);
        using (var file = new FileStream(FilePath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            JsonSerializer.Serialize(file, keys);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(FilePath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        return keys;
    }

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

/// <summary>RFC 8291 (aes128gcm) + RFC 8292 (VAPID) delivery via Lib.Net.Http.WebPush.</summary>
public sealed class WebPushSender(IHttpClientFactory http, VapidKeyStore vapid, ILogger<WebPushSender> logger) : IPushSender
{
    public const string HttpClientName = "webpush";
    private const string Subject = "mailto:torrentflow@localhost";

    public async Task<PushSendResult> SendAsync(PushTarget target, string payload, CancellationToken ct)
    {
        if (!NotificationEndpoints.ValidEndpoint(target.Endpoint)) return PushSendResult.Gone;
        try
        {
            var keys = vapid.Keys;
            using var httpClient = http.CreateClient(HttpClientName);
            var client = new PushServiceClient(httpClient)
            {
                DefaultAuthentication = new VapidAuthentication(keys.PublicKey, keys.PrivateKey) { Subject = Subject },
            };
            var subscription = new LibPushSubscription { Endpoint = target.Endpoint };
            subscription.SetKey(PushEncryptionKeyName.P256DH, target.P256dh);
            subscription.SetKey(PushEncryptionKeyName.Auth, target.Auth);
            await client.RequestPushMessageDeliveryAsync(subscription, new PushMessage(payload) { TimeToLive = 24 * 60 * 60 }, ct);
            return PushSendResult.Delivered;
        }
        catch (PushServiceClientException ex) when (ex.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)
        {
            return PushSendResult.Gone;
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            // The endpoint is a capability URL; log only its host.
            logger.LogWarning("Push to {Host} failed ({ErrorType})", Uri.TryCreate(target.Endpoint, UriKind.Absolute, out var u) ? u.Host : "?", ex.GetType().Name);
            return PushSendResult.Failed;
        }
    }
}
