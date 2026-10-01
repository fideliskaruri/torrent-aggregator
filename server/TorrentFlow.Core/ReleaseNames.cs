using System.Globalization;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Text;

namespace TorrentFlow.Core;

/// <summary>A release's work identity: the key, name and (films only) year that group it.</summary>
public sealed record ReleaseIdentity(string Key, string Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] int? Year, bool IsSeries)
{
    /// <summary>The same identity under another display name (a catalog title that agrees), keyed by that name.</summary>
    public ReleaseIdentity Renamed(string name) => this with { Name = name, Key = ReleaseNames.IdentityKey(name, Year, IsSeries) };
}

/// <summary>
/// The one owner of the release-name rules (ports of the TS parsers): <c>releaseYear</c> (quality.ts),
/// <c>cleanTitle</c>/<c>showFolder</c> (smart-category.ts), <c>cleanDisplayTitle</c> (availability.ts) and
/// <c>workIdentity</c>/<c>workIdentityFor</c> (work-identity.ts). Episode and pack parsing live in
/// <see cref="ReleaseEpisodeParser"/>; work-key slugs in <see cref="WorkKeySlug"/>.
/// </summary>
public static class ReleaseNames
{
    private const RegexOptions Options = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(1);
    private static Regex Rx(string pattern, RegexOptions options = Options) => new(pattern, options, Timeout);
    private static string Strip(string value, Regex regex, string replacement = " ") => regex.Replace(value, replacement);

    // ── cleanDisplayTitle ────────────────────────────────────────────────────
    private static readonly Regex ReleaseTokens = Rx(@"\b(\d{3,4}p|4k|uhd|hdr(?:10)?\+?|dolby ?vision|x26[45]|h\.?26[45]|hevc|avc|aac(?:5\.1|2\.0)?|ac-?3|e-?ac-?3|ddp?5\.1|dts(?:-hd)?|flac|opus|web-?dl|web-?rip|b[dr]rip|blu-?ray|hdtv|dvdrip|remux|repack|proper|multi|dual ?audio|subbed|dubbed|10 ?bits?|8 ?bits?|amzn|dsnp|hmax|atvp|hulu|pcok|stan|crav|telesync|telecine|hdcam|hdts|screener|dvdscr|workprint|mp4|mkv|avi|m4v|xvid|divx)\b");
    private static readonly Regex FileExtension = Rx(@"\.(mkv|mp4|avi|m4v|mov|webm|ts|m2ts|mpe?g|iso)$");
    private static readonly Regex SitePrefixDisplay = Rx(@"^\s*(?:\[[^\]]*\]|\([^)]*\)|www\.[^\s]+\s*-)\s*");
    private static readonly Regex BracketGroup = Rx(@"\[[^\]]*\]");
    private static readonly Regex ParenNoise = Rx(@"\((?![^)]*\b(?:19|20)\d{2}\b)[^)]*\)");
    private static readonly Regex TrailingGroup = Rx(@"\s-[A-Za-z0-9]+$", RegexOptions.CultureInvariant);
    private static readonly Regex SizeToken = Rx(@"\b\d+(?:[.,]\d+)?\s?[KMGT]i?B\b");
    private static readonly Regex TrailingShoutedGroup = Rx(@"\s+-\s*[A-Z][A-Z0-9]{1,19}$", RegexOptions.CultureInvariant);
    private static readonly Regex DoubledSeparator = Rx(@"\s+-(?:\s*-)+\s*");
    private static readonly Regex Whitespace = Rx(@"\s+");
    private static readonly Regex DotsUnderscores = Rx(@"[._]+");
    private static readonly Regex TrailingDash = Rx(@"\s+-\s*$");
    private static readonly Regex LeadingDebris = Rx(@"^[\s._-]+");
    private static readonly Regex TrailingDebris = Rx(@"[\s._-]+$");

    /// <summary>A human-readable title for any release-shaped string; the original when cleaning leaves nothing.</summary>
    public static string CleanDisplayTitle(string raw)
    {
        var original = (raw ?? "").Trim();
        if (original.Length == 0) return original;
        var output = original;
        for (var i = 0; i < 3; i++)
        {
            var next = SitePrefixDisplay.Replace(output, "", 1);
            if (next == output || next.Trim().Length == 0) break;
            output = next;
        }
        output = FileExtension.Replace(output, "");
        // Decide the shape from the given name: one with no spaces is dot/underscore separated.
        var dotSeparated = !output.Any(char.IsWhiteSpace);
        var beforeTokens = output;
        output = Strip(output, ReleaseTokens);
        output = Strip(output, SizeToken);
        if (dotSeparated) output = Strip(output, DotsUnderscores);
        output = Strip(Strip(output, BracketGroup), ParenNoise);
        output = Strip(output, ReleaseTokens);
        var afterTokens = output;
        output = Strip(output, SizeToken);
        var strippedNoise = afterTokens != beforeTokens || output != afterTokens;
        output = Strip(output, Whitespace).Trim();
        output = TrailingDash.Replace(DoubledSeparator.Replace(output, " - "), "");
        if (dotSeparated) output = TrailingGroup.Replace(output, "");
        if (strippedNoise) output = TrailingShoutedGroup.Replace(TrailingShoutedGroup.Replace(output, ""), "");
        output = TrailingDebris.Replace(LeadingDebris.Replace(Strip(output, Whitespace), ""), "").Trim();
        return output.Length > 0 ? output : original;
    }

    // ── workIdentity ─────────────────────────────────────────────────────────
    private const string Host = @"(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:com|org|net|info|to|me|tv|cc|io|is|se|su|ru|mx|xyz|site|online|club)(?::\d{2,5})?";
    private static readonly Regex TrackerPrefixPattern = Rx($@"^\s*[\[(]\s*{Host}\s*[\])](?:\s*[-–—:|]+\s*)?|^\s*{Host}\s*[-–—:|]+\s*");
    private const string SitePrefix = @"(?:^|[\s|])(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:org|com|net|info|to|me|tv|cc|io|co|ru|in|us|uk|eu|xyz|site|online)\b\s*[-–—:|]*\s*";
    private static readonly Regex SitePrefixPattern = Rx(SitePrefix);
    private static readonly Regex Structure = Rx(@"\bS\d{1,3}\s*E\d{1,4}\b|\b\d{1,2}x\d{1,4}\b|\bSeasons?\s*\d{1,3}\b|\bS\d{1,3}\b|\b(?:episode|ep)\s*\.?\s*\d{1,4}\b|(?<![A-Za-z])\bE\d{1,4}\b|[-–—]\s*\d{1,4}(?=\s|[\[(]|$)");
    private static readonly Regex Amp = Rx("&amp;");
    private static readonly Regex Entity = Rx("&[a-z]+;");
    private static readonly Regex InlineSite = Rx(@"(?:^|\s)(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:org|com|net|info|to|me|tv|cc|io)\b(?:\s*[-–—:|]+\s*|\s+)");
    private static readonly Regex ShortBrackets = Rx(@"[\[(][^\])]{0,48}[\])]");
    private static readonly Regex EpisodeMarkers = Rx(@"\bS\d{1,3}\s*E\d{1,4}\b|\b\d{1,2}x\d{1,4}\b|\bS\d{1,3}\b|\b(?:season|episode|ep|e)\s*\.?\s*\d{1,4}\b|[-–—]\s*\d{1,4}(?=\s|$)");
    private static readonly Regex PackWords = Rx(@"\b(complete(?:\s*(?:series|season|collection))?|season\s*pack|batch|uncensored)\b|\b(19|20)\d{2}\b");
    private static readonly Regex QualityTokens = Rx(@"\b(1080p|720p|480p|2160p|4k|uhd|hdr10?|dv|dolby\s*vision|hevc|x265|h\s*\.?\s*265|x264|h\s*\.?\s*264|av1|10-?bits?|8-?bits?|web-?dl|webrip|bluray|bdrip|bdr|brrip|hdtv|hdcam|remux|proper|repack|internal|limited|extended|theatrical|imax|aac(?:\s*[25]\.?\d)?|ac3|eac3|ddp?\.?(?:\s*[25]\.?\d)?|dts(?:-?hd)?|truehd|atmos|flac|mp3|opus|vorbis|dual(?:\s*audio)?|multi(?:\s*sub|audio)?|subs?|dub(?:bed)?|softsubs?|hardsubs?|nf|amzn|dsnp|hulu|atvp|pmtp|tver|cr|mkv|mp4|avi|ts|m2ts|webm|ch)\b");
    private static readonly Regex AudioNumbers = Rx(@"\b(?:dd|ddp|aac|dts)\s*\d(?:\s*\d)?\b|\b\d+\s+\d+\b|\b\d+(?:\.\d+)?\s*(?:ch|kbps|mbps|fps|bits?)\b");
    private static readonly Regex KnownGroups = Rx(@"\s+(?:playWEB|ELiTE|PSA|Rapta|NTb|FLUX|KITSUNe|STC|BONE|RARBG|YTS|YIFY|SPARKS|FGT|DIMENSION|KILLERS|COAST|METCON|THRONE|EVO|ION10|XEBEC|ION265|TGx|EtHD|CtrlHD)(?:\s|$)");
    private static readonly Regex TrailingWord = Rx(@"\s+[A-Za-z][A-Za-z0-9]{1,12}$", RegexOptions.CultureInvariant);
    private static readonly Regex ShoutedWord = Rx("^[A-Z]{2,12}$|^[A-Z]{2,}[a-z]+[A-Z]", RegexOptions.CultureInvariant);
    private static readonly Regex CodecWord = Rx("^(?:x265|x264|h264|h265|web|dl|rip)$");
    private static readonly Regex Separators = Rx(@"[.\-–—|+]+");
    private static readonly Regex UpperLetter = Rx("[A-Z]", RegexOptions.CultureInvariant);
    private static readonly Regex TrailingNumber = Rx(@"\s+\d{1,4}$");
    private static readonly Regex FolderWords = Rx(@"\b(complete|batch|pack|extras?|uncensored)\b");
    private static readonly Regex UnsafePathChars = Rx(@"[<>:""/\\|?*\x00-\x1f]");
    private static readonly Regex WwwStart = Rx(@"^www\.");
    private static readonly Regex DomainStart = Rx(@"^[a-z0-9-]+\.(org|com|net|info|io|to|me|cc|tv)\b");
    private static readonly Regex DomainPrefix = Rx(@"^[a-z0-9-]+\.(org|com|net)\s*[-–—:]?\s*");
    private static readonly Regex YearNoise = Rx(@"\b(?:\d{3,4}p|x?26[45]|h\.?26[45]|10bit|8bit|5\.1|7\.1|2\.0|ddp?5|dts|aac2|mp3|hdr10\+?|\d+(?:\.\d+)?\s*(?:gb|mb|gib|mib))\b");
    private static readonly Regex YearToken = Rx(@"(?<![\d.])(?:19|20)\d{2}(?![\d.])");
    private static readonly Regex FilmQuality = Rx(@"\b(?:\d{3,4}p|4k|uhd|web-?dl|web-?rip|web|blu-?ray|bd-?rip|bd-?remux|remux|hdtv|dvd-?rip|hd-?rip|cam|ts|x26[45]|h\.?26[45]|hevc|avc|xvid|divx|hdr10\+?|hdr|dv|sdr|10bit|8bit|aac|ac3|eac3|ddp?5|dts(?:-hd)?|truehd|atmos|flac|mp3|imax|proper|repack|extended|unrated|remastered|directors?\.?cut)\b");
    private static readonly Regex FilmAudio = Rx(@"\b(?:dual[\s.-]?audio|multi[\s.-]?audio|dual|multi|e-?subs?|m-?subs?|hard-?subs?|soft-?subs?|dubbed|subbed|hindi|tamil|telugu|kannada|malayalam)\b");
    private static readonly Regex FilmTrailingGroup = Rx(@"[-–—_]+[a-z0-9]{2,20}$");
    private static readonly Regex OpenBracketTail = Rx(@"\s*[\[({]\s*$");
    private static readonly Regex FilmTailDebris = Rx(@"[\s\-–—_:|.]+$");
    private static readonly Regex Apostrophe = Rx("['’`]", RegexOptions.CultureInvariant);
    private static readonly Regex NonAlphanumeric = Rx(@"[^\p{L}\p{N}]+", RegexOptions.CultureInvariant);
    private static readonly Regex JunkNumberTail = Rx(@"[\])]\s*\d{1,4}\s*$");

    private static string TrackerPrefix(string title)
    {
        var result = title.Trim();
        for (var i = 0; i < 3; i++)
        {
            var next = TrackerPrefixPattern.Replace(result, "").Trim();
            if (next == result || next.Length == 0) break;
            result = next;
        }
        return result;
    }

    /// <summary>quality.ts releaseYear: the last plausible 19xx/20xx token once codec, audio and size noise is gone.</summary>
    public static int? ReleaseYear(string title)
    {
        var t = Strip(Strip(title, DotsUnderscores), YearNoise);
        var max = DateTime.UtcNow.Year + 2;
        return YearToken.Matches(t).Select(m => int.Parse(m.Value, CultureInfo.InvariantCulture))
            .Where(y => y >= 1900 && y <= max).Select(y => (int?)y).LastOrDefault();
    }

    /// <summary>The release name before its first season/episode marker.</summary>
    public static string CutAtStructure(string title)
    {
        var m = Structure.Match(title);
        return m.Success && m.Index > 0 ? title[..m.Index] : title;
    }

    /// <summary>smart-category.ts cleanTitle: the show name with site, episode, pack, quality and group noise removed.</summary>
    public static string CleanTitle(string title)
    {
        var t = Strip(Strip(title, Amp, "and"), Entity);
        t = Strip(t, SitePrefixPattern);
        t = Strip(t, InlineSite);
        t = Strip(t, DotsUnderscores);
        t = CutAtStructure(Strip(t, ShortBrackets));
        t = Strip(t, EpisodeMarkers);
        t = Strip(t, PackWords);
        t = Strip(t, QualityTokens);
        t = Strip(t, AudioNumbers);
        t = Strip(t, KnownGroups);
        t = TrailingWord.Replace(t, m => ShoutedWord.IsMatch(m.Value.Trim()) || CodecWord.IsMatch(m.Value.Trim()) ? " " : m.Value);
        t = Strip(Strip(t, Separators), Whitespace).Trim();
        if (t.Length > 0 && t == t.ToUpperInvariant() && UpperLetter.IsMatch(t))
            t = CultureInfo.InvariantCulture.TextInfo.ToTitleCase(t.ToLowerInvariant());
        return t;
    }

    /// <summary>A folder-safe name: no path characters, no bare site names, at most 120 characters.</summary>
    public static string SanitizeFolderName(string title)
    {
        var t = Strip(UnsafePathChars.Replace(title, ""), Whitespace).Trim().TrimEnd('.', ' ');
        if (WwwStart.IsMatch(t) || DomainStart.IsMatch(t) && !t.Any(char.IsWhiteSpace)) return "";
        t = DomainPrefix.Replace(t, "").Trim();
        return t[..Math.Min(120, t.Length)];
    }

    /// <summary>
    /// smart-category.ts showFolder without metadata. With <paramref name="keepPartNumber"/> a trailing "Part N"/"Cour N"
    /// keeps its number. Grab matching (<see cref="IdentityFor"/>) keeps it; catalog and browse identity keys drop it,
    /// because stored catalog keys were minted that way. Unifying the two needs a key migration.
    /// </summary>
    public static string ShowFolder(string title, bool keepPartNumber = false)
    {
        var clean = CleanTitle(title);
        var namedPart = keepPartNumber && Regex.IsMatch(clean, @"\b(?:Part|Cour)\s+\d{1,3}$", Options, Timeout);
        if (!namedPart)
        {
            if (ReleaseEpisodeParser.Parse(title).Episode is { } number)
                clean = Regex.Replace(clean, $@"\b0*{number}\b", " ", Options, Timeout);
            clean = TrailingNumber.Replace(clean, " ");
        }
        clean = Strip(Strip(clean, FolderWords), Whitespace).Trim();
        return SanitizeFolderName(clean);
    }

    public static string StripTrailingJunkNumber(string rawTitle, string cleaned)
    {
        if (!JunkNumberTail.IsMatch(rawTitle)) return cleaned;
        var result = TrailingNumber.Replace(cleaned, "").Trim();
        return result.Length > 0 ? result : cleaned;
    }

    private static string FilmName(string title, int? year)
    {
        var t = Strip(Strip(Strip(title, DotsUnderscores), ShortBrackets), Whitespace).Trim();
        List<int> cuts = [];
        if (year != null && Regex.Match(t, $@"(?<![\d.]){year}(?![\d.])", Options, Timeout) is { Success: true, Index: > 0 } y) cuts.Add(y.Index);
        var quality = FilmQuality.Match(t);
        var audio = FilmAudio.Match(t);
        if (quality.Success && quality.Index > 0) cuts.Add(quality.Index);
        if (audio.Success && audio.Index > 0) cuts.Add(audio.Index);
        if (cuts.Count > 0) t = t[..cuts.Min()];
        t = FilmTrailingGroup.Replace(t, "");
        t = OpenBracketTail.Replace(t, "");
        t = Strip(FilmTailDebris.Replace(t, ""), Whitespace).Trim();
        return StripTrailingJunkNumber(title, t);
    }

    /// <summary>work-identity.ts normalize: lower case, apostrophes dropped, every other non-alphanumeric run one space.</summary>
    public static string NormalizeKey(string value) =>
        Strip(Strip(Strip(value.ToLowerInvariant(), Apostrophe, ""), NonAlphanumeric), Whitespace).Trim();

    /// <summary>The persisted identity key: <c>series:{name}</c> or <c>film:{name}:{year}</c>.</summary>
    public static string IdentityKey(string name, int? year, bool isSeries) =>
        isSeries ? $"series:{NormalizeKey(name)}" : $"film:{NormalizeKey(name)}:{year}";

    /// <summary>Port of <c>workIdentity(title)</c> without catalog metadata; see <see cref="ShowFolder"/> for <paramref name="keepPartNumber"/>.</summary>
    public static ReleaseIdentity WorkIdentity(string title, bool keepPartNumber = false)
    {
        var release = TrackerPrefix(title ?? "");
        var ep = ReleaseEpisodeParser.Parse(release);
        var series = ep.Season != null || ep.Episode != null || ep.IsSeasonPack || ep.IsMultiSeason == true;
        var year = series ? null : ReleaseYear(release);
        string name;
        if (series)
        {
            name = ShowFolder(release, keepPartNumber);
            if (name.Length == 0) name = CutAtStructure(release).Trim();
            if (ReleaseYear(release) is { } y)
            {
                var stripped = Strip(Regex.Replace(name, $@"\b{y}\b", " ", Options, Timeout), Whitespace).Trim();
                if (stripped.Length > 0) name = stripped;
            }
        }
        else name = FilmName(release, year);
        if (name.Length == 0) name = release.Trim();
        return new(IdentityKey(name, year, series), name, year, series);
    }

    /// <summary>Port of <c>workIdentityFor(releaseName)</c>: display-clean first, then identify.</summary>
    public static ReleaseIdentity IdentityFor(string releaseName)
    {
        var name = releaseName ?? "";
        name = Regex.Replace(name, @"(?<=\d)v\d+\b", "", Options, Timeout);
        name = Regex.Replace(name, @"\[(\d{1,4})\](?=\s*(?:[\[(]|$))", " - $1 ", Options, Timeout);
        return WorkIdentity(CleanDisplayTitle(name), keepPartNumber: true);
    }
}
