using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using TorrentFlow.Media.Probing;

namespace TorrentFlow.Media.Playback;

public sealed record VideoPlan
{
    public required string Codec { get; init; }
    public int StreamIndex { get; init; }
    public required string Action { get; init; }
    public string? TargetCodec { get; init; }
    public string? HwAccel { get; init; }
    public string? CodecTag { get; init; }
}

public sealed record AudioPlan
{
    public int StreamIndex { get; init; }
    public required string Codec { get; init; }
    public required string Action { get; init; }
    public int Channels { get; init; }
    public string? TargetCodec { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Language { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Title { get; init; }
}

public sealed record SubtitleDecision(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? DefaultTrackId,
    bool AudioIsEnglish,
    bool EnglishSubtitleAvailable,
    bool NoEnglishAvailable,
    bool ForcedFallback,
    string Reason);

public sealed record SubtitleCandidate(string Id, string? Language, bool Forced, bool Supported);

public sealed record PlaybackPlan
{
    public required string Rung { get; init; }
    public required string Reason { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public VideoPlan? Video { get; init; }
    public required IReadOnlyList<AudioPlan> Audio { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public int? SelectedAudioIndex { get; init; }
    public required string Container { get; init; }
    public int Cost { get; init; }
    public required SubtitleDecision Subtitle { get; init; }

    [JsonIgnore] public AudioPlan? SelectedAudio => SelectedAudioIndex is { } i ? Audio.FirstOrDefault(a => a.StreamIndex == i) : null;
}

/// <summary>Port of src/lib/media/decide.ts.</summary>
public static partial class Decide
{
    private static readonly HashSet<string> BrowserVideo = ["h264", "hevc", "av1", "vp9", "vp8"];
    private static readonly HashSet<string> BrowserAudio = ["aac", "opus", "flac", "vorbis"];
    private static readonly HashSet<string> UnsupportedAudio = ["dts", "truehd", "pcm", "mp2"];

    private static readonly Dictionary<string, string> LanguageAliases = new()
    {
        ["eng"] = "en", ["fre"] = "fr", ["fra"] = "fr", ["ger"] = "de", ["deu"] = "de", ["dut"] = "nl", ["nld"] = "nl",
        ["gre"] = "el", ["ell"] = "el", ["alb"] = "sq", ["sqi"] = "sq", ["arm"] = "hy", ["hye"] = "hy", ["baq"] = "eu", ["eus"] = "eu",
        ["cze"] = "cs", ["ces"] = "cs", ["chi"] = "zh", ["zho"] = "zh", ["ice"] = "is", ["isl"] = "is", ["mac"] = "mk", ["mkd"] = "mk",
        ["mao"] = "mi", ["mri"] = "mi", ["may"] = "ms", ["msa"] = "ms", ["per"] = "fa", ["fas"] = "fa", ["rum"] = "ro", ["ron"] = "ro",
        ["slo"] = "sk", ["slk"] = "sk", ["tib"] = "bo", ["bod"] = "bo", ["wel"] = "cy", ["cym"] = "cy", ["jpn"] = "ja", ["spa"] = "es",
        ["ita"] = "it", ["por"] = "pt", ["rus"] = "ru", ["kor"] = "ko", ["ara"] = "ar", ["hin"] = "hi",
    };

    public static bool IsVideoSupportedInFmp4(string codec, string? profile, ClientCapabilities caps) =>
        BrowserVideo.Contains(codec.ToLowerInvariant()) && Capabilities.SupportsCodecTag(caps, Capabilities.VideoCodecTag(codec, profile));

    public static bool IsAudioSupportedInFmp4(string codec, ClientCapabilities caps)
    {
        var lc = codec.ToLowerInvariant();
        if (UnsupportedAudio.Contains(lc)) return false;
        if (BrowserAudio.Contains(lc)) return true;
        return Capabilities.SupportsCodecTag(caps, Capabilities.AudioCodecTag(lc));
    }

    public static string ChooseAudioTarget(int channels, ClientCapabilities caps) =>
        channels <= 2 ? "aac" : Capabilities.SupportsCodecTag(caps, "ec-3") ? "eac3" : "aac";

    public static bool CanDirectPlay(string container, ProbeStream? video, ProbeStream? audio, ClientCapabilities caps) =>
        Capabilities.SupportsContainer(caps, container)
        && (video is null || IsVideoSupportedInFmp4(video.Codec ?? "", video.Profile, caps))
        && (audio is null || IsAudioSupportedInFmp4(audio.Codec ?? "", caps));

    public static string? NormalizedLanguage(string? tag)
    {
        var lc = (tag ?? "").Trim().ToLowerInvariant();
        if (lc is "" or "und") return null;
        var primary = lc.Split('-', '_')[0];
        if (primary is "" or "und") return null;
        return LanguageAliases.TryGetValue(primary, out var alias) ? alias : primary;
    }

    public static bool IsEnglish(string? tag) => NormalizedLanguage(tag) == "en";

    public static ProbeStream? SelectPreferredAudio(IReadOnlyList<ProbeStream> streams, int? audioStreamIndex = null, string? preferredLanguage = null)
    {
        if (streams.Count == 0) return null;
        if (audioStreamIndex is { } idx && streams.FirstOrDefault(s => s.Index == idx) is { } explicitStream) return explicitStream;
        var nonCommentary = streams.Where(s => !CommentaryRe().IsMatch(s.Title ?? "")).ToList();
        var auto = nonCommentary.Count > 0 ? nonCommentary : streams.ToList();
        var languages = new List<string>();
        foreach (var l in new[] { NormalizedLanguage(preferredLanguage), "en" })
            if (l is not null && !languages.Contains(l)) languages.Add(l);
        foreach (var lang in languages)
        {
            var matches = auto.Where(s => NormalizedLanguage(s.Language) == lang).ToList();
            if (matches.Count > 0) return BestLanguageMatch(matches);
        }
        var defaults = auto.Where(s => s.DispositionDefault == true).ToList();
        return defaults.Count > 0 ? BestLanguageMatch(defaults) : auto[0];
    }

    private static ProbeStream BestLanguageMatch(List<ProbeStream> matches) =>
        matches.Select((s, i) => (s, i))
            .OrderByDescending(x => x.s.Channels ?? 0)
            .ThenByDescending(x => x.s.DispositionDefault == true ? 1 : 0)
            .ThenBy(x => x.i)
            .First().s;

    public static List<SubtitleCandidate> SubtitleCandidatesFromProbe(IEnumerable<ProbeStream> streams) =>
        Features.Subtitles.SubtitleRules.BuildTracks(
                streams.Select(s => new Features.Subtitles.SubtitleStream(s.Index, s.CodecType, s.Codec ?? "", s.Language, s.Title, s.Channels, s.DispositionDefault == true)),
                files: null, videoPath: "")
            .Select(t => new SubtitleCandidate(t.Id, t.Language, t.Forced, t.Supported)).ToList();

    public static SubtitleDecision SelectDefaultSubtitle(string? audioLanguage, IReadOnlyList<SubtitleCandidate> candidates)
    {
        var audioIsEnglish = IsEnglish(audioLanguage);
        var english = candidates.Where(c => c.Supported && IsEnglish(c.Language)).ToList();
        var available = english.Count > 0;
        if (audioIsEnglish) return new(null, true, available, false, false, "Audio is English \u2014 subtitles off by default");
        if (!available)
        {
            var supported = candidates.Where(c => c.Supported).ToList();
            var fallback = supported.FirstOrDefault(c => !c.Forced) ?? supported.FirstOrDefault();
            return new(fallback?.Id, false, false, true, fallback?.Forced ?? false,
                fallback is not null
                    ? "No English subtitles available \u2014 defaulting to another supported subtitle"
                    : "No English audio and no supported subtitles available");
        }
        var full = english.FirstOrDefault(c => !c.Forced);
        var chosen = full ?? english[0];
        var forcedFallback = full is null;
        return new(chosen.Id, false, true, false, forcedFallback,
            forcedFallback
                ? "Non-English audio \u2014 defaulting to the only English subtitle (forced)"
                : "Non-English audio \u2014 defaulting to English subtitles");
    }

    public static PlaybackPlan DecidePlayback(ProbeResult probe, ClientCapabilities caps, int? audioStreamIndex = null, string? preferredAudioLanguage = null, IReadOnlyList<SubtitleCandidate>? subtitleCandidates = null)
    {
        var container = ProbeShape.NormalizeContainer(probe.Container);
        var video = probe.Video;
        var allAudio = probe.Audio.ToList();
        var audio = SelectPreferredAudio(allAudio, audioStreamIndex, preferredAudioLanguage);
        int? selected = audio?.Index;
        var subtitle = SelectDefaultSubtitle(audio?.Language, [.. subtitleCandidates ?? [], .. SubtitleCandidatesFromProbe(probe.Streams)]);

        PlaybackPlan Plan(string rung, string reason, VideoPlan? v, IReadOnlyList<AudioPlan> a, int cost) => new()
        {
            Rung = rung, Reason = reason, Video = v, Audio = a, SelectedAudioIndex = selected, Container = container, Cost = cost, Subtitle = subtitle,
        };

        if (video is null)
        {
            if (audio is not null && Capabilities.SupportsContainer(caps, container) && IsAudioSupportedInFmp4(audio.Codec ?? "", caps))
                return Plan("direct", "Audio-only file, container and codec compatible", null, BuildAudioPlans(allAudio, caps, "copy"), 0);
            return Plan(audio is not null ? "remux" : "direct", audio is not null ? "Audio-only file needs remux" : "No playable streams found", null,
                audio is not null ? BuildAudioPlans(allAudio, caps, "auto") : [], audio is not null ? 1 : 0);
        }
        var vcodec = video.Codec ?? "unknown";
        var codecTag = Capabilities.VideoCodecTag(vcodec, video.Profile);
        var copy = new VideoPlan { Codec = vcodec, StreamIndex = video.Index, Action = "copy", CodecTag = codecTag };
        if (CanDirectPlay(container, video, audio, caps))
            return Plan("direct", $"Container {container} and all codecs natively supported", copy, BuildAudioPlans(allAudio, caps, "copy"), 0);
        var videoOk = IsVideoSupportedInFmp4(vcodec, video.Profile, caps);
        var audioOk = audio is null || IsAudioSupportedInFmp4(audio.Codec ?? "", caps);
        if (videoOk && audioOk)
            return Plan("remux", $"Codecs supported but container {container} is not \u2014 remux to fMP4 ({Capabilities.Fmp4Mime(vcodec, audio?.Codec, video.Profile)})", copy, BuildAudioPlans(allAudio, caps, "copy"), 1);
        if (videoOk)
            return Plan("transcode-audio", $"Video {vcodec} supported, audio {audio?.Codec ?? "none"} needs transcoding", copy, BuildAudioPlans(allAudio, caps, "auto"), 2);
        return Plan("transcode-full",
            $"Video codec {vcodec}{(string.IsNullOrEmpty(video.Profile) ? "" : $" ({video.Profile})")} unsupported \u2014 full transcode required",
            new VideoPlan { Codec = vcodec, StreamIndex = video.Index, Action = "transcode", TargetCodec = "h264", HwAccel = "h264_amf", CodecTag = codecTag },
            BuildAudioPlans(allAudio, caps, "auto"), 3);
    }

    private static List<AudioPlan> BuildAudioPlans(IEnumerable<ProbeStream> streams, ClientCapabilities caps, string mode) =>
        streams.Select(s =>
        {
            var channels = s.Channels ?? 2;
            var codec = s.Codec ?? "unknown";
            var supported = IsAudioSupportedInFmp4(codec, caps);
            return mode == "copy" || supported
                ? new AudioPlan { StreamIndex = s.Index, Codec = codec, Action = "copy", Channels = channels, Language = s.Language, Title = s.Title }
                : new AudioPlan { StreamIndex = s.Index, Codec = codec, Action = "transcode", TargetCodec = ChooseAudioTarget(channels, caps), Channels = channels, Language = s.Language, Title = s.Title };
        }).ToList();

    [GeneratedRegex("commentary|director", RegexOptions.IgnoreCase)] private static partial Regex CommentaryRe();
}
