using System.Text.Json;
using System.Text.RegularExpressions;
using TorrentFlow.Core;

namespace TorrentFlow.Search.Adapters;

/// <summary>
/// Reads AnimeTosho's <c>json?show=torrent</c> answer into each file's track list for the language hints
/// (docs/release-language.md, "Hints before download"). A file's MediaInfo text (<c>files[].info.mediainfo</c>) is the
/// primary source: it lists every audio and subtitle track with its title, language and default and forced flags, and the
/// track roles need the titles ("Signs", "Forced", "SDH"). Subtitle attachments are the fallback, in the three shapes the
/// feeds use: the original feed's per-file <c>{codec, lang, name, default, enabled, forced, tracknum}</c>, and Anime
/// Tosho NEW's <c>{default, forced, format, language, language_code}</c>, per file or for the whole torrent.
/// </summary>
internal static partial class AnimeToshoTracks
{
    /// <param name="State">complete, pending (still processing) or missing (unknown or skipped).</param>
    /// <param name="Via">Where the tracks came from: mediainfo, attachments, both, or none.</param>
    public sealed record Answer(string State, IReadOnlyList<LanguageHintFile> Files, string Via = "none");

    /// <summary>Reads one answer. An answer that isn't an object is not the feed's: <see cref="InvalidDataException"/> (the host failed).
    /// A file entry that isn't an object, or a value of the wrong type, is skipped or read as unknown.</summary>
    public static Answer Read(string body)
    {
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("AnimeTosho's answer is not an object");
        if (root.TryGetProperty("error", out _)) return new(LanguageHints.Missing, []);
        var status = Text(root, "status");
        // AnimeTosho never processes an item it skipped (batches, many non-English releases).
        if (string.Equals(status, "skipped", StringComparison.OrdinalIgnoreCase)) return new(LanguageHints.Missing, []);
        if (!string.Equals(status, LanguageHints.Complete, StringComparison.OrdinalIgnoreCase) ||
            !root.TryGetProperty("files", out var list) || list.ValueKind != JsonValueKind.Array || list.GetArrayLength() == 0)
            return new(LanguageHints.Pending, []);
        var whole = Array(root, "attachments").ToList();
        var videos = list.EnumerateArray().Count(f => Text(f, "filename") is { } name && MediaFileRules.IsVideo(name));
        var files = new List<LanguageHintFile>();
        bool mediainfo = false, attachments = false;
        foreach (var file in list.EnumerateArray())
        {
            var path = Text(file, "filename");
            if (string.IsNullOrWhiteSpace(path)) continue;
            var size = Long(file, "size");
            var processed = !file.TryGetProperty("processed", out var p) || p.ValueKind is JsonValueKind.True ||
                p.ValueKind == JsonValueKind.Number && p.TryGetInt32(out var flag) && flag != 0;
            if (!processed) { files.Add(new(path, size)); continue; }
            var tracks = file.TryGetProperty("info", out var info) && Text(info, "mediainfo") is { } text ? MediaInfo(text).ToList() : [];
            mediainfo |= tracks.Count > 0;
            if (tracks.All(t => t.Kind != MediaTrackKind.Subtitle))
            {
                // A torrent-wide attachment belongs to the only video, or to the file its URL names.
                var own = Array(file, "attachments").Concat(whole.Where(a => MediaFileRules.IsVideo(path) &&
                    (videos == 1 || Text(a, "url") is { } url && Uri.UnescapeDataString(url).Contains(Stem(path), StringComparison.OrdinalIgnoreCase))));
                var subtitles = Attachments(own);
                attachments |= subtitles.Count > 0;
                tracks.AddRange(subtitles);
            }
            files.Add(new(path, size, tracks));
        }
        // A video still unprocessed has no track list yet: ask again later.
        if (files.Count == 0 || files.Any(f => MediaFileRules.IsVideo(f.Path) && f.Tracks == null)) return new(LanguageHints.Pending, []);
        return new(LanguageHints.Complete, files, mediainfo && attachments ? "mediainfo and attachments" : mediainfo ? "mediainfo" : attachments ? "attachments" : "none");
    }

    /// <summary>
    /// The Video, Audio and Text sections of MediaInfo's text report ("Text #2", "Title : Signs", "Language : English",
    /// "Default : Yes", "Forced : No"). Closed captions carried in the video stream (EIA-608/708) are left out.
    /// </summary>
    public static IReadOnlyList<MediaTrack> MediaInfo(string report)
    {
        var tracks = new List<MediaTrack>();
        MediaTrackKind? kind = null;
        var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        void Close()
        {
            if (kind is { } k && !(k == MediaTrackKind.Subtitle && fields.GetValueOrDefault("Format") is { } format &&
                format.StartsWith("EIA-", StringComparison.OrdinalIgnoreCase)))
            {
                var raw = fields.GetValueOrDefault("Language");
                tracks.Add(new(LeadingNumber(fields.GetValueOrDefault("ID")) ?? 1000 + tracks.Count, k, Code(raw), raw,
                    Yes(fields, "Default"), !No(fields, "Enabled"), Yes(fields, "Forced"), fields.GetValueOrDefault("Title"),
                    fields.GetValueOrDefault("Format")));
            }
            kind = null;
            fields.Clear();
        }
        foreach (var raw in report.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0) continue;
            if (Field().Match(line) is not { Success: true } field)
            {
                Close();
                var section = line.Split(' ', 2)[0];
                kind = section.Equals("Video", StringComparison.OrdinalIgnoreCase) ? MediaTrackKind.Video
                    : section.Equals("Audio", StringComparison.OrdinalIgnoreCase) ? MediaTrackKind.Audio
                    : section.Equals("Text", StringComparison.OrdinalIgnoreCase) ? MediaTrackKind.Subtitle : null;
                continue;
            }
            if (kind != null) fields.TryAdd(field.Groups["name"].Value.Trim(), field.Groups["value"].Value.Trim());
        }
        Close();
        return tracks;
    }

    /// <summary>Subtitle attachments in the original feed's shape or Anime Tosho NEW's.</summary>
    private static List<MediaTrack> Attachments(IEnumerable<JsonElement> attachments)
    {
        var tracks = new List<MediaTrack>();
        foreach (var attachment in attachments)
        {
            if (Text(attachment, "type") != "subtitle" || !attachment.TryGetProperty("info", out var info) || info.ValueKind != JsonValueKind.Object) continue;
            var code = Text(info, "lang") ?? Text(info, "language_code");
            var label = Text(info, "language");
            var number = Number(info, "tracknum") ?? Number(info, "trackid") ??
                (Text(attachment, "url") is { } url && TrackInUrl().Match(url) is { Success: true } m && int.TryParse(m.Groups[1].Value, out var n)
                    ? n : 2000 + tracks.Count);
            // The new feed has no track name; its label ("English (SDH)", "Latin American") is one when it says more than the language.
            var name = Text(info, "name") ?? (label is { Length: > 0 } && !IsLanguage(label) ? label : null);
            tracks.Add(new(number, MediaTrackKind.Subtitle, LanguageTag.Normalize(code) ?? Code(label), code ?? label, Flag(info, "default"),
                !info.TryGetProperty("enabled", out _) || Flag(info, "enabled"), Flag(info, "forced"), name, Text(info, "codec") ?? Text(info, "format")));
        }
        return tracks;
    }

    /// <summary>A language as a code ("eng") or as a name ("English", "Portuguese (Brazil)", "European Spanish"); null when unknown.</summary>
    private static string? Code(string? text) => string.IsNullOrWhiteSpace(text) ? null : LanguageTag.Normalize(text) ?? ReleaseLanguage.NameLanguage(text);

    /// <summary>"English" or "eng" alone, nothing more.</summary>
    private static bool IsLanguage(string label) => LanguageTag.Normalize(label) != null ||
        Code(label) is { } code && ReleaseLanguage.LanguageName(code).Equals(label.Trim(), StringComparison.OrdinalIgnoreCase);

    private static string Stem(string path)
    {
        var file = path.Replace('\\', '/')[(path.Replace('\\', '/').LastIndexOf('/') + 1)..];
        var dot = file.LastIndexOf('.');
        return dot > 0 ? file[..dot] : file;
    }

    // Each helper reads a value only from an object and only of the expected type: anything else reads as missing.
    private static IEnumerable<JsonElement> Array(JsonElement row, string key) =>
        row.ValueKind == JsonValueKind.Object && row.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Array ? value.EnumerateArray() : [];

    private static string? Text(JsonElement row, string key) =>
        row.ValueKind == JsonValueKind.Object && row.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static int? Number(JsonElement row, string key) =>
        row.ValueKind == JsonValueKind.Object && row.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number &&
        value.TryGetInt32(out var n) ? n : null;

    /// <summary>A size in bytes: a number, or digits in a string; 0 when unknown.</summary>
    private static long Long(JsonElement row, string key) =>
        row.ValueKind == JsonValueKind.Object && row.TryGetProperty(key, out var value) &&
        (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var n) || value.ValueKind == JsonValueKind.String && long.TryParse(value.GetString(), out n))
        && n > 0 ? n : 0;

    /// <summary>true/false, or 1/0 in the original feed.</summary>
    private static bool Flag(JsonElement row, string key) => row.ValueKind == JsonValueKind.Object && row.TryGetProperty(key, out var value) &&
        (value.ValueKind == JsonValueKind.True || value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var n) && n != 0);

    private static bool Yes(Dictionary<string, string> fields, string key) =>
        fields.TryGetValue(key, out var value) && value.StartsWith("Yes", StringComparison.OrdinalIgnoreCase);

    private static bool No(Dictionary<string, string> fields, string key) =>
        fields.TryGetValue(key, out var value) && value.StartsWith("No", StringComparison.OrdinalIgnoreCase);

    private static int? LeadingNumber(string? text) =>
        text != null && LeadingDigits().Match(text) is { Success: true } m && int.TryParse(m.Value, out var n) ? n : null;

    /// <summary>"Title                                    : Signs": the name, then padding and a colon.</summary>
    [GeneratedRegex(@"^(?<name>.+?)\s+:\s?(?<value>.*)$", RegexOptions.CultureInvariant)]
    private static partial Regex Field();

    [GeneratedRegex(@"^\d+", RegexOptions.CultureInvariant)]
    private static partial Regex LeadingDigits();

    [GeneratedRegex(@"_track(\d+)\.", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex TrackInUrl();
}
