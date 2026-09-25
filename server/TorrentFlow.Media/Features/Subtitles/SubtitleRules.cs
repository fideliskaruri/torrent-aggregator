using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace TorrentFlow.Media.Features.Subtitles;

internal sealed record SubtitleStream(
    int Index, string CodecType, string Codec, string? Language = null,
    string? Title = null, int? Channels = null, bool DispositionDefault = false);

internal sealed record SubtitleTrack(
    string Id, string Kind, string Label, string? Language, string Codec,
    bool Supported, string? UnsupportedReason, int? StreamIndex, string? FilePath,
    bool NeedsExtraction, bool Forced, bool HearingImpaired)
{
    public string? Src { get; init; }
}

internal sealed record SubtitleDecision(
    string? DefaultTrackId, bool AudioIsEnglish, bool EnglishSubtitleAvailable,
    bool NoEnglishAvailable, bool ForcedFallback, string Reason);

internal static class SubtitleRules
{
    public const int MaxBytes = 8 * 1024 * 1024;
    public const int WindowStride = 480;
    public const int WindowDuration = 600;
    private static readonly HashSet<string> TextCodecs = new(
        "subrip srt webvtt vtt ass ssa mov_text text subviewer subviewer1 microdvd mpl2 jacosub sami realtext stl pjs vplayer".Split(' '));
    private static readonly HashSet<string> ImageCodecs = new(
        "hdmv_pgs_subtitle pgssub pgs dvd_subtitle dvdsub dvb_subtitle dvbsub dvb_teletext xsub vobsub".Split(' '));
    private static readonly HashSet<string> VideoExtensions = new(
        ".mp4 .m4v .mkv .webm .mov .avi .ts .m2ts .mpg .mpeg".Split(' '));
    private static readonly HashSet<string> SubtitleDirectories = new("subs subtitles subtitle sub".Split(' '));
    private static readonly Dictionary<string, string> Languages = BuildLanguages();
    private static readonly Dictionary<string, string> LanguageCodes = Languages
        .GroupBy(p => p.Value.ToLowerInvariant())
        .ToDictionary(g => g.Key, g => g.FirstOrDefault(p => p.Key.Length == 3, g.First()).Key);

    private static Dictionary<string, string> BuildLanguages()
    {
        var result = new Dictionary<string, string>();
        const string entries = """
            en,eng=English;es,spa,esp=Spanish;fr,fra,fre=French;de,deu,ger=German;it,ita=Italian;pt,por=Portuguese
            nl,nld,dut=Dutch;sv,swe=Swedish;no,nor=Norwegian;da,dan=Danish;fi,fin=Finnish;is,isl=Icelandic
            pl,pol=Polish;cs,ces,cze=Czech;sk,slk,slo=Slovak;hu,hun=Hungarian;ro,ron,rum=Romanian;bg,bul=Bulgarian
            el,ell,gre=Greek;ru,rus=Russian;uk,ukr=Ukrainian;tr,tur=Turkish;ar,ara=Arabic;he,heb=Hebrew
            fa,fas,per=Persian;hi,hin=Hindi;ta,tam=Tamil;te,tel=Telugu;th,tha=Thai;vi,vie=Vietnamese
            id,ind=Indonesian;ms,msa,may=Malay;ja,jpn=Japanese;ko,kor=Korean;zh,zho,chi=Chinese
            hr,hrv=Croatian;sr,srp=Serbian;sl,slv=Slovenian;et,est=Estonian;lv,lav=Latvian;lt,lit=Lithuanian;ca,cat=Catalan
            """;
        foreach (var item in entries.Replace("\r", "").Replace('\n', ';').Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var pair = item.Trim().Split('=');
            foreach (var code in pair[0].Split(',')) result[code] = pair[1];
        }
        return result;
    }

    public static string ClassifyCodec(string codec) => TextCodecs.Contains(codec.Trim().ToLowerInvariant()) ? "text"
        : ImageCodecs.Contains(codec.Trim().ToLowerInvariant()) ? "image" : "unknown";

    public static string? LanguageLabel(string? code)
    {
        var normalized = code?.Trim().ToLowerInvariant();
        return string.IsNullOrEmpty(normalized) || normalized is "und" or "unknown" ? null
            : Languages.GetValueOrDefault(normalized, normalized.ToUpperInvariant());
    }

    public static string? LanguageFromToken(string token)
    {
        var normalized = token.Trim().ToLowerInvariant();
        return Languages.ContainsKey(normalized) ? normalized : LanguageCodes.GetValueOrDefault(normalized);
    }

    public static string NormalizePath(string path) => path.Replace('\\', '/').TrimStart('/');
    public static bool IsVideo(string path) => VideoExtensions.Contains(Path.GetExtension(path).ToLowerInvariant());
    public static bool HasTraversal(string path) => path.Split('/').Any(p => p is "." or "..");
    private static string BaseName(string path) => Path.GetFileNameWithoutExtension(NormalizePath(path));
    private static string DirectoryName(string path)
    {
        var normalized = NormalizePath(path);
        var slash = normalized.LastIndexOf('/');
        return slash >= 0 ? normalized[..slash] : "";
    }

    public static List<SubtitleTrack> BuildTracks(
        IEnumerable<SubtitleStream>? streams, IEnumerable<string>? files, string videoPath, bool soleVideo = false)
    {
        var tracks = new List<SubtitleTrack>();
        var videoBase = BaseName(videoPath).ToLowerInvariant();
        var videoDir = DirectoryName(videoPath).ToLowerInvariant();
        foreach (var path in files ?? [])
        {
            var ext = Path.GetExtension(path).ToLowerInvariant();
            if (ext is not (".srt" or ".vtt" or ".ass" or ".ssa")) continue;
            var dir = DirectoryName(path).ToLowerInvariant();
            var name = BaseName(path);
            var lower = name.ToLowerInvariant();
            string? extra = null;
            if (dir == videoDir && lower == videoBase) extra = "";
            else if (dir == videoDir && lower.StartsWith(videoBase, StringComparison.Ordinal))
            {
                var rest = name[videoBase.Length..];
                if (Regex.IsMatch(rest, @"^[._\- ]")) extra = rest;
            }
            else if (dir.StartsWith(videoDir, StringComparison.Ordinal) &&
                dir[videoDir.Length..].TrimStart('/') is { Length: > 0 } remaining &&
                remaining.Split('/').All(SubtitleDirectories.Contains)) extra = name;
            else if (soleVideo) extra = name;
            if (extra is null) continue;
            var tokens = Regex.Split(extra, @"[._\-\s()[\]]+").Where(t => t.Length > 0).ToArray();
            var language = tokens.Select(LanguageFromToken).FirstOrDefault(l => l is not null);
            var flags = tokens.Select(t => t.ToLowerInvariant()).ToHashSet();
            var forced = flags.Contains("forced");
            var sdh = flags.Overlaps(["sdh", "hi", "cc"]);
            var marks = new List<string>();
            if (forced) marks.Add("forced");
            if (sdh) marks.Add("SDH");
            var label = (LanguageLabel(language) ?? name) + (marks.Count > 0 ? $" ({string.Join(", ", marks)})" : "");
            var clean = NormalizePath(path);
            tracks.Add(new($"sidecar:{clean}", "sidecar", $"{label} · {CodecDisplay(ext[1..])} file",
                language, ext[1..], true, null, null, clean, false, forced, sdh));
        }
        var index = 0;
        foreach (var stream in (streams ?? []).Where(s => s.CodecType == "subtitle"))
        {
            index++;
            var kind = ClassifyCodec(stream.Codec);
            var title = string.IsNullOrWhiteSpace(stream.Title) ? null : stream.Title.Trim();
            var name = title ?? LanguageLabel(stream.Language) ?? $"Track {index}";
            var reason = kind switch
            {
                "image" => "image-based subtitles cannot be converted for browser playback — try VLC/MPV instead",
                "unknown" => "this subtitle codec cannot be converted to WebVTT",
                _ => null
            };
            tracks.Add(new($"embedded:{stream.Index}", "embedded",
                $"{name} · {CodecDisplay(stream.Codec)}{(kind == "text" ? "" : " — unsupported")}",
                stream.Language?.ToLowerInvariant(), stream.Codec, kind == "text", reason, stream.Index, null, true,
                (title ?? "").Contains("forced", StringComparison.OrdinalIgnoreCase),
                Regex.IsMatch(title ?? "", @"\bsdh\b|hearing[ -]?impaired", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)));
        }
        return tracks;
    }

    private static string CodecDisplay(string codec) => codec.ToLowerInvariant() switch
    {
        "subrip" or "srt" => "SubRip", "webvtt" or "vtt" => "WebVTT", "mov_text" => "MP4 text",
        "hdmv_pgs_subtitle" or "pgssub" => "PGS", "dvd_subtitle" or "dvdsub" => "VobSub",
        "dvb_subtitle" => "DVB", "dvb_teletext" => "Teletext", _ => codec.ToUpperInvariant()
    };

    public static (string Kind, int Index, string Path)? ParseTrackId(string? raw)
    {
        if (raw?.StartsWith("embedded:", StringComparison.Ordinal) == true)
        {
            var number = JsNumber(raw[9..]);
            return double.IsFinite(number) && number >= 0 && number == Math.Truncate(number) && number <= int.MaxValue
                ? ("embedded", (int)number, "") : null;
        }
        if (raw?.StartsWith("sidecar:", StringComparison.Ordinal) == true)
        {
            var path = NormalizePath(raw[8..]);
            if (path.Length > 0 && !HasTraversal(path)) return ("sidecar", 0, path);
        }
        return null;
    }

    public static double JsNumber(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return 0;
        var text = raw.Trim();
        if (Regex.IsMatch(text, "^0[xXbBoO]"))
        {
            var radix = char.ToLowerInvariant(text[1]) switch { 'b' => 2, 'o' => 8, _ => 16 };
            double accumulated = 0;
            if (text.Length == 2) return double.NaN;
            foreach (var digit in text[2..])
            {
                var value = "0123456789abcdef".IndexOf(char.ToLowerInvariant(digit));
                if (value < 0 || value >= radix) return double.NaN;
                accumulated = accumulated * radix + value;
            }
            return accumulated;
        }
        return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) ? number : double.NaN;
    }

    public static double WindowStart(double time) => double.IsFinite(time) && time > 0 ? Math.Floor(time / WindowStride) * WindowStride : 0;
    public static string TrackSrc(string hash, string video, string track) =>
        $"/api/subtitles/{Uri.EscapeDataString(hash)}?filePath={FormEncode(video)}&track={FormEncode(track)}";
    private static string FormEncode(string value) => Uri.EscapeDataString(value).Replace("%20", "+").Replace("~", "%7E").Replace("%2A", "*");

    public static string? NormalizeHash(string raw)
    {
        var value = raw.Trim();
        if (Regex.IsMatch(value, "^[0-9a-fA-F]{40}$")) return value.ToLowerInvariant();
        if (!Regex.IsMatch(value, "^[a-zA-Z2-7]{32}$")) return null;
        var bytes = new List<byte>();
        var buffer = 0;
        var bits = 0;
        foreach (var c in value.ToUpperInvariant())
        {
            buffer = (buffer << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".IndexOf(c);
            bits += 5;
            if (bits < 8) continue;
            bits -= 8;
            bytes.Add((byte)(buffer >> bits));
        }
        return Convert.ToHexStringLower(bytes.ToArray());
    }

    // TextDecoder("utf-8") in the existing endpoint strips a UTF-8 BOM and replaces
    // malformed sequences. Do not silently guess ANSI/UTF-16 and change its output.
    public static string Decode(byte[] bytes) => Encoding.UTF8.GetString(
        bytes.AsSpan().StartsWith(new byte[] { 0xef, 0xbb, 0xbf }) ? bytes.AsSpan(3) : bytes);
    public static bool IsWebVtt(string text) => Regex.IsMatch(text, @"^\s*WEBVTT");
    public static string SrtToVtt(string text) => "WEBVTT\n\n" + Regex.Replace(
        NormalizeLines(text.StartsWith('\uFEFF') ? text[1..] : text),
        @"([0-9]{2}:[0-9]{2}:[0-9]{2}),([0-9]{1,3})", "$1.$2");
    private static string NormalizeLines(string text) => text.Replace("\r\n", "\n").Replace('\r', '\n');

    public static string ShiftVttCues(string vtt, double delta)
    {
        if (delta == 0 || !double.IsFinite(delta)) return vtt;
        const string time = @"(?:([0-9]{2,}):)?([0-9]{2}):([0-9]{2})\.([0-9]{3})";
        var pattern = new Regex(@"^(\s*)(" + time + @")(\s*-->\s*)(" + time + @")(.*)$");
        var kept = new List<string>();
        foreach (var block in Regex.Split(NormalizeLines(vtt), @"\n{2,}"))
        {
            var lines = block.Split('\n');
            var index = Array.FindIndex(lines, pattern.IsMatch);
            if (index < 0) { kept.Add(block); continue; }
            var match = pattern.Match(lines[index]);
            double Parse(int at) => JsNumber(match.Groups[at].Value) * 3600 + JsNumber(match.Groups[at + 1].Value) * 60
                + JsNumber(match.Groups[at + 2].Value) + JsNumber(match.Groups[at + 3].Value) / 1000;
            var start = Parse(3) + delta;
            var end = Parse(9) + delta;
            if (end <= 0) continue;
            lines[index] = $"{match.Groups[1]}{FormatTime(start)}{match.Groups[7]}{FormatTime(end)}{match.Groups[13]}";
            kept.Add(string.Join('\n', lines));
        }
        return string.Join("\n\n", kept);
    }

    private static string FormatTime(double time)
    {
        time = Math.Max(0, time);
        return string.Create(CultureInfo.InvariantCulture,
            $"{Math.Floor(time / 3600):00}:{Math.Floor(time % 3600 / 60):00}:{Math.Floor(time % 60):00}.{Math.Floor((time - Math.Floor(time)) * 1000 + .5):000}");
    }

    private static bool IsEnglish(string? language) => language?.Trim().ToLowerInvariant().Split('-', '_')[0] is "en" or "eng";
    public static SubtitleDecision Decide(IEnumerable<SubtitleStream> streams, IReadOnlyList<SubtitleTrack> tracks)
    {
        var audio = streams.Where(s => s.CodecType == "audio").ToArray();
        var nonCommentary = audio.Where(s => !Regex.IsMatch(s.Title ?? "", "commentary|director", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)).ToArray();
        var auto = nonCommentary.Length > 0 ? nonCommentary : audio;
        var english = auto.Where(s => IsEnglish(s.Language)).ToArray();
        var defaults = auto.Where(s => s.DispositionDefault).ToArray();
        var best = (english.Length > 0 ? english : defaults)
            .OrderByDescending(s => s.Channels ?? 0).ThenByDescending(s => s.DispositionDefault).FirstOrDefault() ?? auto.FirstOrDefault();
        var subs = tracks.Where(t => t.Supported && IsEnglish(t.Language)).ToArray();
        if (IsEnglish(best?.Language))
            return new(null, true, subs.Length > 0, false, false, "Audio is English — subtitles off by default");
        if (subs.Length == 0)
        {
            var fallback = tracks.FirstOrDefault(t => t.Supported && !t.Forced) ?? tracks.FirstOrDefault(t => t.Supported);
            return new(fallback?.Id, false, false, true, fallback?.Forced ?? false, fallback is null
                ? "No English audio and no supported subtitles available"
                : "No English subtitles available — defaulting to another supported subtitle");
        }
        var full = subs.FirstOrDefault(t => !t.Forced);
        return new((full ?? subs[0]).Id, false, true, false, full is null, full is null
            ? "Non-English audio — defaulting to the only English subtitle (forced)"
            : "Non-English audio — defaulting to English subtitles");
    }
}
