using System.Globalization;
using System.Text.RegularExpressions;

namespace TorrentFlow.Media.Streaming;

public sealed record StreamRange(long Start, long End, string? ContentRange, int Status)
{
    public long Length => End - Start + 1;
}

/// <summary>Byte-range parsing for the torrent stream route and the HLS/VOD file routes.</summary>
public static partial class HttpRanges
{
    public const long OpenEndedRangeCapBytes = 128L * 1024 * 1024;

    /// <summary>
    /// The npm <c>range-parser</c> algorithm (first range wins) plus the stream route's clamp: an open-ended
    /// <c>bytes=N-</c> is capped at 128 MiB so abandoned consumers release their read. null = 416.
    /// </summary>
    public static StreamRange? ParseStreamRange(string? header, long fileLength)
    {
        var lastByte = Math.Max(0, fileLength - 1);
        if (string.IsNullOrEmpty(header)) return new StreamRange(0, lastByte, null, 200);
        var parsed = RangeParser(fileLength, header);
        if (parsed is not { Count: > 0 }) return null;
        var (start, rawEnd) = parsed[0];
        var end = Math.Min(rawEnd, lastByte);
        if (OpenEndedRe().IsMatch(header.Trim())) end = Math.Min(end, start + OpenEndedRangeCapBytes - 1);
        if (start < 0 || start > end || end >= fileLength) return null;
        return new StreamRange(start, end, $"bytes {start}-{end}/{fileLength}", 206);
    }

    /// <summary>range-parser(size, str): null for malformed (-2) or unsatisfiable (-1).</summary>
    internal static List<(long Start, long End)>? RangeParser(long size, string str)
    {
        var index = str.IndexOf('=');
        if (index == -1) return null;
        var ranges = new List<(long, long)>();
        foreach (var part in str[(index + 1)..].Split(','))
        {
            var pieces = part.Split('-');
            var start = ParseIntJs(pieces[0]);
            var end = pieces.Length > 1 ? ParseIntJs(pieces[1]) : null;
            if (start is null)
            {
                if (end is null) continue;
                start = size - end.Value;
                end = size - 1;
            }
            else if (end is null) end = size - 1;
            if (end > size - 1) end = size - 1;
            if (start > end || start < 0) continue;
            ranges.Add((start.Value, end.Value));
        }
        return ranges.Count < 1 ? null : ranges;
    }

    /// <summary>JavaScript <c>parseInt(s, 10)</c>: leading whitespace, optional sign, then digits.</summary>
    private static long? ParseIntJs(string s)
    {
        var t = s.TrimStart();
        var i = 0;
        var neg = false;
        if (i < t.Length && t[i] is '+' or '-') { neg = t[i] == '-'; i++; }
        var startDigits = i;
        while (i < t.Length && char.IsAsciiDigit(t[i])) i++;
        if (i == startDigits) return null;
        if (!long.TryParse(t.AsSpan(startDigits, i - startDigits), NumberStyles.None, CultureInfo.InvariantCulture, out var v)) return null;
        return neg ? -v : v;
    }

    /// <summary>Port of parseSegmentRange: null = no range, Unsatisfiable = 416.</summary>
    public static (long Start, long End)? ParseSegmentRange(string? header, long size, out bool unsatisfiable)
    {
        unsatisfiable = false;
        if (string.IsNullOrEmpty(header)) return null;
        var m = SegmentRangeRe().Match(header.Trim());
        if (!m.Success) { unsatisfiable = true; return null; }
        var rawStart = m.Groups[1].Value;
        var rawEnd = m.Groups[2].Value;
        if (rawStart.Length == 0 && rawEnd.Length == 0) { unsatisfiable = true; return null; }
        double start, end;
        if (rawStart.Length == 0)
        {
            var suffix = double.Parse(rawEnd, CultureInfo.InvariantCulture);
            if (!double.IsFinite(suffix) || suffix <= 0) { unsatisfiable = true; return null; }
            start = Math.Max(0, size - suffix);
            end = size - 1;
        }
        else
        {
            start = double.Parse(rawStart, CultureInfo.InvariantCulture);
            end = rawEnd.Length == 0 ? size - 1 : double.Parse(rawEnd, CultureInfo.InvariantCulture);
        }
        end = Math.Min(end, size - 1);
        if (start > end || start < 0 || start >= size) { unsatisfiable = true; return null; }
        return ((long)start, (long)end);
    }

    public static string ContentTypeForSegment(string filename)
    {
        var lower = filename.ToLowerInvariant();
        if (lower.EndsWith(".m3u8", StringComparison.Ordinal)) return "application/vnd.apple.mpegurl";
        if (lower.EndsWith(".m4s", StringComparison.Ordinal)) return "video/iso.segment";
        if (lower.EndsWith(".mp4", StringComparison.Ordinal)) return "video/mp4";
        if (lower.EndsWith(".ts", StringComparison.Ordinal)) return "video/mp2t";
        return "application/octet-stream";
    }

    public static string ContentTypeForPath(string filePath)
    {
        var dot = filePath.LastIndexOf('.');
        var ext = dot < 0 ? filePath.ToLowerInvariant() : filePath[(dot + 1)..].ToLowerInvariant();
        return ext switch
        {
            "mkv" => "video/x-matroska",
            "webm" => "video/webm",
            "mp4" or "m4v" => "video/mp4",
            "mov" => "video/quicktime",
            "ogv" => "video/ogg",
            "ts" => "video/mp2t",
            "avi" => "video/x-msvideo",
            "wmv" => "video/x-ms-wmv",
            "srt" or "vtt" => "text/vtt; charset=utf-8",
            _ => "application/octet-stream",
        };
    }

    /// <summary>Port of resolveWithinSessionDir: refuses anything escaping the output directory.</summary>
    public static string? ResolveWithin(string outputDir, string filename)
    {
        if (string.IsNullOrEmpty(filename) || filename.Contains('\0')) return null;
        var relative = filename.Replace('\\', '/');
        if (relative.StartsWith('/') || WinRootRe().IsMatch(relative)) return null;
        var baseDir = Path.GetFullPath(outputDir);
        string resolved;
        try { resolved = Path.GetFullPath(Path.Combine(baseDir, relative.Replace('/', Path.DirectorySeparatorChar))); }
        catch (ArgumentException) { return null; }
        var trimmedBase = baseDir.TrimEnd(Path.DirectorySeparatorChar);
        if (resolved != trimmedBase && !resolved.StartsWith(trimmedBase + Path.DirectorySeparatorChar, StringComparison.Ordinal)) return null;
        return resolved;
    }

    [GeneratedRegex(@"^bytes=\d+-\s*$", RegexOptions.IgnoreCase)] private static partial Regex OpenEndedRe();
    [GeneratedRegex(@"^bytes=(\d*)-(\d*)$")] private static partial Regex SegmentRangeRe();
    [GeneratedRegex(@"^(?:[A-Za-z]:|//)")] private static partial Regex WinRootRe();
}
