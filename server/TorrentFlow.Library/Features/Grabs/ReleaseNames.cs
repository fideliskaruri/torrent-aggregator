using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>A release's work identity: the name and (films only) year that key it.</summary>
public readonly record struct ReleaseIdentity(string Name, int? Year, bool IsSeries);

/// <summary>
/// Library-local port of the TS release-name parsers the grab selectors depend on:
/// <c>parseEpisode</c> (torrents/episodes.ts), <c>isEpisodeRangeRelease</c> (torrents/pack-preference.ts),
/// <c>cleanDisplayTitle</c> (components/browse/availability.ts), <c>workIdentity</c> (torrents/work-identity.ts)
/// and <c>workKeyMatches</c> (components/title/work-key.ts). Modules never share projects, so these mirror
/// the Search module's ports rather than referencing them.
/// </summary>
public static class ReleaseNames
{
    private const RegexOptions Options = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(1);
    private static Regex Rx(string pattern, RegexOptions options = Options) => new(pattern, options, Timeout);
    private static bool Has(string value, Regex regex) => regex.IsMatch(value);
    private static string Strip(string value, Regex regex, string replacement = " ") => regex.Replace(value, replacement);

    // ── parseEpisode ─────────────────────────────────────────────────────────
    private static readonly Regex OrdinalSeason = Rx(@"\b(\d{1,3})(?:st|nd|rd|th)\s+Season\s*[-–—]\s*(\d{1,4})\b");
    private static readonly Regex AbsoluteEp = Rx(@"\b(?:absolute\s*)?(?:episode|ep)\s*\.?\s*(\d{1,4})\b");
    private static readonly Regex SeasonRange = Rx(@"\bS(?:easons?|eries)?[\s._]*\d{1,3}(?:\s*(?:[-–—~+&,]|\band\b|\bto\b|\bplus\b)\s*(?:S(?:easons?|eries)?[\s._]*)?\d{1,3}(?!\d))+");
    private static readonly Regex SeasonList = Rx(@"\b(?:Seasons?|Series)\s+(\d{1,3}(?:\s+\d{1,3}){2,})\b");
    private static readonly Regex Digits = Rx(@"\d{1,3}");
    private static readonly Regex CompleteWord = Rx(@"\b(complete|batch|season\s*pack)\b");
    private static readonly Regex SeasonNumber = Rx(@"\bS(?:eason)?\s*(\d{1,3})\b");
    private static readonly Regex SceneEpisode = Rx(@"\bS(\d{1,3})\s*E(\d{1,4})\b");
    private static readonly Regex CrossEpisode = Rx(@"\b(\d{1,2})x(\d{1,4})\b");
    private static readonly Regex WordEpisode = Rx(@"\b(?:episode|ep|e)\s*\.?\s*(\d{1,4})\b");
    private static readonly Regex DashEpisode = Rx(@"[-–]\s*(\d{1,4})\s*(?=\.(?:mkv|mp4|avi|m4v|ts)\s*$|[\[(]|$|\b(?:480p|720p|1080p|2160p|4k|web-?dl|webrip|bluray|hdtv)\b)");
    private static readonly Regex LeadingGroup = Rx(@"^\s*\[[^\]]+\]");
    private static readonly Regex LeadingGroupStrip = Rx(@"^\s*\[[^\]]+\]\s*");
    private static readonly Regex BareNumber = Rx(@"\s(\d{3,4})(?=\s|$|[\[(.])");
    private static readonly Regex CountWord = Rx(@"^\s*(?:years?|yrs?|nen|ans?|days?)\b");
    private static readonly Regex Slime300 = Rx(@"\bslime[\s._-]*300\b");
    private static readonly Regex BareSeason = Rx(@"\bS(\d{1,3})\b(?!\s*E\d)");
    private static readonly Regex WordSeason = Rx(@"\b(?:Seasons?|Series)[\s._]*(\d{1,3})\b");
    private static readonly Regex SpecialSeparators = Rx(@"[._-]+");
    private static readonly (Regex Pattern, string Name)[] Specials =
        [(Rx(@"\b(?:ova|oad)\b"), "ova"), (Rx(@"\brecap\b"), "recap"), (Rx(@"\bmovie\b"), "movie"), (Rx(@"\bspecials?\b"), "special")];

    private static int N(Match m, int group = 1) => int.Parse(m.Groups[group].Value, CultureInfo.InvariantCulture);

    public static string? SpecialType(string title)
    {
        var t = Strip(title, SpecialSeparators);
        foreach (var (pattern, name) in Specials)
            if (pattern.IsMatch(t)) return name;
        return null;
    }

    public static EpisodeInfo ParseEpisode(string title)
    {
        var parsed = ParseEpisodeBase(title ?? "");
        return parsed with { SpecialType = SpecialType(title ?? ""), IsMultiSeason = parsed.IsMultiSeason ?? false };
    }

    private static EpisodeInfo Single(int? season, int episode, bool scene = false) => new()
    {
        Season = season, Episode = episode,
        Label = season is null ? $"Ep {episode}" : scene ? $"S{season:00}E{episode:00}" : $"S{season:00} Ep {episode}",
    };

    private static EpisodeInfo Pack(int? season, int? end = null) => new()
    {
        Season = season, IsBatch = true, IsSeasonPack = true, IsMultiSeason = end != null && end != season,
        Label = season == null ? "Batch" : end != null && end != season ? $"S{season:00}-S{end:00} pack" : $"S{season:00} pack",
    };

    private static EpisodeInfo ParseEpisodeBase(string t)
    {
        var m = OrdinalSeason.Match(t);
        if (m.Success)
        {
            var result = Single(N(m), N(m, 2), true);
            var absolute = AbsoluteEp.Match(t);
            return absolute.Success && N(absolute) != result.Episode
                ? result with { AbsoluteEpisode = N(absolute), Label = $"{result.Label} · absolute {N(absolute)}" } : result;
        }
        m = SeasonRange.Match(t);
        if (!m.Success) m = SeasonList.Match(t);
        if (m.Success)
        {
            var nums = Digits.Matches(m.Value).Select(x => int.Parse(x.Value, CultureInfo.InvariantCulture)).ToArray();
            return Pack(nums[0], nums[^1]);
        }
        if (CompleteWord.IsMatch(t))
        {
            m = SeasonNumber.Match(t);
            return Pack(m.Success ? N(m) : null);
        }
        m = SceneEpisode.Match(t);
        if (!m.Success) m = CrossEpisode.Match(t);
        if (m.Success) return Single(N(m), N(m, 2), true);
        var season = SeasonNumber.Match(t);
        int? s = season.Success ? N(season) : null;
        m = WordEpisode.Match(t);
        if (m.Success) return Single(s, N(m));
        m = DashEpisode.Match(t);
        if (m.Success && N(m) > 0 && N(m) is not (>= 1900 and <= 2100)) return Single(s, N(m));
        if (LeadingGroup.IsMatch(t))
        {
            var after = LeadingGroupStrip.Replace(t, "");
            m = BareNumber.Match(after);
            if (m.Success && N(m) > 0 && N(m) is not (>= 1900 and <= 2100)
                && !CountWord.IsMatch(after[(m.Index + m.Length)..])
                && !(N(m) == 300 && Slime300.IsMatch(after)))
                return Single(s, N(m));
        }
        m = BareSeason.Match(t);
        if (!m.Success) m = WordSeason.Match(t);
        return m.Success ? Pack(N(m)) : new();
    }

    // ── isEpisodeRangeRelease ────────────────────────────────────────────────
    private static readonly Regex[] EpisodeRanges =
    [
        Rx(@"\bS\d{1,3}\s*E\d{1,4}\s*[-–—~]\s*(?:S\d{1,3}\s*)?E?\d{1,4}\b"),
        Rx(@"\b\d{1,3}x\d{1,4}\s*[-–—~]\s*(?:\d{1,3}x)?\d{1,4}\b"),
        Rx(@"\b(?:episodes?|eps?|e)\s*\.?\s*\d{1,4}\s*[-–—~]\s*(?:episodes?|eps?|e)?\s*\.?\s*\d{1,4}\b"),
    ];

    /// <summary>Episode ranges are multi-file intent even when the parser sees their first E.</summary>
    public static bool IsEpisodeRangeRelease(string title) => EpisodeRanges.Any(r => r.IsMatch(title));

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

    internal static int? ReleaseYear(string title)
    {
        var t = Strip(Strip(title, DotsUnderscores), YearNoise);
        var max = DateTime.UtcNow.Year + 2;
        return YearToken.Matches(t).Select(m => int.Parse(m.Value, CultureInfo.InvariantCulture))
            .Where(y => y >= 1900 && y <= max).Select(y => (int?)y).LastOrDefault();
    }

    private static string CutAtStructure(string title)
    {
        var m = Structure.Match(title);
        return m.Success && m.Index > 0 ? title[..m.Index] : title;
    }

    private static string ShowCleanTitle(string title)
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

    private static string Sanitize(string title)
    {
        var t = Strip(UnsafePathChars.Replace(title, ""), Whitespace).Trim().TrimEnd('.', ' ');
        if (WwwStart.IsMatch(t) || DomainStart.IsMatch(t) && !t.Any(char.IsWhiteSpace)) return "";
        t = DomainPrefix.Replace(t, "").Trim();
        return t[..Math.Min(120, t.Length)];
    }

    private static string ShowFolder(string title)
    {
        var clean = ShowCleanTitle(title);
        if (ParseEpisode(title).Episode is { } number)
            clean = Regex.Replace(clean, $@"\b0*{number}\b", " ", Options, Timeout);
        clean = Strip(Strip(TrailingNumber.Replace(clean, " "), FolderWords), Whitespace).Trim();
        return Sanitize(clean);
    }

    private static string StripTrailingJunkNumber(string rawTitle, string cleaned)
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

    /// <summary>Port of <c>workIdentity(title)</c> without catalog metadata (grab searches are not enriched).</summary>
    public static ReleaseIdentity WorkIdentity(string title)
    {
        var release = TrackerPrefix(title ?? "");
        var ep = ParseEpisode(release);
        var series = ep.Season != null || ep.Episode != null || ep.IsSeasonPack || ep.IsMultiSeason == true;
        var year = series ? null : ReleaseYear(release);
        string name;
        if (series)
        {
            name = ShowFolder(release);
            if (name.Length == 0) name = CutAtStructure(release).Trim();
            if (ReleaseYear(release) is { } y)
            {
                var stripped = Strip(Regex.Replace(name, $@"\b{y}\b", " ", Options, Timeout), Whitespace).Trim();
                if (stripped.Length > 0) name = stripped;
            }
        }
        else name = FilmName(release, year);
        if (name.Length == 0) name = release.Trim();
        return new(name, year, series);
    }

    /// <summary>Port of <c>workIdentityFor(releaseName)</c>: display-clean first, then identify.</summary>
    public static ReleaseIdentity IdentityFor(string releaseName) => WorkIdentity(CleanDisplayTitle(releaseName ?? ""));

    // ── work keys ────────────────────────────────────────────────────────────
    private static readonly Regex LegacySizeGroup = Rx(@"-\d+(?:-\d+)?-?[kmgt]i?b(?:-(?!(?:19|20)\d{2}$)[a-z0-9]{2,20})?(?=-(?:19|20)\d{2}$|$)");
    private static readonly Regex KeyTrailingYear = Rx(@"-(?:19|20)\d{2}$");
    private static readonly Regex Apostrophes = Rx("['’`]");
    private static readonly Regex NonSlug = Rx("[^a-z0-9]+", RegexOptions.CultureInvariant);

    /// <summary>Port of <c>workKeyFor</c>; empty when the name has no slug.</summary>
    public static string WorkKeyFor(string name, int? year = null)
    {
        var slug = Slugify(name ?? "");
        return slug.Length == 0 ? "" : year is { } y && y != 0 ? $"{slug}-{y}" : slug;
    }

    private static string Slugify(string name)
    {
        var folded = string.Concat(name.Normalize(NormalizationForm.FormKD).Where(c => c is < '\u0300' or > '\u036f'));
        folded = Apostrophes.Replace(folded, "").ToLowerInvariant();
        var slug = NonSlug.Replace(folded, "-").Trim('-');
        if (slug.Length > 0) return slug;
        var compact = Regex.Replace(name.Trim().ToLowerInvariant(), @"\s+", "-");
        return compact.Length > 0 ? Uri.EscapeDataString(compact) : "";
    }

    private static string[] KeyAliases(string key)
    {
        var wanted = key.Trim().ToLowerInvariant();
        if (wanted.Length == 0) return [];
        var legacy = LegacySizeGroup.Replace(wanted, "", 1);
        return legacy == wanted ? [wanted] : [wanted, legacy];
    }

    /// <summary>Port of <c>workKeyMatches</c>: exact key/alias match, or a yearless name that cannot contradict a dated key.</summary>
    public static bool WorkKeyMatches(string key, string name, int? year)
    {
        var candidates = KeyAliases(key ?? "");
        if (candidates.Length == 0) return false;
        var withYear = WorkKeyFor(name, year);
        var bare = WorkKeyFor(name);
        if (candidates.Any(c => c == withYear || c == bare)) return true;
        if (year != null) return false;
        return bare.Length > 0 && candidates.Any(c => KeyTrailingYear.Replace(c, "") == bare);
    }
}
