using System.Collections.Immutable;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

internal static class LibraryLayout
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMilliseconds(100);
    private static bool Match(string value, string pattern) => Regex.IsMatch(value, pattern,
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, Timeout);
    private static bool Protected(string value) => Match(value,
        @"^(BDMV|VIDEO_TS|AUDIO_TS|CERTIFICATE|PRIVATE|AVCHD|BDROM|STREAM|PLAYLIST|CLIPINF|PS3_GAME|PS3_UPDATE|USRDIR|SYSTEM\.BIN)$");
    private static bool Structural(string value) => Match(value,
        @"^(season[\s._-]*\d{1,3}|s\d{1,3}|series[\s._-]*\d{1,3}|specials?|extras?|featurettes?|bonus|subs?|subtitles?|sample|disc[\s._-]*\d+|cd[\s._-]*\d+|dvd[\s._-]*\d+|dis[ck][\s._-]*\d+|vol(?:ume)?[\s._-]*\d+|part[\s._-]*\d+)$");

    private static string FolderKey(string value)
    {
        var flat = Regex.Replace(value.ToLowerInvariant(), @"[._]+", " ", RegexOptions.None, Timeout);
        flat = Regex.Replace(flat, @"^s(?=\d{1,3}\b)", "season ", RegexOptions.None, Timeout);
        flat = Regex.Replace(flat, @"\s+", " ", RegexOptions.None, Timeout);
        return Regex.Replace(flat, @"^(season|series|disc|disk|cd|dvd|vol|volume|part)\s+0*(\d+)",
            "$1 $2", RegexOptions.None, Timeout).Trim();
    }

    private static HashSet<string> Tokens(string name)
    {
        var flat = Regex.Replace(name.ToLowerInvariant(), @"\bseason\s*(\d{1,3})\b", "s$1", RegexOptions.None, Timeout);
        flat = Regex.Replace(flat, @"\b([se])0*(\d{1,3})\b", "$1$2", RegexOptions.None, Timeout);
        return Regex.Split(flat, @"[^a-z0-9]+", RegexOptions.None, Timeout).Where(t => t.Length > 0).ToHashSet();
    }

    private static bool SameRelease(string a, string b, HashSet<string> destination)
    {
        var left = Tokens(a);
        var right = Tokens(b);
        bool Allowed(string token) => Match(token, @"^s\d{1,3}$") &&
            destination.Contains("season " + int.Parse(token[1..], System.Globalization.CultureInfo.InvariantCulture));
        const string technical = @"^(\d{3,4}p|4k|uhd|hdr|hdr10|sdr|x26[45]|h26[45]|hevc|avc|xvid|divx|web|webrip|webdl|bdrip|brrip|bluray|blu|ray|dvdrip|hdtv|remux|aac|ac3|eac3|dts|dd|ddp|flac|mp3|opus|atmos|truehd|\d+bit|bits|\d+|dual|multi|audio|subs?|repack|proper|internal|complete|completo|batch|pack|extended|final)$";
        return left.Any(t => right.Contains(t) && !Match(t, technical)) &&
            left.All(t => right.Contains(t) || Allowed(t)) && right.All(t => left.Contains(t) || Allowed(t));
    }

    private static string? EpisodeKey(string value)
    {
        var keys = Regex.Matches(value, @"(?:^|[^a-z0-9])s(\d{1,3})[\s._-]*e(\d{1,4})(?![0-9])",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, Timeout)
            .Concat(Regex.Matches(value, @"(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9])",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, Timeout))
            .Select(m => $"{int.Parse(m.Groups[1].Value)}:{int.Parse(m.Groups[2].Value)}").Distinct().ToArray();
        return keys.Length == 1 ? keys[0] : null;
    }

    internal static ImmutableDictionary<int, string> Names(ImmutableArray<TorrentFile> files,
        ImmutableArray<SelectedFile> selected, string destination)
    {
        var paths = files.ToDictionary(f => f.Index, f => f.RelativePath.Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries).ToList());
        if (paths.Values.Any(s => s.Count == 0 || s.Any(v => v is "." or "..")) ||
            files.Any(f => Path.IsPathRooted(f.RelativePath)))
            throw new ArgumentException("Torrent paths must be relative and cannot contain parent-directory segments.");
        var keys = destination.Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries).TakeLast(3).Select(FolderKey).ToHashSet();
        var removed = new List<string>();
        for (var depth = 0; depth < 8 && paths.Values.All(s => s.Count > 1); depth++)
        {
            var root = paths.First().Value[0];
            if (!paths.Values.All(s => s[0] == root) || Protected(root)) break;
            var repeats = keys.Contains(FolderKey(root));
            if (Structural(root) ? !repeats : depth > 0 && !repeats && !removed.Any(p => SameRelease(p, root, keys))) break;
            removed.Add(root);
            foreach (var parts in paths.Values) parts.RemoveAt(0);
        }
        var videoIndices = selected.Where(s => s.Role == FileRole.Video).Select(s => s.FileIndex).ToArray();
        var episodeFolders = new HashSet<string>(StringComparer.Ordinal);
        foreach (var index in videoIndices)
        {
            var parts = paths[index];
            if (parts.Count < 2 || Structural(parts[^2]) || parts.Take(parts.Count - 1).Any(Protected)) continue;
            var key = EpisodeKey(Path.GetFileNameWithoutExtension(parts[^1]));
            if (key is not null && key == EpisodeKey(parts[^2]))
                episodeFolders.Add(string.Join('\\', parts.Take(parts.Count - 1)));
        }
        foreach (var index in paths.Keys.ToArray())
        {
            var parts = paths[index];
            paths[index] = parts.Where((_, i) => i == parts.Count - 1 ||
                !episodeFolders.Contains(string.Join('\\', parts.Take(i + 1)))).ToList();
        }
        // A multi-season torrent has no single common season wrapper after the outer container was removed.
        // Drop only a selected item's leading season folder when the final destination already names it.
        foreach (var selection in selected)
        {
            var parts = paths[selection.FileIndex];
            while (parts.Count > 1 && !Protected(parts[0]) && Structural(parts[0]) && keys.Contains(FolderKey(parts[0])))
                parts.RemoveAt(0);
        }
        var output = selected.ToDictionary(s => s.FileIndex,
            s => string.Join(Path.DirectorySeparatorChar, paths[s.FileIndex].Select(LibraryPaths.SafeLeaf)));
        foreach (var sidecar in selected.Where(s => s.Role is FileRole.Subtitle or FileRole.Audio))
        {
            var leaf = paths[sidecar.FileIndex][^1];
            var sideStem = Path.GetFileNameWithoutExtension(leaf);
            var named = videoIndices.Where(v =>
            {
                var stem = Path.GetFileNameWithoutExtension(paths[v][^1]);
                return sideStem.Equals(stem, StringComparison.OrdinalIgnoreCase) ||
                    sideStem.StartsWith(stem + ".", StringComparison.OrdinalIgnoreCase) ||
                    EpisodeKey(sideStem) is { } episode && episode == EpisodeKey(stem);
            }).ToArray();
            var video = named.Length == 1 ? named[0] : videoIndices.Length == 1 ? videoIndices[0] : -1;
            if (video < 0) throw new ArgumentException("A selected sidecar does not identify one video.");
            var stem = Path.GetFileNameWithoutExtension(paths[video][^1]);
            // The old layout preserves a matching basename, else prefixes the video stem to the sidecar name.
            var suffix = sideStem.StartsWith(stem + ".", StringComparison.OrdinalIgnoreCase) ? sideStem[stem.Length..] :
                sideStem.Equals(stem, StringComparison.OrdinalIgnoreCase) ? "" : "." + sideStem;
            if (EpisodeKey(sideStem) is { } key && key == EpisodeKey(stem) &&
                !sideStem.StartsWith(stem + ".", StringComparison.OrdinalIgnoreCase))
            {
                var language = Regex.Match(sideStem,
                    @"(?:^|[._ -])([a-z]{2,3}(?:[._ -](?:forced|sdh|cc|default))*)$",
                    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, Timeout);
                if (language.Success) suffix = "." + language.Groups[1].Value;
            }
            var name = LibraryPaths.SafeLeaf(stem + suffix + Path.GetExtension(leaf));
            output[sidecar.FileIndex] = Path.Combine(Path.GetDirectoryName(output[video]) ?? "", name);
        }
        return output.ToImmutableDictionary();
    }
}
