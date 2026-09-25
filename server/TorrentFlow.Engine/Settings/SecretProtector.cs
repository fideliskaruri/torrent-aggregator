using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace TorrentFlow.Engine.Settings;

/// <summary>
/// Port of lib/crypto: AES-256-GCM "enc:v1:iv.tag.data" (base64url), key = SHA-256 of ENCRYPTION_KEY /
/// AUTH_SECRET or of a generated key file stored next to the database, so existing saved passwords keep
/// decrypting after the move to .NET. Never falls back to plaintext on write.
/// </summary>
public sealed class SecretProtector(IOptions<EngineOptions> options)
{
    private const string Prefix = "enc:v1:";
    private byte[]? _key;

    private byte[] Key()
    {
        if (_key is not null) return _key;
        var configured = Environment.GetEnvironmentVariable("ENCRYPTION_KEY") is { Length: > 0 } k ? k : Environment.GetEnvironmentVariable("AUTH_SECRET");
        if (string.IsNullOrEmpty(configured))
        {
            var file = Path.Combine(options.Value.DataDirectory, ".torrentflow.key");
            configured = File.Exists(file) ? File.ReadAllText(file).Trim() : "";
            if (configured.Length == 0)
            {
                configured = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
                Directory.CreateDirectory(options.Value.DataDirectory);
                File.WriteAllText(file, configured);
                // Windows relies on the data folder's ACL; elsewhere keep the key readable by its owner only.
                if (!OperatingSystem.IsWindows())
                    File.SetUnixFileMode(file, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
        }
        return _key = SHA256.HashData(Encoding.UTF8.GetBytes(configured));
    }

    public string? Encrypt(string? plain)
    {
        if (string.IsNullOrEmpty(plain)) return null;
        if (plain.StartsWith(Prefix, StringComparison.Ordinal)) return plain;
        var iv = RandomNumberGenerator.GetBytes(12);
        var data = Encoding.UTF8.GetBytes(plain);
        var cipher = new byte[data.Length];
        var tag = new byte[16];
        using var gcm = new AesGcm(Key(), 16);
        gcm.Encrypt(iv, data, cipher, tag);
        return $"{Prefix}{B64(iv)}.{B64(tag)}.{B64(cipher)}";
    }

    public string? Decrypt(string? stored)
    {
        if (string.IsNullOrEmpty(stored)) return null;
        if (!stored.StartsWith(Prefix, StringComparison.Ordinal)) return stored;
        try
        {
            var parts = stored[Prefix.Length..].Split('.');
            if (parts.Length != 3) return null;
            var (iv, tag, cipher) = (UnB64(parts[0]), UnB64(parts[1]), UnB64(parts[2]));
            var plain = new byte[cipher.Length];
            using var gcm = new AesGcm(Key(), 16);
            gcm.Decrypt(iv, cipher, tag, plain);
            return Encoding.UTF8.GetString(plain);
        }
        catch (Exception ex) when (ex is CryptographicException or FormatException)
        {
            return null;
        }
    }

    private static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] UnB64(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }
}
