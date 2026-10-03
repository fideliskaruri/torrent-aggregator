using System.Net;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Lib.Net.Http.WebPush;
using Lib.Net.Http.WebPush.Authentication;

namespace TorrentFlow.Api.Notifications;

public sealed record VapidKeys(string PublicKey, string PrivateKey);
public enum PushSendResult { Delivered, Gone, Failed }

public sealed class VapidKeyStore(string directory)
{
    private readonly Lock gate = new();
    private VapidKeys? keys;
    public VapidKeys Keys
    {
        get
        {
            lock (gate)
            {
                if (keys is not null) return keys;
                var path = Path.Combine(directory, "push-vapid.json");
                if (File.Exists(path))
                {
                    Protect(path);
                    var saved = JsonSerializer.Deserialize<VapidKeys>(File.ReadAllText(path));
                    if (saved is not { PublicKey.Length: > 0, PrivateKey.Length: > 0 })
                        throw new InvalidOperationException("Restore push-vapid.json from backup.");
                    return keys = saved;
                }
                using var ec = ECDsa.Create(ECCurve.NamedCurves.nistP256);
                var p = ec.ExportParameters(true);
                var pub = new byte[65];
                pub[0] = 4;
                p.Q.X!.CopyTo(pub, 1);
                p.Q.Y!.CopyTo(pub, 33);
                var generated = new VapidKeys(Encode(pub), Encode(p.D!));
                Directory.CreateDirectory(directory);
                using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    JsonSerializer.Serialize(file, generated);
                Protect(path);
                return keys = generated;
            }
        }
    }
    private static void Protect(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("The saved push keys must not be a symbolic link.");
        if (OperatingSystem.IsWindows())
        {
            var acl = new FileSecurity();
            acl.SetAccessRuleProtection(true, false);
            acl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User!,
                FileSystemRights.FullControl, AccessControlType.Allow));
            new FileInfo(path).SetAccessControl(acl);
        }
        else File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
    private static string Encode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

public sealed class WebPushSender(IHttpClientFactory clients, VapidKeyStore vapid, ILogger<WebPushSender> logger)
{
    public async Task<PushSendResult> SendAsync(TorrentFlow.Domain.PushSubscriptionRow target, string payload, CancellationToken ct)
    {
        if (!NotificationEndpoints.ValidEndpoint(target.Endpoint)) return PushSendResult.Gone;
        try
        {
            using var http = clients.CreateClient("webpush");
            var keys = vapid.Keys;
            var client = new PushServiceClient(http)
            {
                DefaultAuthentication = new VapidAuthentication(keys.PublicKey, keys.PrivateKey)
                    { Subject = "mailto:torrentflow@localhost" },
            };
            var subscription = new PushSubscription { Endpoint = target.Endpoint };
            subscription.SetKey(PushEncryptionKeyName.P256DH, target.P256dh);
            subscription.SetKey(PushEncryptionKeyName.Auth, target.Auth);
            await client.RequestPushMessageDeliveryAsync(subscription,
                new PushMessage(payload) { TimeToLive = 86400 }, ct);
            return PushSendResult.Delivered;
        }
        catch (PushServiceClientException ex) when (ex.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)
        { return PushSendResult.Gone; }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning("Push to {Host} failed ({ErrorType})", new Uri(target.Endpoint).Host, ex.GetType().Name);
        }
        return PushSendResult.Failed;
    }
}
