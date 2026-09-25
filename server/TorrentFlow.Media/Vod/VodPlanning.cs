using System.Buffers.Binary;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using TorrentFlow.Media.Playback;

namespace TorrentFlow.Media.Vod;

public sealed record VodSegment(int Index, double Start, double Duration);

public sealed record StrategyDecision(string Strategy, string Reason);

public sealed record TrimmedPlaylist(string Text, double OffsetSeconds);

public sealed record Mp4Split(byte[] Init, byte[] Media);

/// <summary>Pure pieces of src/lib/media/vod.ts.</summary>
public static partial class VodPlanning
{
    public const int SegmentSeconds = 4;
    public const double MinTailSeconds = 0.5;
    public const string WholeFilePlaylist = "playlist.m3u8";
    public const string WholeFileData = "data.m4s";
    public const string InitName = "init.mp4";

    public static double Round3(double v) => Math.Round(v * 1000, MidpointRounding.AwayFromZero) / 1000;

    public static StrategyDecision ChooseStrategy(bool complete, PlaybackPlan plan, double? duration)
    {
        if (plan.Rung == "direct") return new("session", "direct play needs no ffmpeg");
        if (!complete) return new("session", "file is not fully downloaded yet");
        if (duration is not { } d || !double.IsFinite(d) || d <= 0) return new("session", "source duration is unknown");
        if (plan.Video is null) return new("session", "no video stream to segment");
        if (plan.Video.Action == "copy") return new("whole-file", "video can be copied \u2014 one conversion gives native seeking");
        return new("vod-segments", "video must be re-encoded \u2014 segment on demand from a VOD playlist");
    }

    public static List<VodSegment> FixedGridSegments(double duration, double segSec = SegmentSeconds)
    {
        if (!double.IsFinite(duration) || duration <= 0 || segSec <= 0) return [];
        var count = (int)Math.Ceiling(Round3(duration / segSec));
        var list = new List<VodSegment>(count);
        for (var i = 0; i < count; i++)
        {
            var start = i * segSec;
            list.Add(new VodSegment(i, start, Round3(Math.Min(segSec, duration - start))));
        }
        return MergeShortTail(list);
    }

    public static List<VodSegment> KeyframeAlignedSegments(IEnumerable<double>? keyframes, double duration, double target = SegmentSeconds)
    {
        if (!double.IsFinite(duration) || duration <= 0) return [];
        var keys = (keyframes ?? []).Where(t => double.IsFinite(t) && t >= 0 && t < duration).Distinct().Order().ToList();
        if (keys.Count == 0) return FixedGridSegments(duration, target);
        var boundaries = new List<double> { keys[0] };
        var cursor = 0;
        while (true)
        {
            var last = boundaries[^1];
            var next = -1;
            for (var i = cursor + 1; i < keys.Count; i++)
                if (keys[i] >= last + target) { next = i; break; }
            if (next < 0) break;
            boundaries.Add(keys[next]);
            cursor = next;
        }
        var list = new List<VodSegment>(boundaries.Count);
        for (var i = 0; i < boundaries.Count; i++)
        {
            var end = i + 1 < boundaries.Count ? boundaries[i + 1] : duration;
            list.Add(new VodSegment(i, boundaries[i], Round3(end - boundaries[i])));
        }
        return MergeShortTail(list);
    }

    public static List<VodSegment> MergeShortTail(List<VodSegment> segments)
    {
        if (segments.Count < 2 || segments[^1].Duration >= MinTailSeconds) return segments;
        var tail = segments[^1];
        var prev = segments[^2];
        segments.RemoveAt(segments.Count - 1);
        segments[^1] = prev with { Duration = Round3(prev.Duration + tail.Duration) };
        return segments;
    }

    public static string SegmentName(int index) => "seg" + index.ToString("D5", CultureInfo.InvariantCulture) + ".m4s";

    public static int? ParseSegmentIndex(string name)
    {
        var m = SegmentNameRe().Match(name);
        return m.Success ? int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) : null;
    }

    public static string BuildVodPlaylist(IReadOnlyList<VodSegment> segments)
    {
        var max = segments.Count == 0 ? 0 : segments.Max(s => s.Duration);
        var lines = new List<string>
        {
            "#EXTM3U", "#EXT-X-VERSION:7",
            $"#EXT-X-TARGETDURATION:{Math.Max(1, (int)Math.Ceiling(max))}",
            "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-INDEPENDENT-SEGMENTS",
            $"#EXT-X-MAP:URI=\"{InitName}\"",
        };
        foreach (var s in segments)
        {
            lines.Add("#EXTINF:" + s.Duration.ToString("F6", CultureInfo.InvariantCulture) + ",");
            lines.Add(SegmentName(s.Index));
        }
        lines.Add("#EXT-X-ENDLIST");
        return string.Join("\n", lines) + "\n";
    }

    public static TrimmedPlaylist TrimVodPlaylist(string text, double fromSeconds)
    {
        if (!double.IsFinite(fromSeconds) || fromSeconds <= 0) return new(text, 0);
        var header = new List<string>();
        var groups = new List<(List<string> Lines, double Start, double Duration)>();
        List<string>? current = null;
        double currentDuration = 0, cursor = 0;
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Trim().Length == 0) continue;
            if (line.StartsWith("#EXT-X-ENDLIST", StringComparison.Ordinal)) continue;
            if (line.StartsWith("#EXTINF:", StringComparison.Ordinal))
            {
                current = [line];
                var num = line["#EXTINF:".Length..].Split(',')[0];
                currentDuration = double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : 0;
                continue;
            }
            if (current is null) { header.Add(line); continue; }
            current.Add(line);
            if (!line.StartsWith('#'))
            {
                groups.Add((current, cursor, currentDuration));
                cursor += currentDuration;
                current = null;
            }
        }
        if (groups.Count == 0) return new(text, 0);
        var first = groups.FindIndex(g => g.Start + g.Duration > fromSeconds);
        if (first < 0) first = groups.Count - 1;
        var output = header.Select(h => h.StartsWith("#EXT-X-MEDIA-SEQUENCE:", StringComparison.Ordinal) ? $"#EXT-X-MEDIA-SEQUENCE:{first}" : h).ToList();
        foreach (var g in groups.Skip(first)) output.AddRange(g.Lines);
        output.Add("#EXT-X-ENDLIST");
        return new(string.Join("\n", output) + "\n", groups[first].Start);
    }

    public static Mp4Split? SplitFragmentedMp4(byte[] buffer)
    {
        var offset = 0;
        while (offset + 8 <= buffer.Length)
        {
            var size = BinaryPrimitives.ReadUInt32BigEndian(buffer.AsSpan(offset, 4));
            var type = Encoding.Latin1.GetString(buffer, offset + 4, 4);
            if (type == "moof")
            {
                if (offset == 0) return null;
                return new(buffer[..offset], buffer[offset..]);
            }
            if (size < 8 || offset + (long)size > buffer.Length) return null;
            offset += (int)size;
        }
        return null;
    }

    public static IReadOnlyList<string> BuildKeyframeProbeArgs(string path) =>
        ["-v", "error", "-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", path];

    public static List<double> ParseKeyframeTimes(string output)
    {
        var set = new SortedSet<double>();
        foreach (var raw in output.Split('\n'))
        {
            var parts = raw.Trim().Split(',');
            if (parts.Length < 2 || !parts[1].Contains('K')) continue;
            if (!double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var t) || !double.IsFinite(t) || t < 0) continue;
            set.Add(Round3(t));
        }
        return [.. set];
    }

    public static string SoftwareEncoder(string? targetCodec) => targetCodec is "hevc" or "libx265" ? "libx265" : "libx264";

    private static string Num(double v) => v.ToString(CultureInfo.InvariantCulture);

    public static List<string> BuildVodSegmentArgs(PlaybackPlan plan, string sourcePath, VodSegment segment, bool forceSoftware = true)
    {
        var args = new List<string> { "-hide_banner", "-loglevel", "error", "-analyzeduration", "10000000", "-probesize", "10000000", "-copyts" };
        if (segment.Start > 0) args.AddRange(["-ss", Num(segment.Start)]);
        args.AddRange(["-i", sourcePath, "-to", Num(Round3(segment.Start + segment.Duration))]);
        var audio = plan.SelectedAudio;
        if (plan.Video is { } v) args.AddRange(["-map", $"0:{v.StreamIndex}"]);
        if (audio is not null) args.AddRange(["-map", $"0:{audio.StreamIndex}"]);
        if (plan.Video is { } video)
        {
            if (video.Action == "copy")
            {
                args.AddRange(["-c:v", "copy"]);
                if (video.Codec == "hevc") args.AddRange(["-tag:v", "hvc1"]);
            }
            else
            {
                var encoder = forceSoftware ? SoftwareEncoder(video.TargetCodec) : video.HwAccel ?? SoftwareEncoder(video.TargetCodec);
                args.AddRange(["-c:v", encoder]);
                if (encoder is "libx264" or "libx265") args.AddRange(["-preset", "veryfast", "-crf", "23"]);
                args.AddRange(["-force_key_frames", Num(segment.Start), "-sc_threshold", "0", "-pix_fmt", "yuv420p"]);
            }
        }
        if (audio is not null)
        {
            if (audio.Action == "copy") args.AddRange(["-c:a", "copy"]);
            else args.AddRange(["-c:a", audio.TargetCodec ?? "eac3", "-ac", audio.Channels.ToString(CultureInfo.InvariantCulture)]);
        }
        args.AddRange(["-sn", "-dn", "-map_chapters", "-1", "-avoid_negative_ts", "disabled",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof+delay_moov", "-f", "mp4"]);
        return args;
    }

    public static List<string> BuildWholeFileHlsArgs(PlaybackPlan plan, string sourcePath)
    {
        var args = new List<string> { "-hide_banner", "-loglevel", "error", "-y", "-analyzeduration", "10000000", "-probesize", "10000000", "-i", sourcePath };
        var audio = plan.SelectedAudio;
        if (plan.Video is { } v) args.AddRange(["-map", $"0:{v.StreamIndex}"]);
        if (audio is not null) args.AddRange(["-map", $"0:{audio.StreamIndex}"]);
        args.AddRange(["-c:v", "copy"]);
        if (plan.Video?.Codec == "hevc") args.AddRange(["-tag:v", "hvc1"]);
        if (audio is not null)
        {
            if (audio.Action == "copy") args.AddRange(["-c:a", "copy"]);
            else args.AddRange(["-c:a", audio.TargetCodec ?? "eac3", "-ac", audio.Channels.ToString(CultureInfo.InvariantCulture)]);
        }
        args.AddRange(["-sn", "-dn", "-map_chapters", "-1",
            "-f", "hls", "-hls_time", "4", "-hls_list_size", "0", "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4",
            "-hls_flags", "single_file+independent_segments", "-hls_segment_filename", WholeFileData, WholeFilePlaylist]);
        return args;
    }

    [GeneratedRegex(@"^seg(\d{5})\.m4s$")] private static partial Regex SegmentNameRe();
}
