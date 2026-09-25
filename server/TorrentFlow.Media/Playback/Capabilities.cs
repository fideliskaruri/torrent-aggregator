using System.Text.Json;
using System.Text.Json.Serialization;

namespace TorrentFlow.Media.Playback;

public sealed record CodecEntry(string Mime, string CanPlay, bool Mse);

public sealed record ClientCapabilities(IReadOnlyList<CodecEntry> Codecs, bool MseSupported, string? Ua = null);

/// <summary>Port of src/lib/media/capabilities.ts.</summary>
public static class Capabilities
{
    public static readonly ClientCapabilities Default = new(
    [
        new("video/mp4; codecs=\"avc1.640028,mp4a.40.2\"", "probably", true),
        new("video/mp4; codecs=\"avc1.640028\"", "probably", true),
        new("audio/mp4; codecs=\"mp4a.40.2\"", "probably", true),
    ], true);

    public static (string Family, List<string> Tags) ParseMime(string mime)
    {
        var parts = mime.ToLowerInvariant().Split(';');
        var type = parts[0].Trim();
        var slash = type.IndexOf('/');
        var family = slash >= 0 ? type[(slash + 1)..] : type;
        if (family.StartsWith("x-", StringComparison.Ordinal)) family = family[2..];
        var tags = new List<string>();
        foreach (var p in parts.Skip(1))
        {
            var kv = p.Trim();
            if (!kv.StartsWith("codecs=", StringComparison.Ordinal)) continue;
            var value = kv["codecs=".Length..].Replace("\"", "").Replace("'", "");
            tags.AddRange(value.Split(',').Select(t => t.Trim()).Where(t => t.Length > 0));
        }
        return (family, tags);
    }

    public static bool SupportsCodecTag(ClientCapabilities caps, string tag, string family = "mp4")
    {
        var lc = tag.ToLowerInvariant();
        return caps.Codecs.Any(c =>
        {
            if (!c.Mse || c.CanPlay.Length == 0) return false;
            var (f, tags) = ParseMime(c.Mime);
            return f == family && tags.Contains(lc);
        });
    }

    public static bool CanDecodeViaMse(ClientCapabilities caps, string mime)
    {
        var exact = caps.Codecs.FirstOrDefault(c => string.Equals(c.Mime, mime, StringComparison.OrdinalIgnoreCase));
        if (exact is not null) return exact.Mse && exact.CanPlay.Length > 0;
        var (family, tags) = ParseMime(mime);
        return tags.Count > 0 && tags.All(t => SupportsCodecTag(caps, t, family));
    }

    public static bool CanPlayNatively(ClientCapabilities caps, string mime) =>
        caps.Codecs.Any(c => string.Equals(c.Mime, mime, StringComparison.OrdinalIgnoreCase) && c.CanPlay.Length > 0);

    public static bool SupportsContainer(ClientCapabilities caps, string container) => container switch
    {
        "mp4" or "mov" => caps.Codecs.Any(c => c.Mse && (c.Mime.StartsWith("video/mp4", StringComparison.OrdinalIgnoreCase) || c.Mime.StartsWith("audio/mp4", StringComparison.OrdinalIgnoreCase))),
        "webm" => caps.Codecs.Any(c => c.Mse && c.Mime.StartsWith("video/webm", StringComparison.OrdinalIgnoreCase)),
        _ => false,
    };

    public static string VideoCodecTag(string codec, string? profile)
    {
        switch (codec.ToLowerInvariant())
        {
            case "h264" or "avc1" or "avc": return "avc1.640028";
            case "hevc" or "h265" or "hvc1" or "hev1":
                var p = (profile ?? "").ToLowerInvariant();
                return p.Contains("10") || p.Contains("rext") ? "hvc1.2.4.L120.B0" : "hvc1.1.6.L93.B0";
            case "av1": return "av01.0.05M.08";
            case "vp9": return "vp09.00.10.08";
            case "vp8": return "vp8";
            default: return codec.ToLowerInvariant();
        }
    }

    public static string AudioCodecTag(string codec) => codec.ToLowerInvariant() switch
    {
        "aac" or "mp4a" => "mp4a.40.2",
        "ac3" or "ac-3" => "ac-3",
        "eac3" or "ec-3" or "e-ac-3" => "ec-3",
        "opus" => "opus",
        "flac" => "flac",
        "vorbis" => "vorbis",
        "mp3" or "mp2" => "mp4a.40.34",
        var other => other,
    };

    public static string Fmp4Mime(string? video, string? audio, string? profile = null)
    {
        var parts = new List<string>();
        if (!string.IsNullOrEmpty(video)) parts.Add(VideoCodecTag(video, profile));
        if (!string.IsNullOrEmpty(audio)) parts.Add(AudioCodecTag(audio));
        return parts.Count == 0 ? "video/mp4" : $"video/mp4; codecs=\"{string.Join(',', parts)}\"";
    }

    public static ClientCapabilities Parse(JsonElement? body)
    {
        if (body is not { ValueKind: JsonValueKind.Object } obj) return Default;
        var codecs = new List<CodecEntry>();
        if (obj.TryGetProperty("codecs", out var arr) && arr.ValueKind == JsonValueKind.Array)
        {
            foreach (var e in arr.EnumerateArray())
            {
                if (e.ValueKind != JsonValueKind.Object) continue;
                if (!e.TryGetProperty("mime", out var m) || m.ValueKind != JsonValueKind.String) continue;
                if (!e.TryGetProperty("canPlay", out var cp) || cp.ValueKind != JsonValueKind.String) continue;
                if (!e.TryGetProperty("mse", out var mse) || mse.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) continue;
                codecs.Add(new CodecEntry(m.GetString()!, cp.GetString()!, mse.GetBoolean()));
            }
        }
        var mseSupported = obj.TryGetProperty("mseSupported", out var ms) && ms.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? ms.GetBoolean()
            : codecs.Count > 0;
        if (codecs.Count == 0) return Default;
        var ua = obj.TryGetProperty("ua", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() : null;
        return new ClientCapabilities(codecs, mseSupported, ua);
    }
}
