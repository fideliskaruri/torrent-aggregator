using System.Globalization;
using System.Text;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using TorrentFlow.Media.Probing;

namespace TorrentFlow.Media.Subtitles;

public sealed record SidecarSubtitle(string Path, string Extension, string? Language, bool Forced, bool HearingImpaired);

public sealed record SubtitleTrack
{
    public required string Id { get; init; }
    public required string Kind { get; init; }
    public required string Label { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Language { get; init; }
    public required string Codec { get; init; }
    public bool Forced { get; init; }
    public bool HearingImpaired { get; init; }
    public bool Supported { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? UnsupportedReason { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public int? StreamIndex { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? FilePath { get; init; }
    public bool NeedsExtraction { get; init; }
}

public sealed record ParsedTrackId(string Kind, int StreamIndex, string? FilePath);

/// <summary>Port of src/lib/media/subtitles.ts.</summary>
public static partial class SubtitleText
{
    public const int WindowStrideSeconds = 480;
    public const int WindowDurationSeconds = 600;
    public const string ImageReason = "image-based subtitles cannot be converted for browser playback \u2014 try VLC/MPV instead";
    public const string UnknownReason = "this subtitle codec cannot be converted to WebVTT";

    private static readonly HashSet<string> TextCodecs = ["subrip", "srt", "webvtt", "vtt", "ass", "ssa", "mov_text", "text", "subviewer", "subviewer1", "microdvd", "mpl2", "jacosub", "sami", "realtext", "stl", "pjs", "vplayer"];
    private static readonly HashSet<string> ImageCodecs = ["hdmv_pgs_subtitle", "pgssub", "pgs", "dvd_subtitle", "dvdsub", "dvb_subtitle", "dvbsub", "dvb_teletext", "xsub", "vobsub"];
    private static readonly HashSet<string> SidecarExtensions = [".vtt", ".srt", ".ass", ".ssa"];
    private static readonly HashSet<string> SubtitleDirNames = ["subs", "subtitles", "subtitle", "sub"];

    private static readonly (string[] Codes, string Name)[] LanguageTable =
    [
        (["en", "eng"], "English"), (["es", "spa", "esp"], "Spanish"), (["fr", "fra", "fre"], "French"), (["de", "deu", "ger"], "German"),
        (["it", "ita"], "Italian"), (["pt", "por"], "Portuguese"), (["nl", "nld", "dut"], "Dutch"), (["sv", "swe"], "Swedish"),
        (["no", "nor"], "Norwegian"), (["da", "dan"], "Danish"), (["fi", "fin"], "Finnish"), (["is", "isl"], "Icelandic"),
        (["pl", "pol"], "Polish"), (["cs", "ces", "cze"], "Czech"), (["sk", "slk", "slo"], "Slovak"), (["hu", "hun"], "Hungarian"),
        (["ro", "ron", "rum"], "Romanian"), (["bg", "bul"], "Bulgarian"), (["el", "ell", "gre"], "Greek"), (["ru", "rus"], "Russian"),
        (["uk", "ukr"], "Ukrainian"), (["tr", "tur"], "Turkish"), (["ar", "ara"], "Arabic"), (["he", "heb"], "Hebrew"),
        (["fa", "fas", "per"], "Persian"), (["hi", "hin"], "Hindi"), (["ta", "tam"], "Tamil"), (["te", "tel"], "Telugu"),
        (["th", "tha"], "Thai"), (["vi", "vie"], "Vietnamese"), (["id", "ind"], "Indonesian"), (["ms", "msa", "may"], "Malay"),
        (["ja", "jpn"], "Japanese"), (["ko", "kor"], "Korean"), (["zh", "zho", "chi"], "Chinese"), (["hr", "hrv"], "Croatian"),
        (["sr", "srp"], "Serbian"), (["sl", "slv"], "Slovenian"), (["et", "est"], "Estonian"), (["lv", "lav"], "Latvian"),
        (["lt", "lit"], "Lithuanian"), (["ca", "cat"], "Catalan"),
    ];

    private static readonly Dictionary<string, string> LanguageNames = BuildNames();
    private static readonly Dictionary<string, string> NameToCode = BuildNameToCode();

    private static Dictionary<string, string> BuildNames()
    {
        var d = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (codes, name) in LanguageTable) foreach (var c in codes) d[c] = name;
        return d;
    }

    private static Dictionary<string, string> BuildNameToCode()
    {
        var d = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (codes, name) in LanguageTable)
        {
            foreach (var code in codes)
            {
                var key = name.ToLowerInvariant();
                if (!d.TryGetValue(key, out var cur) || (code.Length == 3 && cur.Length != 3)) d[key] = code;
            }
        }
        return d;
    }

    public static string ClassifyCodec(string? codec)
    {
        var c = (codec ?? "").Trim().ToLowerInvariant();
        return TextCodecs.Contains(c) ? "text" : ImageCodecs.Contains(c) ? "image" : "unknown";
    }

    public static string SrtToVtt(string text)
    {
        var body = text.StartsWith('\uFEFF') ? text[1..] : text;
        body = NewlineRe().Replace(body, "\n");
        body = SrtTimeRe().Replace(body, "$1.$2");
        return "WEBVTT\n\n" + body;
    }

    public static bool IsWebVtt(string text) => WebVttRe().IsMatch(text);

    public static string? LanguageLabel(string? code)
    {
        if (string.IsNullOrEmpty(code)) return null;
        var lc = code.Trim().ToLowerInvariant();
        if (lc is "" or "und" or "unknown") return null;
        return LanguageNames.TryGetValue(lc, out var n) ? n : lc.ToUpperInvariant();
    }

    public static string? LanguageFromToken(string token)
    {
        var lc = token.Trim().ToLowerInvariant();
        if (lc.Length == 0) return null;
        if (LanguageNames.ContainsKey(lc)) return lc;
        return NameToCode.TryGetValue(lc, out var c) ? c : null;
    }

    public static string NormalizePath(string p) => LeadingSlashes().Replace(p.Replace('\\', '/'), "");

    private static string LastSegment(string p) { var n = NormalizePath(p); var i = n.LastIndexOf('/'); return i < 0 ? n : n[(i + 1)..]; }

    public static string ExtensionOf(string p)
    {
        var name = LastSegment(p);
        var dot = name.LastIndexOf('.');
        return dot < 0 ? "" : name[dot..].ToLowerInvariant();
    }

    public static string BaseNameOf(string p)
    {
        var name = LastSegment(p);
        var dot = name.LastIndexOf('.');
        return dot < 0 ? name : name[..dot];
    }

    public static string DirNameOf(string p)
    {
        var n = NormalizePath(p);
        var i = n.LastIndexOf('/');
        return i < 0 ? "" : n[..i];
    }

    private static bool IsSubtitleFolderOf(string dir, string videoDir)
    {
        if (!dir.StartsWith(videoDir, StringComparison.Ordinal)) return false;
        var rest = dir[videoDir.Length..];
        if (rest.StartsWith('/')) rest = rest[1..];
        if (rest.Length == 0) return false;
        return rest.Split('/').All(SubtitleDirNames.Contains);
    }

    public static List<SidecarSubtitle> FindSidecars(IEnumerable<string> files, string videoPath, bool soleVideo = false)
    {
        var videoDir = DirNameOf(videoPath).ToLowerInvariant();
        var videoBase = BaseNameOf(videoPath).ToLowerInvariant();
        var result = new List<SidecarSubtitle>();
        foreach (var path in files)
        {
            var ext = ExtensionOf(path);
            if (!SidecarExtensions.Contains(ext)) continue;
            var dir = DirNameOf(path).ToLowerInvariant();
            var baseName = BaseNameOf(path);
            var baseLc = baseName.ToLowerInvariant();
            string? extra = null;
            if (dir == videoDir && baseLc == videoBase) extra = "";
            else if (dir == videoDir && baseLc.StartsWith(videoBase, StringComparison.Ordinal))
            {
                var rest = baseName[videoBase.Length..];
                if (rest.Length > 0 && rest[0] is '.' or '_' or '-' or ' ') extra = rest;
                else continue;
            }
            else if (IsSubtitleFolderOf(dir, videoDir)) extra = baseName;
            else if (soleVideo) extra = baseName;
            else continue;
            var tokens = TokenSplit().Split(extra).Where(t => t.Length > 0).ToList();
            var language = tokens.Select(LanguageFromToken).FirstOrDefault(l => l is not null);
            var flags = tokens.Select(t => t.ToLowerInvariant()).ToHashSet();
            result.Add(new SidecarSubtitle(NormalizePath(path), ext[1..], language, flags.Contains("forced"),
                flags.Contains("sdh") || flags.Contains("hi") || flags.Contains("cc")));
        }
        return result;
    }

    public static string CodecDisplay(string codec) => codec.ToLowerInvariant() switch
    {
        "subrip" or "srt" => "SubRip",
        "webvtt" or "vtt" => "WebVTT",
        "ass" => "ASS",
        "ssa" => "SSA",
        "mov_text" => "MP4 text",
        "hdmv_pgs_subtitle" or "pgssub" => "PGS",
        "dvd_subtitle" or "dvdsub" => "VobSub",
        "dvb_subtitle" => "DVB",
        "dvb_teletext" => "Teletext",
        "xsub" => "XSUB",
        _ => codec.ToUpperInvariant(),
    };

    private static string Decorate(string name, bool forced, bool sdh)
    {
        var marks = new List<string>();
        if (forced) marks.Add("forced");
        if (sdh) marks.Add("SDH");
        return marks.Count > 0 ? $"{name} ({string.Join(", ", marks)})" : name;
    }

    public static List<SubtitleTrack> EmbeddedTracks(IEnumerable<ProbeStream>? streams)
    {
        var list = new List<SubtitleTrack>();
        if (streams is null) return list;
        var i = 0;
        foreach (var s in streams.Where(s => s.CodecType == "subtitle"))
        {
            var title = string.IsNullOrWhiteSpace(s.Title) ? null : s.Title.Trim();
            var lang = LanguageLabel(s.Language);
            var titleLc = title?.ToLowerInvariant() ?? "";
            var forced = titleLc.Contains("forced");
            var sdh = SdhRe().IsMatch(titleLc);
            var kind = ClassifyCodec(s.Codec);
            var name = title ?? lang ?? $"Track {i + 1}";
            var supported = kind == "text";
            var codec = s.Codec ?? "";
            list.Add(new SubtitleTrack
            {
                Id = $"embedded:{s.Index}",
                Kind = "embedded",
                Label = supported ? $"{name} \u00b7 {CodecDisplay(codec)}" : $"{name} \u00b7 {CodecDisplay(codec)} \u2014 unsupported",
                Language = s.Language?.ToLowerInvariant(),
                Codec = codec,
                Forced = forced,
                HearingImpaired = sdh,
                Supported = supported,
                UnsupportedReason = kind == "image" ? ImageReason : kind == "unknown" ? UnknownReason : null,
                StreamIndex = s.Index,
                FilePath = null,
                NeedsExtraction = true,
            });
            i++;
        }
        return list;
    }

    public static List<SubtitleTrack> SidecarTracks(IEnumerable<SidecarSubtitle> sidecars) =>
        sidecars.Select((s, i) =>
        {
            var name = Decorate(LanguageLabel(s.Language) ?? NullIfEmpty(BaseNameOf(s.Path)) ?? $"File {i + 1}", s.Forced, s.HearingImpaired);
            return new SubtitleTrack
            {
                Id = $"sidecar:{s.Path}",
                Kind = "sidecar",
                Label = $"{name} \u00b7 {CodecDisplay(s.Extension)} file",
                Language = s.Language,
                Codec = s.Extension,
                Forced = s.Forced,
                HearingImpaired = s.HearingImpaired,
                Supported = true,
                NeedsExtraction = false,
                FilePath = s.Path,
            };
        }).ToList();

    private static string? NullIfEmpty(string s) => s.Length == 0 ? null : s;

    public static List<SubtitleTrack> BuildTracks(IEnumerable<ProbeStream>? probeStreams, IEnumerable<string>? files, string videoPath, bool soleVideo = false)
    {
        var tracks = new List<SubtitleTrack>();
        if (files is not null) tracks.AddRange(SidecarTracks(FindSidecars(files, videoPath, soleVideo)));
        tracks.AddRange(EmbeddedTracks(probeStreams));
        return tracks;
    }

    public static ParsedTrackId? ParseTrackId(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        if (raw.StartsWith("embedded:", StringComparison.Ordinal))
        {
            var rest = raw["embedded:".Length..].Trim();
            if (rest.Length == 0) return new ParsedTrackId("embedded", 0, null);
            return int.TryParse(rest, NumberStyles.None, CultureInfo.InvariantCulture, out var idx) && idx >= 0 ? new ParsedTrackId("embedded", idx, null) : null;
        }
        if (raw.StartsWith("sidecar:", StringComparison.Ordinal))
        {
            var fp = NormalizePath(raw["sidecar:".Length..]);
            if (fp.Length == 0 || fp.Split('/').Any(s => s is "." or "..")) return null;
            return new ParsedTrackId("sidecar", -1, fp);
        }
        return null;
    }

    private static string Form(string v) => Uri.EscapeDataString(v).Replace("%20", "+");

    private static string Num(double v) => (Math.Round(v * 1000) / 1000).ToString(CultureInfo.InvariantCulture);

    public static string TrackSrc(string infoHash, string videoPath, string trackId, double offsetSec = 0, double windowStartSec = 0, string? consumerId = null)
    {
        var sb = new StringBuilder($"filePath={Form(videoPath)}&track={Form(trackId)}");
        if (offsetSec > 0) sb.Append("&offset=").Append(Num(offsetSec));
        if (windowStartSec > 0) sb.Append("&start=").Append(Num(windowStartSec));
        if (!string.IsNullOrEmpty(consumerId)) sb.Append("&consumer=").Append(Form(consumerId));
        return $"/api/subtitles/{Uri.EscapeDataString(infoHash)}?{sb}";
    }

    public static string ListUrl(string infoHash, string videoPath) => $"/api/subtitles/{Uri.EscapeDataString(infoHash)}?filePath={Form(videoPath)}";

    public static double WindowStart(double t) => !double.IsFinite(t) || t <= 0 ? 0 : Math.Floor(t / WindowStrideSeconds) * WindowStrideSeconds;

    public static string ShiftVttCues(string vtt, double deltaSec)
    {
        if (deltaSec == 0 || !double.IsFinite(deltaSec)) return vtt;
        var blocks = BlockSplit().Split(NewlineRe().Replace(vtt, "\n"));
        var kept = new List<string>();
        foreach (var block in blocks)
        {
            var lines = block.Split('\n');
            var idx = Array.FindIndex(lines, l => CueLine().IsMatch(l));
            if (idx < 0) { kept.Add(block); continue; }
            var m = CueLine().Match(lines[idx]);
            double Seconds(int g) =>
                (m.Groups[g].Success ? double.Parse(m.Groups[g].Value, CultureInfo.InvariantCulture) : 0) * 3600
                + double.Parse(m.Groups[g + 1].Value, CultureInfo.InvariantCulture) * 60
                + double.Parse(m.Groups[g + 2].Value, CultureInfo.InvariantCulture)
                + double.Parse(m.Groups[g + 3].Value, CultureInfo.InvariantCulture) / 1000;
            var start = Seconds(3) + deltaSec;
            var end = Seconds(9) + deltaSec;
            if (end <= 0) continue;
            lines[idx] = m.Groups[1].Value + FormatVttTime(start) + m.Groups[7].Value + FormatVttTime(end) + m.Groups[13].Value;
            kept.Add(string.Join('\n', lines));
        }
        return string.Join("\n\n", kept);
    }

    public static string FormatVttTime(double total)
    {
        var clamped = Math.Max(0, total);
        var whole = Math.Floor(clamped);
        var ms = (int)Math.Round((clamped - whole) * 1000);
        var secs = (long)whole;
        if (ms >= 1000) { secs += 1; ms -= 1000; }
        return $"{secs / 3600:00}:{secs % 3600 / 60:00}:{secs % 60:00}.{ms:000}";
    }

    [GeneratedRegex(@"\r\n|\r")] private static partial Regex NewlineRe();
    [GeneratedRegex(@"(\d{2}:\d{2}:\d{2}),(\d{1,3})")] private static partial Regex SrtTimeRe();
    [GeneratedRegex(@"^\s*WEBVTT")] private static partial Regex WebVttRe();
    [GeneratedRegex(@"^/+")] private static partial Regex LeadingSlashes();
    [GeneratedRegex(@"[._\-\s()\[\]]+")] private static partial Regex TokenSplit();
    [GeneratedRegex(@"\bsdh\b|hearing[ -]?impaired")] private static partial Regex SdhRe();
    [GeneratedRegex(@"\n{2,}")] private static partial Regex BlockSplit();
    [GeneratedRegex(@"^(\s*)((?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3}))(\s*-->\s*)((?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3}))(.*)$")] private static partial Regex CueLine();
}
