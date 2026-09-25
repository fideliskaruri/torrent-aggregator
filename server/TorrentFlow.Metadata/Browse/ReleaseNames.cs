using System.Globalization;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Metadata.Browse;

/// <summary>workIdentity() result (src/lib/torrents/work-identity.ts), without the metadata override.</summary>
public sealed record ReleaseIdentity(string Key, string Name, int? Year, bool IsSeries);

/// <summary>
/// The release-name rules the browse rails and catalog key on: parseEpisode, workIdentity, detectContentKind and
/// isSupportedVideoFileName. The Search module owns the canonical port; modules never reference each other, so the
/// metadata-free subset lives here verbatim and the tests pin it against the Search implementation.
/// </summary>
public static class ReleaseNames
{
    private static Match Match(string value, string pattern) => Regex.Match(value, pattern, RegexOptions.IgnoreCase, TimeSpan.FromSeconds(1));
    private static string Replace(string value, string pattern, string replacement = " ") => Regex.Replace(value, pattern, replacement, RegexOptions.IgnoreCase, TimeSpan.FromSeconds(1));
    private static bool Has(string text, string pattern) => Match(text, pattern).Success;
    private static int N(Match m, int group = 1) => int.Parse(m.Groups[group].Value, CultureInfo.InvariantCulture);

    // ---------------------------------------------------------------- episodes.ts parseEpisode

    public static string? SpecialType(string title)
    {
        var t = Replace(title, @"[._-]+");
        foreach (var (pattern, name) in new[] { (@"\b(?:ova|oad)\b", "ova"), (@"\brecap\b", "recap"), (@"\bmovie\b", "movie"), (@"\bspecials?\b", "special") })
            if (Match(t, pattern).Success) return name;
        return null;
    }

    public static EpisodeInfo ParseEpisode(string title)
    {
        var parsed = ParseBase(title);
        return parsed with { SpecialType = SpecialType(title), IsMultiSeason = parsed.IsMultiSeason ?? false };
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

    private static EpisodeInfo ParseBase(string t)
    {
        var m = Match(t, @"\b(\d{1,3})(?:st|nd|rd|th)\s+Season\s*[-–—]\s*(\d{1,4})\b");
        if (m.Success)
        {
            var result = Single(N(m), N(m, 2), true);
            var absolute = Match(t, @"\b(?:absolute\s*)?(?:episode|ep)\s*\.?\s*(\d{1,4})\b");
            return absolute.Success && N(absolute) != result.Episode
                ? result with { AbsoluteEpisode = N(absolute), Label = $"{result.Label} · absolute {N(absolute)}" } : result;
        }
        m = Match(t, @"\bS(?:easons?|eries)?[\s._]*\d{1,3}(?:\s*(?:[-–—~+&,]|\band\b|\bto\b|\bplus\b)\s*(?:S(?:easons?|eries)?[\s._]*)?\d{1,3}(?!\d))+");
        if (!m.Success) m = Match(t, @"\b(?:Seasons?|Series)\s+(\d{1,3}(?:\s+\d{1,3}){2,})\b");
        if (m.Success)
        {
            var nums = Regex.Matches(m.Value, @"\d{1,3}").Select(x => int.Parse(x.Value, CultureInfo.InvariantCulture)).ToArray();
            return Pack(nums[0], nums[^1]);
        }
        if (Match(t, @"\b(complete|batch|season\s*pack)\b").Success)
        {
            m = Match(t, @"\bS(?:eason)?\s*(\d{1,3})\b");
            return Pack(m.Success ? N(m) : null);
        }
        m = Match(t, @"\bS(\d{1,3})\s*E(\d{1,4})\b");
        if (!m.Success) m = Match(t, @"\b(\d{1,2})x(\d{1,4})\b");
        if (m.Success) return Single(N(m), N(m, 2), true);
        var season = Match(t, @"\bS(?:eason)?\s*(\d{1,3})\b");
        int? s = season.Success ? N(season) : null;
        m = Match(t, @"\b(?:episode|ep|e)\s*\.?\s*(\d{1,4})\b");
        if (m.Success) return Single(s, N(m));
        m = Match(t, @"[-–]\s*(\d{1,4})\s*(?=\.(?:mkv|mp4|avi|m4v|ts)\s*$|[\[(]|$|\b(?:480p|720p|1080p|2160p|4k|web-?dl|webrip|bluray|hdtv)\b)");
        if (m.Success && N(m) > 0 && N(m) is not (>= 1900 and <= 2100)) return Single(s, N(m));
        if (Match(t, @"^\s*\[[^\]]+\]").Success)
        {
            var after = Replace(t, @"^\s*\[[^\]]+\]\s*", "");
            m = Match(after, @"\s(\d{3,4})(?=\s|$|[\[(.])");
            if (m.Success && N(m) > 0 && N(m) is not (>= 1900 and <= 2100)
                && !Match(after[(m.Index + m.Length)..], @"^\s*(?:years?|yrs?|nen|ans?|days?)\b").Success
                && !(N(m) == 300 && Match(after, @"\bslime[\s._-]*300\b").Success))
                return Single(s, N(m));
        }
        m = Match(t, @"\bS(\d{1,3})\b(?!\s*E\d)");
        if (!m.Success) m = Match(t, @"\b(?:Seasons?|Series)[\s._]*(\d{1,3})\b");
        return m.Success ? Pack(N(m)) : new();
    }

    // ---------------------------------------------------------------- quality.ts releaseYear

    public static int? ReleaseYear(string title)
    {
        var t = Replace(title, @"[._]+");
        t = Replace(t, @"\b(?:\d{3,4}p|x?26[45]|h\.?26[45]|10bit|8bit|5\.1|7\.1|2\.0|ddp?5|dts|aac2|mp3|hdr10\+?|\d+(?:\.\d+)?\s*(?:gb|mb|gib|mib))\b");
        var matches = Regex.Matches(t, @"(?<![\d.])(?:19|20)\d{2}(?![\d.])");
        return matches.Select(m => int.Parse(m.Value, CultureInfo.InvariantCulture)).Where(y => y >= 1900 && y <= DateTime.UtcNow.Year + 2)
            .Select(y => (int?)y).LastOrDefault();
    }

    // ---------------------------------------------------------------- smart-category.ts (title-only subset)

    private const string AnimeGroup = @"\b(subsplease|erai-?raws|horrible\s*subs|judas|asw|ember|toonsouth|commie|doki|horriblesubs|nyaa|animetosho|ohys|gsd|fog|sallysubs|hanime|anime)\b";
    private const string AnimeSignal = @"\b(anime|ova|ona|oad|subbed|dubbed|dual\s*audio|vostfr|raws?|bd\s*box|tv\s*complete)\b";
    private const string Software = @"\b(windows\s*(7|8|10|11)|macos|mac\s*os|osx|software|installer|portable|keygen|nullsoft|nsis|msi\b|setup\.exe|winrar|7-?zip|vmware|virtualbox|parallels|photoshop|premiere|illustrator|lightroom|after\s*effects|indesign|acrobat|creative\s*cloud|autodesk|autocad|solidworks|sketchup|coreldraw|microsoft\s*office|office\s*20\d{2}|visio|visual\s*studio|intellij|pycharm|android\s*studio|xcode|final\s*cut|logic\s*pro|ableton|fl\s*studio|cubase|pro\s*tools|davinci|resolve|notion|obsidian|slack|zoom\s*client|chrome|firefox|edge\s*browser|adobe|plugin|plugins|addon|add-on|crack(?:ed)?|pre-?activated|activated|full\s*version|retail\s*multilingual)\b";
    private const string Games = @"\b(gog|steam|fitgirl|dodi|(?:fitgirl|dodi|gog|steam)\s*repack|pc\s*repack|nsw|xci|nsp|ps[345]|xbox|switch|roms?|iso\s*game|pc\s*game|game\s*of\s*the\s*year|goty|denuvo)\b";
    private const string Music = @"\b(flac|alac|320kbps|vinyl|discography|ost|soundtrack|album|single|lossless|cd\s*rip)\b";
    private const string Books = @"\b(epub|mobi|azw3?|djvu|ebook|e-book|audiobook|audio\s?book|unabridged|abridged|m4b|comic|cbr|cbz)\b";
    private const string SitePrefix = @"(?:^|[\s|])(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:org|com|net|info|to|me|tv|cc|io|co|ru|in|us|uk|eu|xyz|site|online)\b\s*[-–—:|]*\s*";
    private const string QualityTokens = @"\b(1080p|720p|480p|2160p|4k|uhd|hdr10?|dv|dolby\s*vision|hevc|x265|h\s*\.?\s*265|x264|h\s*\.?\s*264|av1|10-?bits?|8-?bits?|web-?dl|webrip|bluray|bdrip|bdr|brrip|hdtv|hdcam|remux|proper|repack|internal|limited|extended|theatrical|imax|aac(?:\s*[25]\.?\d)?|ac3|eac3|ddp?\.?(?:\s*[25]\.?\d)?|dts(?:-?hd)?|truehd|atmos|flac|mp3|opus|vorbis|dual(?:\s*audio)?|multi(?:\s*sub|audio)?|subs?|dub(?:bed)?|softsubs?|hardsubs?|nf|amzn|dsnp|hulu|atvp|pmtp|tver|cr|mkv|mp4|avi|ts|m2ts|webm|ch)\b";

    private static bool StrongTv(string title, EpisodeInfo ep) => ep.Season != null || ep.IsSeasonPack
        || Has(title, @"\bS\d{1,3}\s*E\d{1,4}\b|\b\d{1,2}x\d{1,4}\b");

    private static bool StrongSoftware(string title) => Has(title, Software)
        || Has(title, @"\bv\d{1,2}(?:\.\d{1,3}){1,3}\b") && Has(title, @"\b(fix|crack|keygen|activated|portable|installer|macos|windows|win\s*10|win\s*11)\b");

    /// <summary>detectContentKind({ title }): anime | movies | tv | music | games | software | books | other.</summary>
    public static string DetectContentKind(string title)
    {
        title ??= "";
        var hay = $"{title} ";
        var ep = ParseEpisode(title);
        var books = Has(hay, Books) && !Has(hay, @"\b(1080p|720p|bluray|webrip|x264|x265)\b");
        if (StrongTv(title, ep)) return books ? "books" : "tv";
        if (StrongSoftware(title)) return "software";
        if (Has(hay, Games)) return "games";
        if (Has(hay, Music) && !Has(hay, @"\b(game|iso|bluray|1080p|web-?dl|720p|2160p|x264|x265)\b")) return "music";
        if (books) return "books";
        var animeScore = Has(hay, AnimeGroup) || Has(hay, AnimeSignal) ? 2 : 0;
        if (Has(title, @"[\[(][A-Za-z0-9_-]{2,12}[\])]") && ep.Episode != null && ep.Season == null) animeScore++;
        if (Has(hay, @"\b(ova|ona|specials?)\b")) animeScore++;
        var tvScore = Has(hay, @"\b(complete\s*series|season\s*\d+)\b") ? 2 : 0;
        var app = Has(title, @"\bv\d{1,2}(?:\.\d{1,3}){1,3}\b") || Has(hay, @"\b(fix|portable|installer|keygen|pre-?activated)\b");
        var movieScore = 0;
        if (!app && Has(title, @"\b(19|20)\d{2}\b") && ep.Episode == null) movieScore++;
        if (!app && Has(hay, @"\b(bluray|bdrip|remux|web-?dl|hddvd|theatrical|imax)\b")) movieScore++;
        if (!app && Has(hay, @"\b(1080p|2160p|720p)\b") && !Has(hay, @"\bS\d{1,2}|season|episode|ep\s*\d")) movieScore++;
        return tvScore >= 2 && tvScore >= animeScore ? "tv" : animeScore >= 2 && animeScore > tvScore ? "anime"
            : movieScore >= 2 && movieScore > tvScore && movieScore > animeScore ? "movies" : tvScore >= 1 ? "tv"
            : animeScore >= 1 ? "anime" : movieScore >= 1 ? "movies" : "other";
    }

    // ---------------------------------------------------------------- filters.ts

    private static readonly Regex VideoExt = new(@"\.(?:mkv|mp4|avi|m4v|mov|wmv|flv|webm|ts|m2ts|mpg|mpeg|vob)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static bool IsSupportedVideoFileName(string name) => VideoExt.IsMatch(name.Replace('\\', '/'));

    // ---------------------------------------------------------------- smart-category.ts cleanTitle / showFolder

    public static string CutAtStructure(string title)
    {
        var m = Match(title, @"\bS\d{1,3}\s*E\d{1,4}\b|\b\d{1,2}x\d{1,4}\b|\bSeasons?\s*\d{1,3}\b|\bS\d{1,3}\b|\b(?:episode|ep)\s*\.?\s*\d{1,4}\b|(?<![A-Za-z])\bE\d{1,4}\b|[-–—]\s*\d{1,4}(?=\s|[\[(]|$)");
        return m.Success && m.Index > 0 ? title[..m.Index] : title;
    }

    private static string CleanTitle(string title)
    {
        var t = Replace(Replace(title, "&amp;", "and"), "&[a-z]+;");
        t = Replace(t, SitePrefix);
        t = Replace(t, @"(?:^|\s)(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:org|com|net|info|to|me|tv|cc|io)\b(?:\s*[-–—:|]+\s*|\s+)");
        t = Replace(t, @"[._]+");
        t = CutAtStructure(Replace(t, @"[\[(][^\])]{0,48}[\])]"));
        t = Replace(t, @"\bS\d{1,3}\s*E\d{1,4}\b|\b\d{1,2}x\d{1,4}\b|\bS\d{1,3}\b|\b(?:season|episode|ep|e)\s*\.?\s*\d{1,4}\b|[-–—]\s*\d{1,4}(?=\s|$)");
        t = Replace(t, @"\b(complete(?:\s*(?:series|season|collection))?|season\s*pack|batch|uncensored)\b|\b(19|20)\d{2}\b");
        t = Replace(t, QualityTokens);
        t = Replace(t, @"\b(?:dd|ddp|aac|dts)\s*\d(?:\s*\d)?\b|\b\d+\s+\d+\b|\b\d+(?:\.\d+)?\s*(?:ch|kbps|mbps|fps|bits?)\b");
        t = Replace(t, @"\s+(?:playWEB|ELiTE|PSA|Rapta|NTb|FLUX|KITSUNe|STC|BONE|RARBG|YTS|YIFY|SPARKS|FGT|DIMENSION|KILLERS|COAST|METCON|THRONE|EVO|ION10|XEBEC|ION265|TGx|EtHD|CtrlHD)(?:\s|$)");
        t = Regex.Replace(t, @"\s+[A-Za-z][A-Za-z0-9]{1,12}$", m =>
            Regex.IsMatch(m.Value.Trim(), "^[A-Z]{2,12}$|^[A-Z]{2,}[a-z]+[A-Z]") || Has(m.Value.Trim(), "^(?:x265|x264|h264|h265|web|dl|rip)$") ? " " : m.Value);
        t = Replace(Replace(t, @"[.\-–—|+]+"), @"\s+").Trim();
        if (t.Length > 0 && t == t.ToUpperInvariant() && Regex.IsMatch(t, "[A-Z]")) t = CultureInfo.InvariantCulture.TextInfo.ToTitleCase(t.ToLowerInvariant());
        return t;
    }

    private static string ShowFolder(string title)
    {
        var clean = CleanTitle(title);
        if (ParseEpisode(title).Episode is { } number) clean = Replace(clean, $@"\b0*{number}\b");
        clean = Replace(Replace(Replace(clean, @"\s+\d{1,4}$"), @"\b(complete|batch|pack|extras?|uncensored)\b"), @"\s+").Trim();
        return Sanitize(clean);
    }

    private static string Sanitize(string title)
    {
        var t = Replace(Replace(title, @"[<>:""/\\|?*\x00-\x1f]", ""), @"\s+").Trim().TrimEnd('.', ' ');
        if (Has(t, @"^www\.") || Has(t, @"^[a-z0-9-]+\.(org|com|net|info|io|to|me|cc|tv)\b") && !Has(t, @"\s")) return "";
        t = Replace(t, @"^[a-z0-9-]+\.(org|com|net)\s*[-–—:]?\s*", "").Trim();
        return t[..Math.Min(120, t.Length)];
    }

    // ---------------------------------------------------------------- work-identity.ts workIdentity

    public static string NormalizeKey(string value) =>
        Replace(Replace(Replace(value.ToLowerInvariant(), "['’`]", ""), @"[^\p{L}\p{N}]+"), @"\s+").Trim();

    private static string StripTrailingJunkNumber(string rawTitle, string cleaned)
    {
        if (!Match(rawTitle, @"[\])]\s*\d{1,4}\s*$").Success) return cleaned;
        var result = Replace(cleaned, @"\s+\d{1,4}$", "").Trim();
        return result.Length > 0 ? result : cleaned;
    }

    private static string TrackerPrefix(string title)
    {
        const string host = @"(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:com|org|net|info|to|me|tv|cc|io|is|se|su|ru|mx|xyz|site|online|club)(?::\d{2,5})?";
        var result = title.Trim();
        for (var i = 0; i < 3; i++)
        {
            var next = Replace(result, $@"^\s*[\[(]\s*{host}\s*[\])](?:\s*[-–—:|]+\s*)?|^\s*{host}\s*[-–—:|]+\s*", "").Trim();
            if (next == result || next.Length == 0) break;
            result = next;
        }
        return result;
    }

    private static string FilmName(string title, int? year)
    {
        var t = Replace(Replace(Replace(title, @"[._]+"), @"[\[(][^\])]{0,48}[\])]"), @"\s+").Trim();
        List<int> cuts = [];
        if (year != null && Match(t, $@"(?<![\d.]){year}(?![\d.])") is { Success: true, Index: > 0 } y) cuts.Add(y.Index);
        var quality = Match(t, @"\b(?:\d{3,4}p|4k|uhd|web-?dl|web-?rip|web|blu-?ray|bd-?rip|bd-?remux|remux|hdtv|dvd-?rip|hd-?rip|cam|ts|x26[45]|h\.?26[45]|hevc|avc|xvid|divx|hdr10\+?|hdr|dv|sdr|10bit|8bit|aac|ac3|eac3|ddp?5|dts(?:-hd)?|truehd|atmos|flac|mp3|imax|proper|repack|extended|unrated|remastered|directors?\.?cut)\b");
        var audio = Match(t, @"\b(?:dual[\s.-]?audio|multi[\s.-]?audio|dual|multi|e-?subs?|m-?subs?|hard-?subs?|soft-?subs?|dubbed|subbed|hindi|tamil|telugu|kannada|malayalam)\b");
        if (quality.Success && quality.Index > 0) cuts.Add(quality.Index);
        if (audio.Success && audio.Index > 0) cuts.Add(audio.Index);
        if (cuts.Count > 0) t = t[..cuts.Min()];
        t = Replace(t, @"[-–—_]+[a-z0-9]{2,20}$", "");
        t = Replace(t, @"\s*[\[({]\s*$", "");
        t = Replace(Replace(t, @"[\s\-–—_:|.]+$", ""), @"\s+").Trim();
        return StripTrailingJunkNumber(title, t);
    }

    public static ReleaseIdentity WorkIdentity(string title)
    {
        var release = TrackerPrefix(title ?? "");
        var ep = ParseEpisode(release);
        var series = ep.Season != null || ep.Episode != null || ep.IsSeasonPack || ep.IsMultiSeason == true;
        var year = series ? null : ReleaseYear(release);
        var name = series ? ShowFolder(release) : FilmName(release, year);
        if (series)
        {
            if (name.Length == 0) name = CutAtStructure(release).Trim();
            if (ReleaseYear(release) is { } y)
            {
                var stripped = Replace(Replace(name, $@"\b{y}\b"), @"\s+").Trim();
                if (stripped.Length > 0) name = stripped;
            }
        }
        if (name.Length == 0) name = release.Trim();
        var normalized = NormalizeKey(name);
        return new(series ? $"series:{normalized}" : $"film:{normalized}:{year}", name, year, series);
    }
}
