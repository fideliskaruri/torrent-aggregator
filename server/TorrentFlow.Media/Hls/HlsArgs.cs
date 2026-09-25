using System.Globalization;
using System.Text.RegularExpressions;
using TorrentFlow.Media.Playback;

namespace TorrentFlow.Media.Hls;

/// <summary>Port of buildFfmpegArgs in src/lib/media/session.ts.</summary>
public static partial class HlsArgs
{
    public const int SegmentSeconds = 4;

    public static string SourceKind(string url) => HttpRe().IsMatch(url) ? "swarm" : "disk";

    public static string SoftwareEncoder(string? targetCodec) => targetCodec == "hevc" ? "libx265" : "libx264";

    public static IReadOnlyList<string> VideoEncoderArgs(string encoder)
    {
        if (encoder.EndsWith("_amf", StringComparison.Ordinal)) return ["-quality", "speed", "-rc", "vbr_latency", "-b:v", "6M", "-maxrate", "10M"];
        if (encoder.EndsWith("_nvenc", StringComparison.Ordinal)) return ["-preset", "p1", "-rc", "vbr", "-cq", "26"];
        if (encoder.EndsWith("_qsv", StringComparison.Ordinal)) return ["-preset", "veryfast", "-global_quality", "26"];
        return ["-preset", "veryfast", "-crf", "23"];
    }

    public static List<string> Build(PlaybackPlan plan, string sourceUrl, int startSec = 0, bool forceSoftware = false)
    {
        var network = SourceKind(sourceUrl) == "swarm";
        var start = Math.Max(0, startSec);
        var args = new List<string> { "-hide_banner", "-loglevel", "warning", "-nostdin", "-y" };
        if (network) args.AddRange(["-rw_timeout", "15000000"]);
        args.AddRange(["-analyzeduration", "5000000", "-probesize", "10000000"]);
        if (network) args.AddRange(["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "5"]);
        if (start > 0) args.AddRange(["-ss", start.ToString(CultureInfo.InvariantCulture)]);
        args.AddRange(["-i", sourceUrl]);
        var audio = plan.SelectedAudio;
        if (plan.Video is { } v) args.AddRange(["-map", $"0:{v.StreamIndex}"]);
        if (audio is not null) args.AddRange(["-map", $"0:{audio.StreamIndex}"]);
        if (plan.Video is { } video)
        {
            if (video.Action == "copy")
            {
                args.AddRange(["-c:v", "copy"]);
                if (video.Codec.Equals("hevc", StringComparison.OrdinalIgnoreCase)) args.AddRange(["-tag:v", "hvc1"]);
            }
            else
            {
                var software = SoftwareEncoder(video.TargetCodec);
                var encoder = forceSoftware ? software : video.HwAccel ?? software;
                args.AddRange(["-c:v", encoder]);
                args.AddRange(VideoEncoderArgs(encoder));
                args.AddRange(["-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-pix_fmt", "yuv420p"]);
            }
        }
        else args.Add("-vn");
        if (audio is not null)
        {
            if (audio.Action == "copy") args.AddRange(["-c:a", "copy"]);
            else
            {
                var target = audio.TargetCodec ?? "aac";
                var perChannel = target == "eac3" ? 96 : 64;
                args.AddRange(["-c:a", target, "-ac", audio.Channels.ToString(CultureInfo.InvariantCulture), "-b:a", $"{perChannel * audio.Channels}k"]);
                if (target == "aac" && audio.Channels > 2) args.AddRange(["-strict", "-2"]);
            }
        }
        else args.Add("-an");
        args.Add("-sn");
        args.AddRange([
            "-f", "hls", "-hls_time", SegmentSeconds.ToString(CultureInfo.InvariantCulture), "-hls_list_size", "0", "-hls_playlist_type", "event",
            "-hls_segment_type", "fmp4", "-hls_flags", "independent_segments+temp_file",
            "-hls_segment_filename", "seg%05d.m4s", "-hls_fmp4_init_filename", "init.mp4",
            "playlist.m3u8",
        ]);
        return args;
    }

    [GeneratedRegex(@"^https?://", RegexOptions.IgnoreCase)] private static partial Regex HttpRe();
}
