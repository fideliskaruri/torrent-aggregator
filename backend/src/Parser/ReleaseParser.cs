using System.Collections.Immutable;
using System.Collections.Concurrent;
using System.Globalization;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Parser;

/// <summary>Name evidence only. No metadata offsets, eligibility decisions or file-list guarantees.</summary>
public sealed class ReleaseParser : IParser
{
    public const int MaximumNameLength = 16_384;
    private readonly int latestReleaseYear;

    public ReleaseParser(int latestReleaseYear)
    {
        if (latestReleaseYear is < 1900 or > 9999) throw new ArgumentOutOfRangeException(nameof(latestReleaseYear));
        this.latestReleaseYear = latestReleaseYear;
    }
    // All keys are private constant grammar expressions, never release/user input.
    private static readonly ConcurrentDictionary<string, Regex> Patterns = new(StringComparer.Ordinal);
    private static Regex R(string pattern) => Patterns.GetOrAdd(pattern, static p => new(p,
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking,
        TimeSpan.FromMilliseconds(100)));

    private static readonly Regex Spaces = R(@"\s+");
    private static readonly Regex Brackets = R(@"\[[^\]]*\]|\([^)]*\)");
    private static readonly Regex Website = R(@"^\s*(?:www\s*\.\s*)?[a-z0-9-]+\.(?:com|org|net|to|me|tv)\s*[-:]*\s*");
    private static readonly Regex Hash = R(@"\[[a-f0-9]{8}\]");
    private static readonly Regex Scene = R(@"\bS(\d{1,3})\s*E(\d{1,4})(?:v\d+)?(?:\s*(?:[-~]| )\s*(?:S(\d{1,3})\s*)?E?(\d{1,3})\b(?:v\d+)?)?");
    private static readonly Regex SceneMore = R(@"\bS\d{1,3}\s*E\d{1,4}(?:v\d+)?((?:\s*E\d{1,4}(?:v\d+)?)+)");
    private static readonly Regex Cross = R(@"\b(\d{1,2})(?:x|×|х|Ñ…)(\d{1,4})(?:\s*[-~]\s*(?:(\d{1,2})(?:x|×|х|Ñ…))?(\d{1,4}))?\b");
    private static readonly Regex Season = R(@"\b(?:S|Seasons?|Series|Temporada|Stagione|Sezon)\s*(\d{1,3})(?:v\d+)?\b(?:[-~]\s*(?:S|Seasons?)?\s*(\d{1,3})\b|\s*[-~]\s*(?:S|Seasons?)\s*(\d{1,3})\b)?");
    private static readonly Regex Ordinal = R(@"\b(\d{1,3})(?:st|nd|rd|th)\s+Season\b");
    private static readonly Regex SeasonList = R(@"\b(?:S|Seasons?|Series|Stagione)\s*(\d{1,3}(?:\s*[,/&+]\s*\d{1,3})+)");
    private static readonly Regex SeasonDash = R(@"\b(?:S|Season)\s*(\d{1,3})\s+-\s+(\d{1,4})(?:v\d+)?\b|\b(\d{1,3})(?:st|nd|rd|th)\s+Season\s+-\s+(\d{1,4})(?:v\d+)?\b");
    private static readonly Regex SeasonBareEpisode = R(@"\bS(\d{1,3})\s+(\d{2,3})(?:v\d+)?\b");
    private static readonly Regex EpisodeWord = R(@"\b(?:Episodes?|Eps?|E)\s*(\d{1,4})(?:v\d+)?(?:\s*[-~]\s*(?:Episodes?|Eps?|E)?\s*(\d{1,4})(?:v\d+)?)?\b");
    private static readonly Regex DashEpisode = R(@"(?:^|\s)-\s*(\d{1,4})(?:v\d+)?(?:\s*[-~]\s*(\d{1,4})(?:v\d+)?)?(?:\s|$|[\[()]|\.(?:mkv|mp4|avi))");
    private static readonly Regex BracketEpisode = R(@"[\[(](\d{1,4})(?:v\d+)?(?:\s*[-~]\s*(\d{1,4})(?:v\d+)?)?[\])]");
    private static readonly Regex BareRange = R(@"\b(\d{1,3})\s*[-~]\s*(\d{1,3})\b");
    private static readonly Regex ChineseEpisode = R(@"第\s*(\d{1,4})(?:\s*[-~]\s*(\d{1,4}))?\s*[话話集]");
    private static readonly Regex FansubNumber = R(@"\s(\d{2,4})(?:v\d+)?(?:\s|$|[\[(])");
    private static readonly Regex Resolution = R(@"(2160|1080|720|480|360|400|576)(?:[piр]\b|Ñ€)");
    private static readonly Regex Dimensions = R(@"\b(4096|3840|1920|1440|1280|1024|848|720|640)[x×](\d{3,4})\b");
    private static readonly Regex Year = R(@"\b(19\d{2}|20\d{2})\b");
    private static readonly Regex Complete = R(@"\b(?:complete|batch|collection|season\s*pack)\b|合集");
    private static readonly Regex WholeSeries = R(@"\bcomplete\s+(?:TV\s+|cartoon\s+)?series\b");
    private static readonly Regex Special = R(@"\b(?:OVA|OAD|recap|specials?|SP|mini\s*anime)\b");
    private static readonly Regex Other = R(@"\b(?:epub|pdf|cbz|cbr|manga|manhwa|comic|doujin|soundtracks?|OST|audiobook|discography|LP|FLAC\s+album|scans?|featurettes?|extras|bonus|henshu|digital|c\d{3}|v\d{2}[- ]|volumes?|book\s+\d|GNU\s+Linux|FitGirl|TENOKE|WinRAR|pngs|subtitle\s+pack|Subs\+Fonts|MP3|chapter[- ]+\d|tak\+cue|novel|DLCs|Read\s+by|Illustrated\s+Guide|Companion\s+Reader|Deleted\s+Scenes|Behind\s+the\s+Scenes|Making\s+of|Gag\s+Reel|Bloopers|Sample|Outtakes|XXX|18\+|AI\s+Generated|Activators|ML\+Key|PKG|Creditless|TVCM|OP\s+Single|TV\s+Size)\b|第\d+[-~]?\d*巻");
    private static readonly Regex Dangerous = R(@"\.(?:exe|com|scr|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|msi|lnk|url|pif|hta|cpl|jar|reg|chm)\b|\b(?:password|passworded|codec\s+required|install\s+codec|zip|rar|7z)\b|\bEXE\s*$");
    private static readonly Regex Cam = R(@"\b(?:CAMRip|CAM|HDCAM|HDTS|TS|TC|telesync|telecine)\b");
    private static readonly Regex English = R(@"\b(?:ENG|English|EN)\b");
    private static readonly Regex Multi = R(@"\b(?:dual|multi)\b");
    private static readonly Regex Foreign = R(@"\b(?:RUS|Russian|ITALIAN|ITA|FR|French|FRE|FRA|VF|GERMAN|GER|DEU|DEUTSCH|SPANISH|SPA|ESP|Castellano|HINDI|HIN|TAMIL|TAM|TELUGU|TEL|JAPANESE|JP|JPN|JAP|KOREAN|KOR|PORTUGUESE|Portugues|POR|PTBR|PT\s*BR|Dublado|POLISH|POL|PL|DUTCH|DUT|CZ|HUN|TURKISH|TUR|UKR|UKRAINIAN|ARABIC|ARA|Filipino|Tagalog|Cantonese|MANDARIN|CHINESE|RAW|RAWS|TRUEFRENCH|LostFilm)\b");
    private static readonly Regex SubtitleOnly = R(@"\b(?:VOSTFR|CHS|CHT|MULTI\s*[- ]\s*Subs?|Portuguese\s+Subs?|Chinese\s+softsub|SUB\s+ITA|Subtitulado\s+Esp)\b");
    private static readonly Regex Source = R(@"\b(?:WEB\s*-?\s*DL(?:RIP)?|WEB\s*-?\s*RIP|WEBMUX|WEB|WEBDL(?:RIP)?|WEBCAP|Blu\s*-?\s*Ray|BDRIP|BRRIP|BDREMUX|BDMV|ITBD|BD|HDTV(?:RIP)?|TVRIP|DVDSCR|DVDRIP|DVD|HDCAM|CAMRIP|CAM|HDTS|TS|TELESYNC|TELECINE)\b|BD(?:1080|720)p");
    private static readonly Regex Codec = R(@"\b(?:[HX]\s*26[456]|HEVC|AVC|AV1|XVID|DIVX|VC[- ]?\s*1|VP9|VVC)\b");
    private static readonly Regex Hdr = R(@"\bHDR10\+|\b(?:HDR10|HDR|DOLBY\s*VISION|DV|SDR)\b");

    public ParsedRelease Parse(string releaseName)
    {
        ArgumentNullException.ThrowIfNull(releaseName);
        if (releaseName.Length > MaximumNameLength)
            throw new ArgumentException($"Release names must not exceed {MaximumNameLength} characters.", nameof(releaseName));
        var raw = releaseName.Trim();
        if (raw.Contains('\\')) raw = raw[(raw.LastIndexOf('\\') + 1)..];
        var group = Group(raw);
        var text = Normalize(raw);
        var technicalStart = new[] { Resolution.Match(text), Source.Match(text), Codec.Match(text),
            R(@"\b(?:AAC\d*|DDP\d*|EAC3|AC3|DTS|TrueHD|Opus|FLAC)\b").Match(text) }
            .Where(m => m.Success).Select(m => m.Index).DefaultIfEmpty(text.Length).Min();
        var seasons = new List<(int Index, int Number)>();
        var episodes = new List<int>();
        var absolute = new List<int>();
        var episodeRanges = new List<NumberRange>();
        var absoluteRanges = new List<NumberRange>();
        var coordinates = new List<(int Start, int End)>();
        foreach (Match date in R(@"\b(?:19|20)\d{2}[- ]\d{2}[- ]\d{2}\b|\b\d{2}[- ]\d{2}[- ](?:19|20)\d{2}\b|\(\d{2} \d{2} \d{2}\)").Matches(text))
            coordinates.Add((date.Index, date.Index + date.Length));
        var sceneMatches = Scene.Matches(text);
        foreach (Match m in sceneMatches)
        {
            seasons.Add((m.Index, N(m, 1)));
            AddNumber(m, 2, 4, episodes, episodeRanges);
            if (m.Groups[3].Success) seasons.Add((m.Index + m.Length, N(m, 3)));
            coordinates.Add((m.Index, m.Index + m.Length));
        }
        foreach (Match m in SceneMore.Matches(text))
        {
            var all = R(@"E(\d{1,4})").Matches(m.Value).Cast<Match>().Select(e => N(e, 1)).ToArray();
            episodes.Remove(all[0]);
            episodeRanges.Add(new(all[0], all[^1]));
            coordinates.Add((m.Index, m.Index + m.Length));
        }
        foreach (Match m in Cross.Matches(text))
        {
            if (Inside(m.Index, coordinates) || N(m, 1) > 99 || N(m, 2) > 999) continue;
            seasons.Add((m.Index, N(m, 1)));
            AddNumber(m, 2, 4, episodes, episodeRanges);
            if (m.Groups[3].Success) seasons.Add((m.Index + m.Length, N(m, 3)));
            coordinates.Add((m.Index, m.Index + m.Length));
        }
        var seasonDash = SeasonDash.Matches(text);
        foreach (Match m in seasonDash)
        {
            if (R(@"\bS\d{1,3}\s*[+&]\s*$").IsMatch(text[..m.Index])) continue;
            var sg = m.Groups[1].Success ? 1 : 3;
            seasons.Add((m.Index, N(m, sg)));
            episodes.Add(N(m, sg + 1));
            coordinates.Add((m.Index, m.Index + m.Length));
        }
        foreach (Match m in SeasonBareEpisode.Matches(text))
        {
            if (Inside(m.Index, coordinates)) continue;
            if (R(@"\bS\d{1,3}\s*[+&]\s*$").IsMatch(text[..m.Index])) continue;
            if (Complete.IsMatch(text))
            {
                var first = N(m, 1);
                var last = N(m, 2);
                if (last >= first && last - first < 100)
                    for (var n = first; n <= last; n++) seasons.Add((m.Index, n));
                coordinates.Add((m.Index, m.Index + m.Length));
                continue;
            }
            seasons.Add((m.Index, N(m, 1)));
            var continuation = R(@"^-(\d{1,4})\b").Match(text[(m.Index + m.Length)..]);
            if (continuation.Success) episodeRanges.Add(new(N(m, 2), N(continuation, 1)));
            else episodes.Add(N(m, 2));
            coordinates.Add((m.Index, m.Index + m.Length));
        }
        foreach (Match m in Ordinal.Matches(text)) seasons.Add((m.Index, N(m, 1)));
        foreach (Match m in Season.Matches(text))
        {
            if (Inside(m.Index, coordinates)) continue;
            var first = N(m, 1);
            var last = m.Groups[2].Success ? N(m, 2) : m.Groups[3].Success ? N(m, 3) : first;
            if (last >= first && last - first <= 200)
                for (var i = first; i <= last; i++) seasons.Add((m.Index, i));
            else seasons.Add((m.Index, first));
            coordinates.Add((m.Index, m.Index + m.Length));
        }
        foreach (Match m in SeasonList.Matches(text))
            foreach (var n in R(@"\d+").Matches(m.Groups[1].Value).Cast<Match>())
                seasons.Add((m.Index, int.Parse(n.Value, CultureInfo.InvariantCulture)));
        foreach (Match m in R(@"\bStagione\s+(\d{1,3})\s+(\d{1,3})\b").Matches(text))
            for (var n = N(m, 1); n <= N(m, 2) && n < N(m, 1) + 100; n++) seasons.Add((m.Index, n));
        foreach (Match m in R(@"\bCap\s+(\d{3,4})(?:\s+(\d{3,4}))?\b").Matches(text))
        {
            var first = N(m, 1);
            seasons.Add((m.Index, first / 100));
            if (m.Groups[2].Success) episodeRanges.Add(new(first % 100, N(m, 2) % 100));
            else episodes.Add(first % 100);
            coordinates.Add((m.Index, m.Index + m.Length));
        }
        foreach (Match m in R(@"\bE(\d{1,4})(?:\+\d+)?\s+of\s+\d+").Matches(text))
        {
            episodeRanges.Add(new(1, N(m, 1)));
            coordinates.Add((m.Index, m.Index + m.Length));
        }
        foreach (Match m in EpisodeWord.Matches(text))
        {
            if (Inside(m.Index, coordinates)) continue;
            if (seasons.Count != 0 && episodes.Count == 0 && m.Index > seasons.Min(s => s.Index))
                AddNumber(m, 1, 2, episodes, episodeRanges);
            else AddNumber(m, 1, 2, absolute, absoluteRanges);
            coordinates.Add((m.Index, m.Index + m.Length));
        }
        foreach (Match m in ChineseEpisode.Matches(text))
        {
            AddNumber(m, 1, 2, absolute, absoluteRanges);
            coordinates.Add((m.Index, m.Index + m.Length));
        }
        foreach (Match m in DashEpisode.Matches(text))
        {
            if (Inside(m.Index + m.Value.IndexOf('-'), coordinates)) continue;
            var prefix = text[..m.Index].TrimEnd();
            if (R(@"\b(?:Part|Cour)\s*$").IsMatch(prefix)) continue;
            if (m.Index >= technicalStart) continue;
            if (N(m, 1) is >= 1900 and <= 2100 || N(m, 1) == 0) continue;
            AddNumber(m, 1, 2, absolute, absoluteRanges);
            coordinates.Add((m.Index, m.Index + m.Length));
        }
        foreach (Match m in BracketEpisode.Matches(text))
        {
            if (Inside(m.Index, coordinates)) continue;
            if (N(m, 1) is >= 1900 and <= 2100 || N(m, 1) == 0) continue;
            if (seasons.Count > 0 && sceneMatches.Count == 0 && m.Groups[2].Success && seasons.Select(s => s.Number).Distinct().Count() == 1)
                AddNumber(m, 1, 2, episodes, episodeRanges);
            else AddNumber(m, 1, 2, absolute, absoluteRanges);
            coordinates.Add((m.Index, m.Index + m.Length));
        }
        foreach (Match m in BareRange.Matches(text))
        {
            if (Inside(m.Index, coordinates) || N(m, 1) == 0 || N(m, 2) == 0) continue;
            var prefix = text[..m.Index];
            if (R(@"\b(?:Part|Cour|Seasons?|Series|Sezon|Stagione|S|v|c)\s*$").IsMatch(prefix)) continue;
            if (sceneMatches.Count > 0 || Cross.IsMatch(text)) continue;
            if (m.Index >= technicalStart) continue;
            if (R(@"\b(?:Seasons?|Series|S)\s*$").IsMatch(prefix)) continue;
            AddNumber(m, 1, 2, absolute, absoluteRanges);
            coordinates.Add((m.Index, m.Index + m.Length));
        }
        if (episodes.Count == 0 && absolute.Count == 0 && episodeRanges.Count == 0 && absoluteRanges.Count == 0 &&
            (group is not null || R(@"\bmini\s*anime\b").IsMatch(text)))
        {
            var numberLimit = Math.Min(technicalStart, Year.Match(text).Success ? Year.Match(text).Index : text.Length);
            foreach (Match m in FansubNumber.Matches(text))
            {
                var n = N(m, 1);
                if (n == 0 || n is >= 1900 and <= 2100 || m.Index >= numberLimit || Inside(m.Index + 1, coordinates)) continue;
                if (R(@"^\s*(?:years?|yrs?|nen|ans?|days?|bit|bits|GB|MB)\b").IsMatch(text[(m.Index + m.Length)..])) continue;
                if (R(@"\b(?:Part|Cour|Seasons?|Series)\s*$").IsMatch(text[..m.Index])) continue;
                if (seasons.Count > 0 && m.Index < seasons.Min(s => s.Index) && n < 1000) continue;
                absolute.Add(n);
                coordinates.Add((m.Index, m.Index + m.Length));
                break;
            }
        }
        var seasonNumbers = seasons.OrderBy(x => x.Index).Select(x => x.Number).Distinct().ToImmutableArray();
        var hasEpisodes = episodes.Count + absolute.Count + episodeRanges.Count + absoluteRanges.Count > 0;
        var scopeText = R(@"\([^)]*\bw/\s*[^)]*\)").Replace(text, "");
        var special = Special.Match(scopeText);
        var other = Other.IsMatch(scopeText);
        if (R(@"\b(?:Specials?|Soundtracks?)\s*\+|\+\s*(?:Specials?|Soundtracks?|Extras)\b|\bwith\b").IsMatch(scopeText) &&
            (seasons.Count > 0 || hasEpisodes))
            other = false;
        if (R(@"\bchapter\s+\d|MP3\s*[@\d]").IsMatch(scopeText)) other = true;
        if (R(@"\b(?:zip|rar|7z)\b").IsMatch(scopeText) && !Source.IsMatch(scopeText) &&
            !R(@"\b(?:movie|BluRay|BDRIP)\b").IsMatch(scopeText)) other = true;
        if (R(@"\bMP3\b").IsMatch(scopeText) && Source.IsMatch(scopeText) &&
            !R(@"\b(?:soundtrack|discography|album)\b").IsMatch(scopeText)) other = false;
        if (R(@"\bOST\b").IsMatch(scopeText) && (Resolution.IsMatch(scopeText) || Codec.IsMatch(scopeText) || Source.IsMatch(scopeText)) &&
            !R(@"\b(?:soundtrack|discography|album|extras)\b").IsMatch(scopeText)) other = false;
        if (other)
        {
            episodes.Clear(); absolute.Clear(); episodeRanges.Clear(); absoluteRanges.Clear();
            hasEpisodes = false;
        }
        var wholeSeries = WholeSeries.IsMatch(text);
        var kind = other ? ReleaseKind.Other :
            wholeSeries ? ReleaseKind.CompleteSeries :
            seasonNumbers.Length > 1 && sceneMatches.Count == 0 && !Cross.IsMatch(text) ? ReleaseKind.MultiSeason :
            seasonNumbers.Contains(0) || R(@"\bmini\s*anime\b").IsMatch(scopeText) ||
                special.Success && !hasEpisodes && !R(@"\bTV\s*\+\s*SP\b").IsMatch(scopeText) ? ReleaseKind.Special :
            hasEpisodes ? ReleaseKind.Episode :
            seasonNumbers.Length > 0 || R(@"\bTV\s*\+\s*SP\b").IsMatch(scopeText) ||
                Complete.IsMatch(text) && !R(@"\b(?:movie|voice|unknown)\b").IsMatch(text) ? ReleaseKind.SeasonPack :
            Year.IsMatch(text) || Source.IsMatch(text) || Resolution.IsMatch(text) ||
                Codec.IsMatch(text) || English.IsMatch(text) ||
                R(@"\bComplete\b\s*[\])]").IsMatch(text) ||
                R(@"\b(?:movie|dub|dubbed|subs?|remux|VOSTFR|Vietsub)\b|\.(?:mkv|mp4|avi)\b").IsMatch(raw)
                ? ReleaseKind.Movie : ReleaseKind.Other;
        var languageText = text;
        if (group is not null && Normalize(group).Length > 0) languageText = languageText.Replace(Normalize(group),
            new string(' ', Normalize(group).Length), StringComparison.OrdinalIgnoreCase);
        languageText = R(@"\b[\p{L}\p{N}'_-]+[- ]Raws?\b").Replace(languageText, m => new string(' ', m.Length));
        var multiAudio = Multi.Matches(languageText).Cast<Match>().Any(m =>
            !R(@"^\s*[- ]?\s*subs?\b").IsMatch(languageText[(m.Index + m.Length)..]));
        var foreignText = SubtitleOnly.Replace(languageText, " ");
        if (R(@"\bGerDub\b").IsMatch(languageText)) foreignText += " GER";
        foreignText = R(@"\bJP[- ]BD\b").Replace(foreignText, " ");
        foreignText = R(@"\b(?:German|French|Spanish|Russian|Japanese|Chinese|Dutch|Italian)\s+[\p{L}]+\s*\((?:19|20)\d{2}\)").Replace(foreignText, " ");
        foreignText = R(@"\b(?:PT[- ]?BR|Napisy\s+PL)\s+Subs?\b|\bNapisy\s+PL\b").Replace(foreignText, " ");
        var language = English.IsMatch(languageText) || multiAudio ? ForeignStatus.No :
            Foreign.IsMatch(foreignText) ? ForeignStatus.Yes : ForeignStatus.Unknown;
        var markers = English.Matches(languageText).Cast<Match>().Concat(Foreign.Matches(languageText).Cast<Match>())
            .Concat(Multi.Matches(languageText).Cast<Match>()).Select(m => m.Value.ToLowerInvariant()).Distinct().ToImmutableArray();
        var cam = Cam.IsMatch(text);
        var safetyText = R(@"www\.[a-z0-9.-]+\.(?:com|org|net|to|me|tv)|\[[^\]]*\.(?:com|org|net|to|me|tv)[^\]]*\]|[a-z0-9._-]+\.(?:com|org|net|to|me|tv)\.(?:avi|mkv|mp4)").Replace(raw, " ");
        safetyText = R(@"\bNO[- ]RAR\b").Replace(safetyText, " ");
        var unsafeName = Dangerous.IsMatch(safetyText) || cam;
        var yearMatch = Year.Matches(text).Cast<Match>().FirstOrDefault(m =>
            N(m, 1) <= latestReleaseYear && m.Index > 0 &&
            (text[..m.Index].Trim(' ', '[', '(').Length > 0 || text[m.Index - 1] is '[' or '(') &&
            !Dimensions.Matches(text).Cast<Match>().Any(d => m.Index >= d.Index && m.Index < d.Index + d.Length) &&
            !(N(m, 1) == 1920 && R(@"^\s+Anti[- ]?Banding\b").IsMatch(text[(m.Index + m.Length)..])) &&
            !R(@"\b(?:BT|REC)\s*$").IsMatch(text[..m.Index]));
        int? year = yearMatch is null ? null : N(yearMatch, 1);
        var titleEnd = new[] { coordinates.Count == 0 ? text.Length : coordinates.Min(c => c.Start),
            seasons.Count == 0 ? text.Length : seasons.Min(s => s.Index),
            yearMatch?.Index ?? text.Length, Resolution.Match(text).Success ? Resolution.Match(text).Index : text.Length,
            Source.Match(text).Success ? Source.Match(text).Index : text.Length,
            Dimensions.Match(text).Success ? Dimensions.Match(text).Index : text.Length,
            Codec.Match(text).Success ? Codec.Match(text).Index : text.Length,
            Hdr.Match(text).Success ? Hdr.Match(text).Index : text.Length,
            R(@"\b(?:4K|UHD|FHD|AAC\d*|DDP\d*|EAC3|AC3|DTS|TrueHD|Opus|FLAC)\b").Match(text) is { Success: true } noise
                ? noise.Index : text.Length }.Min();
        var title = Brackets.Replace(text[..titleEnd], m =>
        {
            var content = m.Value[1..^1];
            return group is not null && content.Equals(Normalize(group), StringComparison.OrdinalIgnoreCase) ||
                Source.IsMatch(content) || Resolution.IsMatch(content) || Codec.IsMatch(content) ||
                IsLanguageTag(content) ? " " : content;
        }).Trim(' ', '-', '(', ')', '[', ']');
        title = Spaces.Replace(title, " ");
        return new(releaseName, title, year, seasonNumbers, episodes.Distinct().ToImmutableArray(),
            absolute.Distinct().ToImmutableArray(), episodeRanges.Concat(absoluteRanges).Distinct().ToImmutableArray(),
            kind is ReleaseKind.SeasonPack or ReleaseKind.MultiSeason or ReleaseKind.CompleteSeries,
            seasonNumbers.Length > 1, special.Success ? special.Value.ToLowerInvariant() : null,
            new(GetResolution(text), GetSource(text), GetCodec(text), GetHdr(text)), group,
            markers, language == ForeignStatus.Yes, R(@"\bsample\b").IsMatch(text), cam)
        {
            Kind = kind, Foreign = language, Unsafe = unsafeName,
            EpisodeRanges = episodeRanges.Distinct().ToImmutableArray(),
            AbsoluteRanges = absoluteRanges.Distinct().ToImmutableArray()
        };
    }

    private static bool Inside(int position, List<(int Start, int End)> spans) =>
        spans.Any(s => position >= s.Start && position < s.End);
    private static int N(Match m, int group) => int.Parse(m.Groups[group].Value, CultureInfo.InvariantCulture);
    private static void AddNumber(Match m, int first, int last, List<int> numbers, List<NumberRange> ranges)
    {
        if (m.Groups[last].Success) ranges.Add(new(N(m, first), N(m, last)));
        else numbers.Add(N(m, first));
    }

    private static string Normalize(string raw)
    {
        var value = Website.Replace(raw, "");
        value = Hash.Replace(value, " ");
        value = value.Replace('–', '-').Replace('—', '-').Replace('−', '-').Replace('‐', '-')
            .Replace('‑', '-').Replace('’', '\'').Replace('‘', '\'').Replace('`', '\'');
        value = value.Replace('.', ' ').Replace('_', ' ');
        value = R(@"[\p{L}]-[\p{L}]").Replace(value, m => m.Value.Replace('-', ' '));
        value = value.Replace("--", " - ").Replace("-[", " [").Replace("]-", "] ");
        return Spaces.Replace(value, " ").Trim();
    }

    private static string? Group(string raw)
    {
        raw = R(@"\s+EZTV\s*$").Replace(raw, "").Trim();
        var leading = R(@"^\s*\[([^\]]+)\]").Match(raw);
        if (leading.Success && !string.IsNullOrWhiteSpace(leading.Groups[1].Value) &&
            !IsLanguageTag(leading.Groups[1].Value) &&
            !R(@"\b(?:1080|720|2160|480|WEB|BDMV|BDRIP|BD|HEVC|x26[45]|AAC|ENG|MULTI|JPN|JAP|RUS|Film)\b|\.(?:com|tv|org|net)|Torrent|www\.|[a-f0-9]{8}").IsMatch(leading.Groups[1].Value))
            return leading.Groups[1].Value.Trim().TrimEnd('.');
        var suffix = R(@"-([a-z0-9][a-z0-9@_]*(?:-Raws?)?)(?:\s*(?:\([^)]*\)|\[[^\]]*\]|\.?(?:mkv|mp4|avi)))*\s*$").Match(raw);
        if (suffix.Success && !IsLanguageTag(suffix.Groups[1].Value) &&
            !R(@"^(?:S\d{1,3}(?:E\d{1,4})?|E\d{1,4}|[HX]26[456]|HEVC|AVC|AV1|OVA|OAD|\d{3,4}p)$").IsMatch(suffix.Groups[1].Value) &&
            !R(@"^(?:DL|RIP|bit|subs?|audio|avi|mkv|mp4|\d+)$").IsMatch(suffix.Groups[1].Value))
            return suffix.Groups[1].Value;
        var flat = R(@"\b(?:[HX]\s*26[45]|HEVC|XVID|10bit|Atmos)\s+([a-z][a-z0-9]+)\s*$").Match(raw);
        if (flat.Success && !R(@"^(?:AAC|EAC3|DDP|HEVC|XVID|ATMOS|BluRay|WEB|DL)$").IsMatch(flat.Groups[1].Value))
            return flat.Groups[1].Value;
        return null;
    }

    private static bool IsLanguageTag(string value)
    {
        var remaining = English.Replace(Foreign.Replace(Multi.Replace(SubtitleOnly.Replace(value, ""), ""), ""), "");
        return R(@"\b(?:audio|dub|subs?|subtitles?|only)\b|[\s,;/+&-]").Replace(remaining, "").Length == 0;
    }

    private static int? GetResolution(string text)
    {
        var values = Resolution.Matches(text).Cast<Match>().Select(m => N(m, 1)).Distinct().ToArray();
        if (values.Length > 0) return values.Length == 1 && values[0] is 2160 or 1080 or 720 or 480 ? values[0] : null;
        var dimensions = Dimensions.Match(text);
        if (dimensions.Success) return N(dimensions, 1) switch { 4096 or 3840 => 2160, 1920 or 1440 => 1080, 1280 => 720, _ => null };
        if (R(@"\b(?:4K|UHD)\b").IsMatch(text)) return 2160;
        if (R(@"\bFHD\b").IsMatch(text)) return 1080;
        return null;
    }

    private static string? GetSource(string text)
    {
        var m = Source.Match(text);
        if (!m.Success) return null;
        var token = m.Value.Replace(" ", "").Replace("-", "").ToLowerInvariant();
        return token.StartsWith("web", StringComparison.Ordinal) ? "web" :
            token is "bluray" or "bdrip" or "brrip" or "bdremux" or "bdmv" or "itbd" or "bd" ||
                token.StartsWith("bd1080", StringComparison.Ordinal) || token.StartsWith("bd720", StringComparison.Ordinal) ? "bluray" :
            token.StartsWith("dvd", StringComparison.Ordinal) ? "dvd" :
            token.StartsWith("hdtv", StringComparison.Ordinal) || token == "tvrip" ? "hdtv" :
            token is "cam" or "camrip" or "hdcam" ? "cam" : "ts";
    }

    private static string? GetCodec(string text)
    {
        var values = Codec.Matches(text).Cast<Match>().Select(m => m.Value.Replace(" ", "").ToLowerInvariant() switch
        {
            "h264" or "x264" or "avc" => "h264", "h265" or "x265" or "hevc" => "h265",
            "h266" or "x266" or "vvc" => "h266", "vc1" or "vc-1" => "vc1", var value => value
        }).Distinct().Order(StringComparer.Ordinal).ToArray();
        return values.Length == 0 ? null : string.Join(",", values);
    }

    private static string? GetHdr(string text)
    {
        var values = Hdr.Matches(text).Cast<Match>().Select(m => m.Value.ToLowerInvariant() switch
        {
            "dolby vision" => "dv", var value => value
        }).Distinct().Order(StringComparer.Ordinal).ToArray();
        return values.Length == 0 ? null : string.Join(",", values);
    }

    public string? NormalizeInfoHash(string hashOrMagnet)
    {
        ArgumentNullException.ThrowIfNull(hashOrMagnet);
        var value = hashOrMagnet.Trim();
        if (value.StartsWith("magnet:?", StringComparison.OrdinalIgnoreCase))
        {
            value = value[8..].Split('&').Select(p => p.Split('=', 2))
                .Where(p => p.Length == 2 && p[0].Equals("xt", StringComparison.OrdinalIgnoreCase))
                .Select(p => Uri.UnescapeDataString(p[1])).FirstOrDefault(p =>
                    p.StartsWith("urn:btih:", StringComparison.OrdinalIgnoreCase))?[9..] ?? "";
        }
        if (value.Length == 40 && value.All(Uri.IsHexDigit)) return value.ToLowerInvariant();
        if (value.Length != 32) return null;
        Span<byte> bytes = stackalloc byte[20];
        var buffer = 0;
        var bits = 0;
        var index = 0;
        foreach (var c in value.ToUpperInvariant())
        {
            var n = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".IndexOf(c);
            if (n < 0) return null;
            buffer = (buffer << 5) | n;
            bits += 5;
            if (bits < 8) continue;
            bits -= 8;
            bytes[index++] = (byte)(buffer >> bits);
        }
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}
