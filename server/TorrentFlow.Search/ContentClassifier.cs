using System.Globalization;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Search;
using static TorrentFlow.Search.EpisodeParser;

namespace TorrentFlow.Search;

public static class ContentClassifier
{
    private const string AnimeGroup = @"\b(subsplease|erai-?raws|horrible\s*subs|judas|asw|ember|toonsouth|commie|doki|horriblesubs|nyaa|animetosho|ohys|gsd|fog|sallysubs|hanime|anime)\b";
    private const string AnimeSignal = @"\b(anime|ova|ona|oad|subbed|dubbed|dual\s*audio|vostfr|raws?|bd\s*box|tv\s*complete)\b";
    private const string Software = @"\b(windows\s*(7|8|10|11)|macos|mac\s*os|osx|software|installer|portable|keygen|nullsoft|nsis|msi\b|setup\.exe|winrar|7-?zip|vmware|virtualbox|parallels|photoshop|premiere|illustrator|lightroom|after\s*effects|indesign|acrobat|creative\s*cloud|autodesk|autocad|solidworks|sketchup|coreldraw|microsoft\s*office|office\s*20\d{2}|visio|visual\s*studio|intellij|pycharm|android\s*studio|xcode|final\s*cut|logic\s*pro|ableton|fl\s*studio|cubase|pro\s*tools|davinci|resolve|notion|obsidian|slack|zoom\s*client|chrome|firefox|edge\s*browser|adobe|plugin|plugins|addon|add-on|crack(?:ed)?|pre-?activated|activated|full\s*version|retail\s*multilingual)\b";
    private const string Games = @"\b(gog|steam|fitgirl|dodi|(?:fitgirl|dodi|gog|steam)\s*repack|pc\s*repack|nsw|xci|nsp|ps[345]|xbox|switch|roms?|iso\s*game|pc\s*game|game\s*of\s*the\s*year|goty|denuvo)\b";
    private const string Music = @"\b(flac|alac|320kbps|vinyl|discography|ost|soundtrack|album|single|lossless|cd\s*rip)\b";
    private const string Books = @"\b(epub|mobi|azw3?|djvu|ebook|e-book|audiobook|audio\s?book|unabridged|abridged|m4b|comic|cbr|cbz)\b";
    private const string SitePrefix = @"(?:^|[\s|])(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:org|com|net|info|to|me|tv|cc|io|co|ru|in|us|uk|eu|xyz|site|online)\b\s*[-–—:|]*\s*";
    private const string QualityTokens = @"\b(1080p|720p|480p|2160p|4k|uhd|hdr10?|dv|dolby\s*vision|hevc|x265|h\s*\.?\s*265|x264|h\s*\.?\s*264|av1|10-?bits?|8-?bits?|web-?dl|webrip|bluray|bdrip|bdr|brrip|hdtv|hdcam|remux|proper|repack|internal|limited|extended|theatrical|imax|aac(?:\s*[25]\.?\d)?|ac3|eac3|ddp?\.?(?:\s*[25]\.?\d)?|dts(?:-?hd)?|truehd|atmos|flac|mp3|opus|vorbis|dual(?:\s*audio)?|multi(?:\s*sub|audio)?|subs?|dub(?:bed)?|softsubs?|hardsubs?|nf|amzn|dsnp|hulu|atvp|pmtp|tver|cr|mkv|mp4|avi|ts|m2ts|webm|ch)\b";
    private static bool Has(string text, string pattern) => Match(text, pattern).Success;
    public static bool StrongTv(string title, EpisodeInfo ep) => ep.Season != null || ep.IsSeasonPack
        || Has(title, @"\bS\d{1,3}\s*E\d{1,4}\b|\b\d{1,2}x\d{1,4}\b");
    public static bool StrongSoftware(string title, string[] tags) => Has($"{title} {string.Join(' ', tags)}", Software)
        || Has(title, @"\bv\d{1,2}(?:\.\d{1,3}){1,3}\b") && Has(title, @"\b(fix|crack|keygen|activated|portable|installer|macos|windows|win\s*10|win\s*11)\b");
    private static string Normalize(string name)
    {
        name = Replace(name.ToLowerInvariant(), SitePrefix);
        name = Replace(name, @"[\[\](){}]");
        name = Replace(name, @"\b(s\d{1,3}e\d{1,4}|s\d{1,3}|1080p|720p|480p|2160p|bluray|webrip|web-?dl|hevc|x265|x264|bone|yts)\b");
        return Replace(Replace(Replace(name, "['’`]", ""), @"[^\p{L}\p{N}]+"), @"\s+").Trim();
    }
    public static bool MetadataMatches(string title, MediaMetadata? metadata)
    {
        if (string.IsNullOrEmpty(metadata?.Title)) return false;
        var head = CutAtStructure(Replace(Replace(title, @"[._]+"), SitePrefix));
        var a = Normalize(head.Length > 0 ? head : title); var b = Normalize(metadata.Title);
        if (a.Length == 0 || b.Length == 0) return false;
        if (a == b || a.Contains(b) || b.Contains(a)) return true;
        var aTokens = a.Split(' ').Where(t => t.Length > 2).ToArray();
        var bTokens = b.Split(' ').Where(t => t.Length > 2).ToArray();
        return aTokens.Length > 0 && bTokens.Length > 0 && bTokens.Count(aTokens.Contains) / (double)bTokens.Length >= .6;
    }
    private static bool Anime(string title, string hay, EpisodeInfo ep, MediaMetadata? metadata) =>
        Has(hay, AnimeSignal) || Has(hay, AnimeGroup) || metadata is { Source: "anilist", MediaType: "anime" }
        || metadata?.OriginalLanguage?.ToLowerInvariant() == "ja" || (metadata?.OriginCountry?.Any(c => c.Equals("JP", StringComparison.OrdinalIgnoreCase)) ?? false)
        || Has(title, @"[\[(][A-Za-z0-9_-]{2,12}[\])]") && ep.Episode != null && ep.Season == null;
    public static string Detect(TorrentResult r, string? searchCategory)
    {
        var title = r.Title; var tags = r.Tags; var hay = $"{title} {string.Join(' ', tags)}";
        var ep = Parse(title); var meta = r.Metadata;
        var strongTv = StrongTv(title, ep);
        var books = Has(hay, Books) && !Has(hay, @"\b(1080p|720p|bluray|webrip|x264|x265)\b");
        var belongs = MetadataMatches(title, meta);
        bool AnimeMetadata() => meta?.MediaType == "anime" || meta?.MediaType == "tv"
            && (meta.Genres?.Any(g => g.Equals("animation", StringComparison.OrdinalIgnoreCase) || g.Equals("anime", StringComparison.OrdinalIgnoreCase)) ?? false)
            && Anime(title, hay, ep, meta);
        if (strongTv)
        {
            if (books) return "books";
            if (belongs && AnimeMetadata()) return "anime";
            if (r.Source == "nyaa" && !Has(title, @"\blive\s*action\b")) return "anime";
            if (searchCategory == "anime" && Anime(title, hay, ep, meta)) return "anime";
            return "tv";
        }
        if (StrongSoftware(title, tags)) return "software";
        if (Has(hay, Games)) return "games";
        if (Has(hay, Music) && !Has(hay, @"\b(game|iso|bluray|1080p|web-?dl|720p|2160p|x264|x265)\b")) return "music";
        if (books) return "books";
        if (belongs)
        {
            if (AnimeMetadata()) return "anime";
            if (meta?.MediaType == "movie") return "movies";
            if (meta?.MediaType == "tv") return "tv";
        }
        if (r.Source == "yts") return "movies";
        if (r.Source == "nyaa")
        {
            if (Has(title, @"\b(live\s*action|drama)\b")) return "tv";
            if (Has(hay, Music)) return "music";
            if (Has(title, @"\b(19|20)\d{2}\b") && Has(hay, @"\b(bluray|bdrip|remux|web-?dl|hdtv)\b") && ep.Episode == null) return "movies";
            return "anime";
        }
        var video = Has(hay, @"\b(?:2160p|1080p|720p|576p|480p|blu[-_. ]?ray|bdrip|brrip|remux|web[-_. ]?dl|webrip|hdtv|dvdrip|hdrip|x264|x265|h\.?264|h\.?265|hevc|xvid|divx|avc)\b");
        if (!video && searchCategory is "apps" or "software" or "games" or "music" or "books") return searchCategory == "apps" ? "software" : searchCategory;
        if (searchCategory is "anime" or "movies" or "tv") return searchCategory;
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
    public static string Confidence(TorrentResult r, string kind) =>
        kind == "software" && StrongSoftware(r.Title, r.Tags) || kind == "games" && Has($"{r.Title} {string.Join(' ', r.Tags)}", Games)
        || r.Metadata?.MediaType != null && MetadataMatches(r.Title, r.Metadata)
        || StrongTv(r.Title, Parse(r.Title)) && kind == "tv" || r.Source == "yts" && kind == "movies" || r.Source == "nyaa" && kind == "anime" ? "high"
        : kind == "other" ? "low" : "medium";
    public static string CategoryLabel(string kind, string[]? categories)
    {
        string[] aliases = kind switch
        {
            "anime" => ["Anime", "アニメ", "animation"], "movies" => ["Movies", "Movie", "Films", "Film", "Cinema"],
            "tv" => ["TV", "Television", "Series", "Shows", "TV Shows"], "music" => ["Music", "Audio", "FLAC", "MP3", "Albums"],
            "games" => ["Games", "Gaming", "PC Games", "Nintendo", "Xbox", "PS4", "PS5"], "software" => ["Software", "Apps", "Applications", "Programs"],
            "books" => ["Books", "eBooks", "Ebook", "Comics", "Manga"], _ => ["Other", "Misc", "General"]
        };
        foreach (var alias in aliases)
            if (categories?.FirstOrDefault(c => c.Equals(alias, StringComparison.OrdinalIgnoreCase)) is { } exact) return exact;
        foreach (var alias in aliases)
            if (categories?.FirstOrDefault(c => c.Contains(alias, StringComparison.OrdinalIgnoreCase)) is { } partial) return partial;
        return aliases[0];
    }
    public static string CutAtStructure(string title)
    {
        var m = Match(title, @"\bS\d{1,3}\s*E\d{1,4}\b|\b\d{1,2}x\d{1,4}\b|\bSeasons?\s*\d{1,3}\b|\bS\d{1,3}\b|\b(?:episode|ep)\s*\.?\s*\d{1,4}\b|(?<![A-Za-z])\bE\d{1,4}\b|[-–—]\s*\d{1,4}(?=\s|[\[(]|$)");
        return m.Success && m.Index > 0 ? title[..m.Index] : title;
    }
    public static string CleanTitle(string title)
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
    public static string ShowFolder(string title, MediaMetadata? metadata = null)
    {
        var clean = CleanTitle(title);
        if (Parse(title).Episode is { } number) clean = Replace(clean, $@"\b0*{number}\b");
        clean = Replace(Replace(Replace(clean, @"\s+\d{1,4}$"), @"\b(complete|batch|pack|extras?|uncensored)\b"), @"\s+").Trim();
        clean = Sanitize(clean);
        if (!string.IsNullOrWhiteSpace(metadata?.Title))
        {
            var metaFolder = Sanitize(metadata.Title);
            var a = Normalize(clean.Length > 0 ? clean : CutAtStructure(title)); var b = Normalize(metaFolder);
            if (a.Length > 0 && b.Length > 0 && (a == b || a.Contains(b) || b.Contains(a) || WorkIdentityParser.MetadataAgrees(clean, metadata))) return metaFolder;
        }
        return clean;
    }
    private static string Sanitize(string title)
    {
        var t = Replace(Replace(title, @"[<>:""/\\|?*\x00-\x1f]", ""), @"\s+").Trim().TrimEnd('.', ' ');
        if (Has(t, @"^www\.") || Has(t, @"^[a-z0-9-]+\.(org|com|net|info|io|to|me|cc|tv)\b") && !Has(t, @"\s")) return "";
        t = Replace(t, @"^[a-z0-9-]+\.(org|com|net)\s*[-–—:]?\s*", "").Trim();
        return t[..Math.Min(120, t.Length)];
    }
}
