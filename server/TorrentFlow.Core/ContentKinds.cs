using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Core;

/// <summary>
/// The one release classifier (smart-category.ts detectContentKind): anime | movies | tv | music | games | software |
/// books | other. Search routing, smart sends, automation rules and library rows all ask it; a library row with only a
/// file name passes just the title. "Is this anime?" for catalog metadata is <see cref="AnimeIdentity"/>, which this calls.
/// </summary>
public static class ContentKinds
{
    private const string AnimeGroup = @"\b(subsplease|erai-?raws|horrible\s*subs|judas|asw|ember|toonsouth|commie|doki|horriblesubs|nyaa|animetosho|ohys|gsd|fog|sallysubs|hanime|anime)\b";
    private const string AnimeSignal = @"\b(anime|ova|ona|oad|subbed|dubbed|dual\s*audio|vostfr|raws?|bd\s*box|tv\s*complete)\b";
    private const string Software = @"\b(windows\s*(7|8|10|11)|macos|mac\s*os|osx|software|installer|portable|keygen|nullsoft|nsis|msi\b|setup\.exe|winrar|7-?zip|vmware|virtualbox|parallels|photoshop|premiere|illustrator|lightroom|after\s*effects|indesign|acrobat|creative\s*cloud|autodesk|autocad|solidworks|sketchup|coreldraw|microsoft\s*office|office\s*20\d{2}|visio|visual\s*studio|intellij|pycharm|android\s*studio|xcode|final\s*cut|logic\s*pro|ableton|fl\s*studio|cubase|pro\s*tools|davinci|resolve|notion|obsidian|slack|zoom\s*client|chrome|firefox|edge\s*browser|adobe|plugin|plugins|addon|add-on|crack(?:ed)?|pre-?activated|activated|full\s*version|retail\s*multilingual)\b";
    private const string Games = @"\b(gog|steam|fitgirl|dodi|(?:fitgirl|dodi|gog|steam)\s*repack|pc\s*repack|nsw|xci|nsp|ps[345]|xbox|switch|roms?|iso\s*game|pc\s*game|game\s*of\s*the\s*year|goty|denuvo)\b";
    private const string Music = @"\b(flac|alac|320kbps|vinyl|discography|ost|soundtrack|album|single|lossless|cd\s*rip)\b";
    private const string Books = @"\b(epub|mobi|azw3?|djvu|ebook|e-book|audiobook|audio\s?book|unabridged|abridged|m4b|comic|cbr|cbz)\b";
    private const string SitePrefix = @"(?:^|[\s|])(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:org|com|net|info|to|me|tv|cc|io|co|ru|in|us|uk|eu|xyz|site|online)\b\s*[-–—:|]*\s*";

    private static bool Has(string text, string pattern) => Regex.IsMatch(text, pattern, RegexOptions.IgnoreCase, TimeSpan.FromSeconds(1));
    private static string Replace(string value, string pattern, string replacement = " ") =>
        Regex.Replace(value, pattern, replacement, RegexOptions.IgnoreCase, TimeSpan.FromSeconds(1));

    public static bool StrongTv(string title, EpisodeInfo ep) => ep.Season != null || ep.IsSeasonPack
        || Has(title, @"\bS\d{1,3}\s*E\d{1,4}\b|\b\d{1,2}x\d{1,4}\b");

    public static bool StrongSoftware(string title, IReadOnlyList<string> tags) => Has($"{title} {string.Join(' ', tags)}", Software)
        || Has(title, @"\bv\d{1,2}(?:\.\d{1,3}){1,3}\b") && Has(title, @"\b(fix|crack|keygen|activated|portable|installer|macos|windows|win\s*10|win\s*11)\b");

    /// <summary>A loose comparison key for a release or catalog title: no site prefix, brackets, SxxEyy or quality tokens.</summary>
    public static string MatchKey(string name)
    {
        name = Replace(name.ToLowerInvariant(), SitePrefix);
        name = Replace(name, @"[\[\](){}]");
        name = Replace(name, @"\b(s\d{1,3}e\d{1,4}|s\d{1,3}|1080p|720p|480p|2160p|bluray|webrip|web-?dl|hevc|x265|x264|bone|yts)\b");
        return Replace(Replace(Replace(name, "['’`]", ""), @"[^\p{L}\p{N}]+"), @"\s+").Trim();
    }

    public static bool MetadataMatches(string title, MediaMetadata? metadata)
    {
        if (string.IsNullOrEmpty(metadata?.Title)) return false;
        var head = ReleaseNames.CutAtStructure(Replace(Replace(title, @"[._]+"), SitePrefix));
        var a = MatchKey(head.Length > 0 ? head : title); var b = MatchKey(metadata.Title);
        if (a.Length == 0 || b.Length == 0) return false;
        if (a == b || a.Contains(b) || b.Contains(a)) return true;
        var aTokens = a.Split(' ').Where(t => t.Length > 2).ToArray();
        var bTokens = b.Split(' ').Where(t => t.Length > 2).ToArray();
        return aTokens.Length > 0 && bTokens.Length > 0 && bTokens.Count(aTokens.Contains) / (double)bTokens.Length >= .6;
    }

    /// <summary>
    /// A film rather than a series: catalog type movie or an AniList "MOVIE" format; with no catalog verdict, a release
    /// with no season, episode or batch that names a year or "movie".
    /// </summary>
    public static bool IsFilm(string title, MediaMetadata? metadata)
    {
        if (metadata?.MediaType == "movie" || string.Equals(metadata?.Format, "MOVIE", StringComparison.OrdinalIgnoreCase)) return true;
        if (metadata is { MediaType: "tv" } || metadata?.Format != null) return false;
        var ep = ReleaseEpisodeParser.Parse(title);
        return ep is { Season: null, Episode: null, AbsoluteEpisode: null, IsBatch: false, IsSeasonPack: false }
            && Has(title, @"\b((19|20)\d{2}|movie|film|gekijou?ban)\b");
    }

    private static bool Anime(string title, string hay, EpisodeInfo ep, MediaMetadata? metadata) =>
        Has(hay, AnimeSignal) || Has(hay, AnimeGroup) || AnimeIdentity.IsAnime(metadata)
        || Has(title, @"[\[(][A-Za-z0-9_-]{2,12}[\])]") && ep.Episode != null && ep.Season == null;

    /// <summary>A search result, with its site category, source and enrichment.</summary>
    public static string Detect(TorrentResult r, string? searchCategory) =>
        Detect(r.Title, r.Tags, r.Source, r.Category, r.Metadata, searchCategory);

    /// <summary>
    /// The kind of a release. Anime sources decide first (a site's anime category, an anime metadata source, a fansub
    /// group's leading tag); a title alone (a library file name) gets the same rules with nothing else to go on.
    /// </summary>
    public static string Detect(string title, IReadOnlyList<string>? tags = null, string? source = null, string? siteCategory = null,
        MediaMetadata? meta = null, string? searchCategory = null)
    {
        title ??= ""; tags ??= [];
        var hay = $"{title} {string.Join(' ', tags)}";
        var ep = ReleaseEpisodeParser.Parse(title);
        var strongTv = StrongTv(title, ep);
        var liveAction = Has(title, @"\blive\s*action\b") || (siteCategory?.Contains("live action", StringComparison.OrdinalIgnoreCase) ?? false);
        // A site's anime category (nyaa "Anime - ...", Torznab 5070) is decisive, the same as an anime metadata source.
        if (AnimeIdentity.IsAnimeSiteCategory(siteCategory) && !liveAction) return "anime";
        var books = Has(hay, Books) && !Has(hay, @"\b(1080p|720p|bluray|webrip|x264|x265)\b");
        var belongs = MetadataMatches(title, meta);
        bool AnimeMetadata() => AnimeIdentity.IsAnime(meta) || meta?.MediaType == "tv"
            && (meta.Genres?.Any(g => g.Equals("animation", StringComparison.OrdinalIgnoreCase) || g.Equals("anime", StringComparison.OrdinalIgnoreCase)) ?? false)
            && Anime(title, hay, ep, meta);
        if (strongTv)
        {
            if (books) return "books";
            if (belongs && AnimeMetadata()) return "anime";
            if (source == "nyaa" && !liveAction) return "anime";
            // A fansub group's leading tag ("[SubsPlease] Show - S01E05") is an anime release wherever it was found.
            if (!belongs && !liveAction && Has(title, $@"^\s*\[\s*{AnimeGroup}\s*\]")) return "anime";
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
        if (source == "yts") return "movies";
        if (source == "nyaa")
        {
            // Nyaa is an anime site. Its Live Action category (or a live-action or drama release) is a film or a show;
            // with no category known, a dated film release with no anime sign at all is a plain film.
            if (liveAction || Has(title, @"\bdrama\b")) return ep.Episode == null && Has(title, @"\b(19|20)\d{2}\b") ? "movies" : "tv";
            if (Has(hay, Music)) return "music";
            if (siteCategory == null && Has(title, @"\b(19|20)\d{2}\b") && Has(hay, @"\b(bluray|bdrip|remux|web-?dl|hdtv)\b") && ep.Episode == null
                && !Has(hay, AnimeGroup) && !AnimeMetadata()) return "movies";
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
        || StrongTv(r.Title, ReleaseEpisodeParser.Parse(r.Title)) && kind == "tv" || r.Source == "yts" && kind == "movies" || r.Source == "nyaa" && kind == "anime" ? "high"
        : kind == "other" ? "low" : "medium";
}
