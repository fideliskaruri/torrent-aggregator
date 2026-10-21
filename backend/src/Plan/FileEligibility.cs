using System.Text;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Plan;

internal static class FileEligibility
{
    private static readonly HashSet<string> Video = new(StringComparer.OrdinalIgnoreCase)
        { "mkv", "mp4", "avi", "m4v", "mov", "wmv", "flv", "webm", "ts", "m2ts", "mpg", "mpeg", "vob" };
    private static readonly HashSet<string> Dangerous = new(StringComparer.OrdinalIgnoreCase)
        { "exe", "msi", "msp", "bat", "cmd", "com", "scr", "pif", "lnk", "vbs", "vbe", "js", "jse",
          "wsf", "wsh", "ps1", "psm1", "hta", "cpl", "jar", "apk", "dll", "sys", "reg" };
    private static readonly HashSet<string> Archives = new(StringComparer.OrdinalIgnoreCase)
        { "rar", "zip", "7z", "tar", "gz", "tgz", "bz2", "xz", "iso", "img" };
    private static readonly HashSet<string> Discs = new(StringComparer.OrdinalIgnoreCase)
        { "iso", "img", "vob", "bdmv", "mpls", "ifo" };
    private static readonly HashSet<string> Subtitles = new(StringComparer.OrdinalIgnoreCase)
        { "srt", "ass", "ssa", "sub", "idx", "vtt", "sup" };
    private static readonly HashSet<string> Audio = new(StringComparer.OrdinalIgnoreCase)
        { "mka", "aac", "ac3", "eac3", "dts", "flac", "mp3", "opus", "m4a", "thd" };
    private static readonly Regex Extra = new(
        @"(?:^|[\\/ ._\-\[(])(?:samples?|extras?|featurettes?|bonus|specials?|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes|trailers?|NCOP\d*|NCED\d*|creditless|OVA|OAD)(?:[\\/ ._\-\])]|$)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    private static readonly Regex EpisodeCoordinate = new(
        @"(?i)\bS\d{1,3}[ ._-]?E\d{1,4}\b|\b\d{1,2}x\d{2,3}\b",
        RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    private static readonly Regex Technical = new(
        @"(?i)\b(?:2160|1080|720|480|360|576)[pi]?\b|\b(?:WEB[- ]?(?:DL|Rip)|Blu[- ]?Ray|BDRip|BRRip|HDTV|DVDRip|DVD|HEVC|AVC|x26[45]|H\.?26[45]|AAC|DDP|EAC3|AC3|DTS|TrueHD|FLAC|MP3|Opus)\b",
        RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    private static readonly Regex Words = new(@"[\p{L}\p{N}]+",
        RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));

    internal static string Extension(string path)
    {
        var leaf = path.Replace('\\', '/').Split('/')[^1].TrimEnd('.', ' ');
        return leaf[(leaf.LastIndexOf('.') + 1)..];
    }
    internal static bool IsVideo(TorrentFile file) => Video.Contains(Extension(file.RelativePath));
    internal static bool IsExtra(TorrentFile file)
    {
        var path = file.RelativePath.Replace('\\', '/');
        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Take(Math.Max(0, segments.Length - 1)).Any(segment => Extra.IsMatch(segment)))
            return true;
        if (segments.Length == 0) return false;
        var leaf = segments[^1];
        var dot = leaf.LastIndexOf('.');
        var stem = dot < 0 ? leaf : leaf[..dot];
        if (stem.TrimEnd(' ', '.', '_', '-').EndsWith("sample", StringComparison.OrdinalIgnoreCase))
            return true;
        var coordinates = EpisodeCoordinate.Matches(stem);
        if (coordinates.Count == 0) return Extra.IsMatch(leaf);
        var last = coordinates.Cast<Match>().MaxBy(match => match.Index + match.Length)!;
        var start = last.Index + last.Length;
        var technicalStart = Technical.Matches(stem).Cast<Match>()
            .Select(match => match.Index).DefaultIfEmpty(stem.Length).Min();
        if (start < technicalStart)
        {
            var span = stem[start..technicalStart];
            var hasNonSampleWord = Words.Matches(span).Cast<Match>()
                .Any(word => !word.Value.Equals("sample", StringComparison.OrdinalIgnoreCase));
            if (hasNonSampleWord)
                stem = stem[..start] + new string(' ', technicalStart - start) + stem[technicalStart..];
        }
        return Extra.IsMatch(stem);
    }
    internal static bool IsArchive(TorrentFile file) => Archives.Contains(Extension(file.RelativePath)) ||
        Regex.IsMatch(Extension(file.RelativePath), @"^(?:r\d{2}|\d{3})$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    internal static bool IsDisc(TorrentFile file) => Discs.Contains(Extension(file.RelativePath)) ||
        file.RelativePath.Replace('\\', '/').Split('/').Any(p =>
            p.Equals("BDMV", StringComparison.OrdinalIgnoreCase) || p.Equals("VIDEO_TS", StringComparison.OrdinalIgnoreCase) ||
            p.Equals("AUDIO_TS", StringComparison.OrdinalIgnoreCase));
    internal static (string Code, string Text)? Safety(IReadOnlyList<TorrentFile> files, bool pack)
    {
        if (files.Any(f => Dangerous.Contains(Extension(f.RelativePath))))
            return ("unsafe_program", "This source contains a program or script.");
        if (files.Any(f => f.Index < 0 || f.Bytes < 0 || f.Offset < 0 || f.Offset > long.MaxValue - f.Bytes) ||
            files.Select(f => f.Index).Distinct().Count() != files.Count)
            return ("invalid_files", "The source has invalid file sizes or duplicate file indices.");
        if (pack && files.Any(IsDisc)) return ("disc_image", "A season pack cannot contain disc images or disc folders.");
        if (pack && files.Any(IsArchive)) return ("pack_archive", "A season pack cannot contain archives.");
        if (!files.Any(IsVideo))
            return files.Any(IsArchive) ? ("archive_only", "This source contains archives, not video files.") :
                ("no_video", "This source contains no video files.");
        return null;
    }
    internal static FileRole? SidecarRole(TorrentFile file) => Subtitles.Contains(Extension(file.RelativePath))
        ? FileRole.Subtitle : Audio.Contains(Extension(file.RelativePath)) ? FileRole.Audio : null;
    internal static (string Folder, string Stem) Split(TorrentFile file)
    {
        var path = file.RelativePath.Replace('\\', '/').Normalize(NormalizationForm.FormC);
        var slash = path.LastIndexOf('/');
        var leaf = path[(slash + 1)..];
        var dot = leaf.LastIndexOf('.');
        return (slash < 0 ? "" : path[..(slash + 1)], dot < 0 ? leaf : leaf[..dot]);
    }
    internal static bool SameStem(string a, string b) => a.Equals(b, StringComparison.OrdinalIgnoreCase) ||
        a.Length > b.Length && a.StartsWith(b, StringComparison.OrdinalIgnoreCase) &&
        (a[b.Length] is '.' or '_' or '[' or '(' ||
         a[b.Length] == ' ' && a.Length > b.Length + 1 && a[b.Length + 1] is '[' or '(');

    internal static long Reservation(IReadOnlyList<TorrentFile> files, IEnumerable<int> selected, long? pieceLength)
    {
        var indices = selected.ToHashSet();
        var kept = files.Where(f => indices.Contains(f.Index) && f.Bytes > 0).ToArray();
        var total = files.Count == 0 ? 0 : files.Max(f => f.Offset + f.Bytes);
        // Without piece geometry reserve the whole torrent, never underestimate boundary pieces.
        if (pieceLength is not > 0) return total;
        var length = pieceLength.Value;
        var spans = kept.Select(f => (First: f.Offset / length, Last: (f.Offset + f.Bytes - 1) / length))
            .OrderBy(s => s.First).ToArray();
        long bytes = 0, first = -1, last = -1;
        foreach (var span in spans)
        {
            if (first < 0) { first = span.First; last = span.Last; }
            else if (span.First <= last + 1) last = Math.Max(last, span.Last);
            else { bytes += Span(first, last); first = span.First; last = span.Last; }
        }
        return first < 0 ? 0 : bytes + Span(first, last);
        long Span(long start, long end) => (end == (total - 1) / length ? total : (end + 1) * length) - start * length;
    }
}
