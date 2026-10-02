using System.Globalization;
using System.Text.RegularExpressions;

namespace TorrentFlow.Core;

/// <summary>One file of an inspected release: its torrent index, torrent-relative path, size and payload offset.</summary>
public sealed record PackFile(int Index, string Path, long Length, long Offset);

/// <param name="Episodes">Missing episode number to the torrent file index that holds it.</param>
/// <param name="Rejection">archive | disc_image | unsafe | multi_season | no_episodes when the pack cannot be used.</param>
public sealed record PackFileMapping(IReadOnlyDictionary<int, int> Episodes, string? Rejection, IReadOnlyList<string> Notes)
{
    public bool Ok => Rejection == null && Episodes.Count > 0;
}

/// <summary>
/// Strict season pack file mapping (season pack fallback v1, docs/season-pack-fallback.md). A file is used only when
/// its own name says which episode of this season it is (S01E05 or 1x05), it is the only video for that episode, and
/// that episode is still missing. Bare and absolute numbers, double episodes, samples, extras and subtitles are never
/// used. Archives, disc images, executables and files from another season reject the whole pack.
/// </summary>
public static class SeasonPackFiles
{
    // Video, program and archive names come from MediaFileRules; disc images are checked first so iso/img stay disc images.
    private static readonly HashSet<string> Disc = new(StringComparer.OrdinalIgnoreCase) { ".iso", ".img", ".vob", ".bdmv", ".mpls", ".ifo" };
    private static readonly Regex DiscFolder = new(@"(?:^|[\\/])(?:VIDEO_TS|BDMV|AUDIO_TS)(?:[\\/]|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex Extra = new(@"(?:^|[\\/ ._\-\[(])(?:samples?|extras?|featurettes?|bonus|specials?|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes|trailers?|NCOP\d*|NCED\d*|creditless|OVA|OAD)(?:[\\/ ._\-\])]|$)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    // S01E05, S1E5, S01.E05, S01 E05. The negative lookahead refuses a second episode (E05E06, E05-E06, E05-06).
    private static readonly Regex SxxEyy = new(@"(?<![a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})(?![0-9])(?![ ._-]?(?:-|e|ep)[ ._-]?\d{1,3}(?![0-9p]))",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex NxMM = new(@"(?<![a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9])(?![ ._-]?(?:-|x)[ ._-]?\d{2,3}(?![0-9p]))",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex AnyEpisodeMark = new(@"(?<![a-z0-9])(?:s\d{1,2}[ ._-]?e\d{1,3}|\d{1,2}x\d{2,3})(?![0-9])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    // An absolute number: "Show - 05" (not a range "01-12"), "[05]", "E05", "EP05", "Episode 05", or a name that is only "05".
    private static readonly Regex Absolute = new(
        @"\s-\s(\d{1,4})(?:v\d)?(?![\p{L}\p{N}]|\s*[-~]\s*\d)|\[(\d{1,3})(?:v\d)?\]|(?<![\p{L}\p{N}])(?:e|ep|episode)[ ._-]?(\d{1,4})(?:v\d)?(?![\p{L}\p{N}])|^\s*(\d{1,4})\s*$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>
    /// The one episode a file or folder name gives, to tell which video a sidecar or a per-episode folder belongs to
    /// (<see cref="VideoSidecars"/>): "s1e5" for S01E05 or 1x05, "e5" for an absolute number ("Show - 05", "[05]", "E05",
    /// "Episode 05", a folder named "05"). Null when it gives none, or more than one.
    /// </summary>
    public static string? EpisodeKey(string name)
    {
        var marks = AnyEpisodeMark.Count(name);
        if (marks > 0)
        {
            var match = SxxEyy.Match(name) is { Success: true } s ? s : NxMM.Match(name);
            return marks == 1 && match.Success
                ? $"s{Number(match.Groups[1].Value)}e{Number(match.Groups[2].Value)}"
                : null;
        }
        var numbers = Absolute.Matches(name).Select(m => m.Groups.Values.Skip(1).First(g => g.Success).Value)
            .Select(Number).Distinct().ToList();
        return numbers.Count == 1 ? $"e{numbers[0]}" : null;
    }

    // \d also matches non-ASCII decimal digits (full-width "０５"), which int.Parse rejects; read each digit's value instead.
    private static int Number(string digits)
    {
        var value = 0;
        foreach (var c in digits) value = value * 10 + CharUnicodeInfo.GetDecimalDigitValue(c);
        return value;
    }

    /// <summary>Two <see cref="EpisodeKey"/>s name the same episode: equal, or one has no season and the numbers agree.</summary>
    public static bool SameEpisode(string a, string b) => a == b ||
        (a.StartsWith('e') || b.StartsWith('e')) && a[(a.IndexOf('e') + 1)..] == b[(b.IndexOf('e') + 1)..];

    public static PackFileMapping Map(IReadOnlyList<PackFile> files, int season, IReadOnlyCollection<int> missing)
    {
        var notes = new List<string>();
        var found = new Dictionary<int, List<int>>();
        foreach (var file in files)
        {
            var path = file.Path.Replace('\\', '/');
            var name = System.IO.Path.GetFileName(path);
            var ext = System.IO.Path.GetExtension(name);
            if (MediaFileRules.IsDangerous(name)) return Reject("unsafe", notes);
            if (Disc.Contains(ext) || DiscFolder.IsMatch(path)) return Reject("disc_image", notes);
            if (MediaFileRules.IsArchive(name)) return Reject("archive", notes);
            if (!MediaFileRules.IsVideo(name)) continue;
            if (Extra.IsMatch(path)) { notes.Add($"ignored extra {name}"); continue; }
            var marks = AnyEpisodeMark.Count(name);
            var match = SxxEyy.Match(name) is { Success: true } s ? s : NxMM.Match(name);
            if (!match.Success || marks != 1)
            {
                notes.Add(marks > 1 || match.Success ? $"double episode {name}" : $"no SxxEyy in {name}");
                continue;
            }
            var fileSeason = Number(match.Groups[1].Value);
            var episode = Number(match.Groups[2].Value);
            if (fileSeason != season) return Reject("multi_season", notes);
            if (episode < 1) continue;
            if (!found.TryGetValue(episode, out var list)) found[episode] = list = [];
            list.Add(file.Index);
        }
        var episodes = new Dictionary<int, int>();
        foreach (var (episode, indexes) in found.OrderBy(x => x.Key))
        {
            if (indexes.Count != 1) { notes.Add($"episode {episode} has {indexes.Count} videos"); continue; }
            if (missing.Contains(episode)) episodes[episode] = indexes[0];
        }
        return new(episodes, episodes.Count == 0 ? "no_episodes" : null, notes);
    }

    /// <summary>Bytes of every piece a selection touches: what a selective download really writes (boundary pieces included).</summary>
    public static long PieceSpanBytes(IReadOnlyList<PackFile> files, long pieceLength, IEnumerable<int> selected)
    {
        if (pieceLength <= 0) return files.Where(f => selected.Contains(f.Index)).Sum(f => f.Length);
        var total = files.Count == 0 ? 0 : files.Max(f => f.Offset + f.Length);
        var pieces = new HashSet<long>();
        foreach (var file in files.Where(f => selected.Contains(f.Index) && f.Length > 0))
            for (var p = file.Offset / pieceLength; p <= (file.Offset + file.Length - 1) / pieceLength; p++) pieces.Add(p);
        return pieces.Sum(p => Math.Min(pieceLength, total - p * pieceLength));
    }

    private static PackFileMapping Reject(string reason, List<string> notes) => new(new Dictionary<int, int>(), reason, notes);
}
