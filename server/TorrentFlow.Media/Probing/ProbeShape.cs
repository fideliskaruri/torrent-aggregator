using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TorrentFlow.Media.Probing;

public sealed record ProbeStream
{
    public int Index { get; init; }
    public string CodecType { get; init; } = "";
    public string? Codec { get; init; }
    public string? Profile { get; init; }
    public string? PixFmt { get; init; }
    public int? Width { get; init; }
    public int? Height { get; init; }
    public string? ColorTransfer { get; init; }
    public string? ColorPrimaries { get; init; }
    public int? Channels { get; init; }
    public string? ChannelLayout { get; init; }
    public string? Language { get; init; }
    public string? Title { get; init; }
    public bool? DispositionDefault { get; init; }
    public long? BitRate { get; init; }
    public int? SampleRate { get; init; }
}

public sealed record ProbeResult(string Container, double? Duration, IReadOnlyList<ProbeStream> Streams, long? BitRate = null)
{
    [JsonIgnore] public ProbeStream? Video => Streams.FirstOrDefault(s => s.CodecType == "video");
    [JsonIgnore] public IEnumerable<ProbeStream> Audio => Streams.Where(s => s.CodecType == "audio");
}

public sealed record ProbeError(string Error, string Message);

public sealed record ProbeOutcome(ProbeResult? Result, ProbeError? Error)
{
    public bool Ok => Result is not null;
    public static ProbeOutcome Success(ProbeResult r) => new(r, null);
    public static ProbeOutcome Fail(string error, string message) => new(null, new ProbeError(error, message));
}

/// <summary>Port of src/lib/media/probe-shape.ts.</summary>
public static class ProbeShape
{
    internal static readonly JsonSerializerOptions StreamJson = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static IReadOnlyList<string> BuildProbeArgs(string input, bool networkSource, int timeoutMs = 30_000, long analyzeDuration = 5_000_000, long probeSize = 10_000_000)
    {
        var args = new List<string>
        {
            "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams",
            "-analyzeduration", analyzeDuration.ToString(CultureInfo.InvariantCulture),
            "-probesize", probeSize.ToString(CultureInfo.InvariantCulture),
        };
        if (networkSource) { args.Add("-rw_timeout"); args.Add(Math.Max(1_000_000L, timeoutMs * 1000L).ToString(CultureInfo.InvariantCulture)); }
        args.Add(input);
        return args;
    }

    public static ProbeOutcome Parse(string stdout)
    {
        JsonElement root;
        try { root = JsonDocument.Parse(stdout).RootElement; }
        catch (JsonException) { return ProbeOutcome.Fail("probe_failed", "Invalid JSON from ffprobe"); }
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("streams", out var streams) || streams.ValueKind != JsonValueKind.Array || streams.GetArrayLength() == 0)
            return ProbeOutcome.Fail("no_streams", "No streams found in file");
        var format = root.TryGetProperty("format", out var f) && f.ValueKind == JsonValueKind.Object ? f : default;
        var container = format.ValueKind == JsonValueKind.Object && format.TryGetProperty("format_name", out var fn) && fn.ValueKind == JsonValueKind.String ? fn.GetString()! : "unknown";
        double? duration = null;
        if (format.ValueKind == JsonValueKind.Object && format.TryGetProperty("duration", out var d))
        {
            var dv = ParseFloatLoose(d);
            if (dv is { } x && double.IsFinite(x)) duration = x;
        }
        long? bitRate = format.ValueKind == JsonValueKind.Object && format.TryGetProperty("bit_rate", out var br) ? ParseBitrate(br) : null;
        var list = new List<ProbeStream>();
        var i = 0;
        foreach (var s in streams.EnumerateArray())
        {
            list.Add(ParseStream(s, i));
            i++;
        }
        return ProbeOutcome.Success(new ProbeResult(container, duration, list, bitRate));
    }

    private static ProbeStream ParseStream(JsonElement s, int position)
    {
        string? Str(string n) => s.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        int? Int(string n) => s.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var dd) ? (int)dd : null;
        string? Tag(string key)
        {
            if (!s.TryGetProperty("tags", out var t) || t.ValueKind != JsonValueKind.Object) return null;
            if (t.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String) return v.GetString();
            if (t.TryGetProperty(key.ToUpperInvariant(), out var u) && u.ValueKind == JsonValueKind.String) return u.GetString();
            return null;
        }
        var rawType = (Str("codec_type") ?? "").ToLowerInvariant();
        bool? disposition = null;
        if (s.TryGetProperty("disposition", out var disp) && disp.ValueKind == JsonValueKind.Object && disp.TryGetProperty("default", out var def))
            disposition = def.ValueKind switch
            {
                JsonValueKind.Number => def.GetDouble() == 1,
                JsonValueKind.String => def.GetString() == "1",
                JsonValueKind.True => true,
                _ => false,
            };
        else disposition = false;
        int? sampleRate = null;
        if (Str("sample_rate") is { } sr && int.TryParse(LeadingInt(sr), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var srv) && srv != 0) sampleRate = srv;
        return new ProbeStream
        {
            Index = Int("index") ?? position,
            CodecType = rawType,
            Codec = NormalizeCodecName(Str("codec_name") ?? "unknown"),
            Profile = Str("profile"),
            PixFmt = Str("pix_fmt"),
            Width = Int("width"),
            Height = Int("height"),
            ColorTransfer = Str("color_transfer"),
            ColorPrimaries = Str("color_primaries"),
            Channels = Int("channels"),
            ChannelLayout = Str("channel_layout"),
            Language = Tag("language"),
            Title = Tag("title"),
            DispositionDefault = disposition,
            BitRate = s.TryGetProperty("bit_rate", out var b) ? ParseBitrate(b) : null,
            SampleRate = sampleRate,
        };
    }

    private static string LeadingInt(string s)
    {
        s = s.TrimStart();
        var end = 0;
        if (end < s.Length && s[end] is '-' or '+') end++;
        while (end < s.Length && char.IsAsciiDigit(s[end])) end++;
        return s[..end];
    }

    private static double? ParseFloatLoose(JsonElement v)
    {
        if (v.ValueKind == JsonValueKind.Number) return v.GetDouble();
        if (v.ValueKind != JsonValueKind.String) return null;
        return double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : null;
    }

    public static long? ParseBitrate(JsonElement raw)
    {
        double value = raw.ValueKind switch
        {
            JsonValueKind.Number => raw.GetDouble(),
            JsonValueKind.String => long.TryParse(LeadingInt(raw.GetString()!), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var l) ? l : double.NaN,
            _ => double.NaN,
        };
        return double.IsFinite(value) && value > 0 ? (long)value : null;
    }

    public static long? ParseBitrate(long? raw) => raw is > 0 ? raw : null;

    public static long? BitrateBps(ProbeResult probe) => ParseBitrate(probe.Video?.BitRate) ?? ParseBitrate(probe.BitRate);

    public static string NormalizeCodecName(string codec) => codec.ToLowerInvariant() switch
    {
        "h264" or "avc" or "avc1" => "h264",
        "hevc" or "h265" or "hvc1" or "hev1" => "hevc",
        "av1" => "av1",
        "vp9" => "vp9",
        "vp8" => "vp8",
        "mpeg2video" => "mpeg2",
        "mpeg1video" => "mpeg1",
        "vc1" => "vc1",
        "wmv3" => "wmv3",
        "aac" => "aac",
        "ac3" or "ac-3" => "ac3",
        "eac3" or "e-ac-3" or "ec-3" => "eac3",
        "dts" or "dca" => "dts",
        "truehd" or "mlp" => "truehd",
        "opus" => "opus",
        "vorbis" => "vorbis",
        "flac" => "flac",
        "pcm_s16le" or "pcm_s24le" or "pcm_s32le" or "pcm_bluray" or "pcm_dvd" => "pcm",
        "mp3" => "mp3",
        "mp2" => "mp2",
        var other => other,
    };

    public static string NormalizeContainer(string? formatName)
    {
        var f = (formatName ?? "").ToLowerInvariant();
        if (f == "webm") return "webm";
        if (f.Contains("matroska") || f.Contains("webm")) return "matroska";
        if (f.Contains("mp4") || f.Contains("m4a") || f.Contains("m4v") || f == "mov") return "mp4";
        if (f.Contains("mpegts") || f == "ts") return "mpegts";
        if (f.Contains("avi")) return "avi";
        if (f.Contains("wmv") || f.Contains("asf")) return "asf";
        if (f.Contains("ogg")) return "ogg";
        return f;
    }

    public static bool IsHdr(ProbeStream s)
    {
        var t = (s.ColorTransfer ?? "").ToLowerInvariant();
        return t is "smpte2084" or "arib-std-b67" || t.Contains("dolby");
    }

    public static string SerializeStreams(IReadOnlyList<ProbeStream> streams) => JsonSerializer.Serialize(streams, StreamJson);

    public static List<ProbeStream>? DeserializeStreams(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonSerializer.Deserialize<List<ProbeStream>>(json, StreamJson); }
        catch (JsonException) { return null; }
    }

    public static string StreamUrl(string infoHash, string filePath, string origin)
    {
        var segments = filePath.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries).Select(Uri.EscapeDataString);
        return $"{origin.TrimEnd('/')}/api/stream/{Uri.EscapeDataString(infoHash)}/{string.Join('/', segments)}";
    }

    public static string RequestOrigin(Microsoft.AspNetCore.Http.HttpRequest request)
    {
        var fwdHost = request.Headers["x-forwarded-host"].ToString().Split(',')[0].Trim();
        var host = fwdHost.Length > 0 ? fwdHost : request.Headers.Host.ToString().Trim();
        if (host.Length == 0) return $"{request.Scheme}://{request.Host}";
        var fwdProto = request.Headers["x-forwarded-proto"].ToString().Split(',')[0].Trim();
        var proto = fwdProto.Length > 0 ? fwdProto : host.EndsWith(":443", StringComparison.Ordinal) ? "https" : "http";
        return $"{proto}://{host}";
    }
}
