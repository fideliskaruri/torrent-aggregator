using System.Globalization;
using System.Text.RegularExpressions;

namespace TorrentFlow.Engine.Layout;

/// <summary>
/// Port of content-layout-policy.ts: the one place that decides what a folder <em>means</em>. The planner and every
/// caller take their rules from here, so a torrent can never be laid out by two disagreeing sets of rules.
/// Regexes run in ECMAScript mode so <c>\d</c>, <c>\w</c> and <c>\b</c> match exactly what the TypeScript matched.
/// </summary>
internal static class ContentLayoutPolicy
{
    private const RegexOptions Js = RegexOptions.ECMAScript | RegexOptions.Compiled;
    private const RegexOptions JsI = Js | RegexOptions.IgnoreCase;

    /// <summary>Structures a player, reader or console looks up by name. Never dropped, at any depth.</summary>
    private static readonly Regex ProtectedFolder = new(
        @"^(?:BDMV|VIDEO_TS|AUDIO_TS|CERTIFICATE|PRIVATE|AVCHD|BDROM|STREAM|PLAYLIST|CLIPINF|PS3_GAME|PS3_UPDATE|USRDIR|SYSTEM\.BIN)$", JsI);

    /// <summary>
    /// Folders that organise content rather than wrap it: <c>Disc 2</c> and <c>Season 02</c> are the only thing keeping
    /// two sets of identically named files apart. Still dropped when the destination already says the same thing.
    /// </summary>
    private static readonly Regex StructuralFolder = new(
        @"^(?:season[\s._-]*\d{1,3}|s\d{1,3}|series[\s._-]*\d{1,3}|specials?|extras?|featurettes?|bonus|subs?|subtitles?|sample|disc[\s._-]*\d+|cd[\s._-]*\d+|dvd[\s._-]*\d+|dis[ck][\s._-]*\d+|vol(?:ume)?[\s._-]*\d+|part[\s._-]*\d+)$", JsI);

    private static readonly Regex SeasonMarker = new(@"^s(\d{1,3})$", Js);

    /// <summary>Tokens that describe the encode rather than the work; <c>1080p x265</c> is not a title.</summary>
    private static readonly Regex TechnicalToken = new(
        @"^(?:\d{3,4}p|4k|uhd|hdr|hdr10|sdr|x26[45]|h26[45]|hevc|avc|xvid|divx|web|webrip|webdl|bdrip|brrip|bluray|blu|ray|dvdrip|hdtv|remux|aac|ac3|eac3|dts|dd|ddp|flac|mp3|opus|atmos|truehd|\d+bit|bits|\d+|dual|multi|audio|subs?|repack|proper|internal|complete|completo|batch|pack|extended|final)$", Js);

    /// <summary>Reserved characters a torrent store strips from every basename it writes.</summary>
    private static readonly Regex ReservedFilename = new("[<>:\"/\\\\|?*\\u0000-\\u001F]", Js);

    private static readonly Regex Separators = new(@"[\\/]+", Js);
    private static readonly Regex DotsUnderscores = new(@"[._]+", Js);
    private static readonly Regex LeadingSeasonS = new(@"^s(?=\d{1,3}\b)", Js);
    private static readonly Regex Whitespace = new(@"\s+", Js);
    private static readonly Regex NumberedFolder = new(@"^(season|series|disc|disk|cd|dvd|vol|volume|part)\s+0*(\d+)", Js);
    private static readonly Regex SeasonWord = new(@"\bseason\s*(\d{1,3})\b", Js);
    private static readonly Regex SeasonToken = new(@"\bs(\d{1,3})\b", Js);
    private static readonly Regex EpisodeToken = new(@"\be(\d{1,3})\b", Js);
    private static readonly Regex NonAlnum = new(@"[^a-z0-9]+", Js);
    private static readonly Regex SeasonSegment = new(@"^(?:season|series|s)[\s._-]*\d{1,3}$", JsI);
    private static readonly Regex SeasonMention = new(@"(?:^|[^a-z0-9])s(?:eason)?[\s._-]*(\d{1,3})(?![0-9])", JsI);
    private static readonly Regex TrailingDotsSpaces = new(@"[. ]+$", Js);

    private static readonly Regex EpisodeMarker = new(@"(?:^|[^a-z0-9])s(\d{1,3})[\s._-]*e(\d{1,4})(?![0-9])", JsI);
    private static readonly Regex CrossEpisodeMarker = new(@"(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9])", JsI);
    private static readonly Regex SampleName = new(@"(?:^|[^a-z0-9])sample(?:[^a-z0-9]|$)", JsI);
    private static readonly Regex ExtrasFolder = new(
        @"^(?:samples?|extras?|featurettes?|bonus|trailers?|behind[\s._-]*the[\s._-]*scenes|deleted[\s._-]*scenes|interviews?)$", JsI);
    private static readonly Regex SubsFolder = new(@"^(?:subs?|subtitles?)$", JsI);

    private static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".ts", ".m2ts", ".mts", ".webm", ".mpg", ".mpeg", ".flv", ".ogv", ".divx", ".rmvb",
    };

    private static readonly HashSet<string> SubtitleExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt", ".sup", ".smi",
    };

    private static string Num(string digits) => int.Parse(digits, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// The single episode a name identifies (<c>S01E03</c> or <c>1x03</c>), as <c>s1e3</c>. Null when it names none or
    /// more than one: a folder is only an episode's own folder when there is no doubt which episode.
    /// </summary>
    public static string? EpisodeKey(string name)
    {
        var keys = EpisodeMarker.Matches(name).Concat(CrossEpisodeMarker.Matches(name))
            .Select(m => $"s{Num(m.Groups[1].Value)}e{Num(m.Groups[2].Value)}").ToHashSet(StringComparer.Ordinal);
        return keys.Count == 1 ? keys.First() : null;
    }

    public static bool IsSubsFolder(string name) => SubsFolder.IsMatch(name);

    public static bool IsSeasonFolder(string name) => SeasonSegment.IsMatch(name);

    /// <summary>
    /// What a file is for the layout. A video is the content itself; a sample, or anything under an extras folder, is not,
    /// whatever its extension — it may be moved aside, never given the episode's place.
    /// </summary>
    public static LayoutRole Role(IReadOnlyList<string> segments)
    {
        var name = segments[^1];
        var ext = Path.GetExtension(name);
        if (SubtitleExtensions.Contains(ext)) return LayoutRole.Subtitle;
        if (!VideoExtensions.Contains(ext)) return LayoutRole.Extra;
        if (SampleName.IsMatch(Path.GetFileNameWithoutExtension(name))) return LayoutRole.Extra;
        for (var i = 0; i < segments.Count - 1; i++)
            if (ExtrasFolder.IsMatch(segments[i])) return LayoutRole.Extra;
        return LayoutRole.Video;
    }

    public static bool IsProtected(string name) => ProtectedFolder.IsMatch(name);

    public static bool IsStructural(string name) => StructuralFolder.IsMatch(name);

    /// <summary>Splits a torrent path on either separator, dropping empty segments.</summary>
    public static List<string> Segments(string? p) =>
        Separators.Split(p ?? "").Select(s => s.Trim()).Where(s => s.Length > 0).ToList();

    /// <summary>
    /// Compares folder names the way a person would: <c>Season 1</c>, <c>Season 01</c> and <c>S01</c> are one folder.
    /// Leading zeros are only stripped off a season or episode marker — <c>007</c> and <c>7</c> are different films.
    /// </summary>
    public static string FolderKey(string name)
    {
        var s = name.ToLowerInvariant();
        s = DotsUnderscores.Replace(s, " ");
        s = LeadingSeasonS.Replace(s, "season ", 1);
        s = Whitespace.Replace(s, " ");
        s = NumberedFolder.Replace(s, "$1 $2", 1);
        return s.Trim();
    }

    private static HashSet<string> ReleaseTokens(string name)
    {
        var flat = name.ToLowerInvariant();
        flat = SeasonWord.Replace(flat, "s$1");
        flat = SeasonToken.Replace(flat, m => "s" + Num(m.Groups[1].Value));
        flat = EpisodeToken.Replace(flat, m => "e" + Num(m.Groups[1].Value));
        return NonAlnum.Split(flat).Where(t => t.Length > 0).ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>
    /// True when two folder names are the same release wrapped twice. Deliberately exact, not a similarity score: the
    /// names must agree on every token, except that a season marker may differ when the destination already names that
    /// season, and they must share at least one token that is not encode jargon. A false negative leaves a folder
    /// nested; a false positive merges two releases, so the asymmetry is intentional.
    /// </summary>
    public static bool IsSameRelease(string a, string b, IReadOnlySet<string>? destKeys = null)
    {
        var ta = ReleaseTokens(a);
        var tb = ReleaseTokens(b);
        if (ta.Count == 0 || tb.Count == 0) return false;

        var sharedMeaningful = ta.Count(t => tb.Contains(t) && !TechnicalToken.IsMatch(t));
        if (sharedMeaningful == 0) return false;

        bool Allowed(string t)
        {
            var season = SeasonMarker.Match(t);
            if (!season.Success) return false;
            // Only droppable if the destination already says which season this is.
            return destKeys?.Contains("season " + Num(season.Groups[1].Value)) ?? false;
        }

        foreach (var t in ta) if (!tb.Contains(t) && !Allowed(t)) return false;
        foreach (var t in tb) if (!ta.Contains(t) && !Allowed(t)) return false;
        return true;
    }

    /// <summary>
    /// The destination components a container folder may repeat. Only the tail: a folder named <c>Downloads</c> says
    /// nothing about the torrent just because the library lives under a folder of that name.
    /// </summary>
    public static HashSet<string> DestinationKeys(string? destPath) =>
        Segments(destPath).TakeLast(3).Select(FolderKey).ToHashSet(StringComparer.Ordinal);

    /// <summary>Decides whether one container level may be dropped. This function <em>is</em> the layout agreement.</summary>
    /// <param name="name">the folder in question</param>
    /// <param name="depth">0 for the torrent's own container root</param>
    /// <param name="destKeys">from <see cref="DestinationKeys"/></param>
    /// <param name="ancestors">folders already dropped, outermost first</param>
    public static bool MayDropFolder(string name, int depth, IReadOnlySet<string> destKeys, IReadOnlyList<string> ancestors)
    {
        if (ProtectedFolder.IsMatch(name)) return false;

        var repeatsDestination = destKeys.Contains(FolderKey(name));

        // A structural folder is the only thing separating two discs or two seasons.
        if (StructuralFolder.IsMatch(name)) return repeatsDestination;

        // Depth 0 is the torrent's container root, redundant by construction — qBittorrent's
        // contentLayout=NoSubfolder, so a download moved between the two clients still finds its files.
        if (depth == 0) return true;

        // Deeper down, absence of meaning is not evidence. Require proof.
        return repeatsDestination || ancestors.Any(prior => IsSameRelease(prior, name, destKeys));
    }

    /// <summary>True when the destination path itself already names one season.</summary>
    public static bool DestinationNamesSeason(string? destPath)
    {
        var segs = Segments(destPath);
        return segs.Count > 0 && SeasonSegment.IsMatch(segs[^1]);
    }

    /// <summary>
    /// Renames a release folder that names exactly one season into <c>Season NN</c>. Never a protected or structural
    /// folder, the name must carry an encode token (so a title containing <c>S2</c> is not mistaken for one), and it
    /// must resolve to exactly one season number. Null leaves the folder untouched, which is always the safe answer.
    /// </summary>
    public static string? SeasonFolderRename(string name)
    {
        if (ProtectedFolder.IsMatch(name)) return null;
        if (StructuralFolder.IsMatch(name)) return null;

        var seasons = SeasonMention.Matches(name)
            .Select(m => int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture)).ToHashSet();
        if (seasons.Count != 1) return null;

        var tokens = NonAlnum.Split(name.ToLowerInvariant()).Where(t => t.Length > 0);
        if (!tokens.Any(t => TechnicalToken.IsMatch(t))) return null;

        return "Season " + seasons.First().ToString("00", CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// The key two paths collide on <em>as files on disk</em>. Reserved characters are stripped from the basename (the
    /// store does it on every platform), and Windows also folds case and ignores trailing dots and spaces.
    /// </summary>
    public static string PhysicalKey(string relativePath, bool? windows = null)
    {
        var win = windows ?? OperatingSystem.IsWindows();
        var parts = Segments(relativePath);
        var cleaned = parts.Select((seg, i) =>
        {
            var s = seg;
            // Only the basename is sanitised by the store; Windows still folds directories' case and trailing punctuation.
            if (i == parts.Count - 1) s = ReservedFilename.Replace(s, "");
            if (win) s = TrailingDotsSpaces.Replace(s, "");
            return s;
        });
        var joined = string.Join('/', cleaned);
        return win ? joined.ToLowerInvariant() : joined;
    }

    /// <summary>
    /// True when <paramref name="child"/> is at or below <paramref name="root"/>, resolving <c>..</c> first. Compares
    /// segments, not a string prefix: a folder called <c>..stfolder</c> starts with <c>..</c> without escaping anything.
    /// </summary>
    public static bool IsInside(string root, string child)
    {
        var rel = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(child));
        if (rel == ".") return true;
        if (Path.IsPathRooted(rel)) return false;
        return rel != ".." && !rel.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal);
    }
}
