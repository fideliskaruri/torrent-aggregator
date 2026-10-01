using System.Text.RegularExpressions;
using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Metadata.Browse;

/// <summary>smart-category.ts detectContentKind, title-only subset (no tags, source or metadata) for library rows.</summary>
public static class ReleaseKinds
{
    private static bool Has(string text, string pattern) => Regex.IsMatch(text, pattern, RegexOptions.IgnoreCase, TimeSpan.FromSeconds(1));

    private const string AnimeGroup = @"\b(subsplease|erai-?raws|horrible\s*subs|judas|asw|ember|toonsouth|commie|doki|horriblesubs|nyaa|animetosho|ohys|gsd|fog|sallysubs|hanime|anime)\b";
    private const string AnimeSignal = @"\b(anime|ova|ona|oad|subbed|dubbed|dual\s*audio|vostfr|raws?|bd\s*box|tv\s*complete)\b";
    private const string Software = @"\b(windows\s*(7|8|10|11)|macos|mac\s*os|osx|software|installer|portable|keygen|nullsoft|nsis|msi\b|setup\.exe|winrar|7-?zip|vmware|virtualbox|parallels|photoshop|premiere|illustrator|lightroom|after\s*effects|indesign|acrobat|creative\s*cloud|autodesk|autocad|solidworks|sketchup|coreldraw|microsoft\s*office|office\s*20\d{2}|visio|visual\s*studio|intellij|pycharm|android\s*studio|xcode|final\s*cut|logic\s*pro|ableton|fl\s*studio|cubase|pro\s*tools|davinci|resolve|notion|obsidian|slack|zoom\s*client|chrome|firefox|edge\s*browser|adobe|plugin|plugins|addon|add-on|crack(?:ed)?|pre-?activated|activated|full\s*version|retail\s*multilingual)\b";
    private const string Games = @"\b(gog|steam|fitgirl|dodi|(?:fitgirl|dodi|gog|steam)\s*repack|pc\s*repack|nsw|xci|nsp|ps[345]|xbox|switch|roms?|iso\s*game|pc\s*game|game\s*of\s*the\s*year|goty|denuvo)\b";
    private const string Music = @"\b(flac|alac|320kbps|vinyl|discography|ost|soundtrack|album|single|lossless|cd\s*rip)\b";
    private const string Books = @"\b(epub|mobi|azw3?|djvu|ebook|e-book|audiobook|audio\s?book|unabridged|abridged|m4b|comic|cbr|cbz)\b";

    private static bool StrongTv(string title, EpisodeInfo ep) => ep.Season != null || ep.IsSeasonPack
        || Has(title, @"\bS\d{1,3}\s*E\d{1,4}\b|\b\d{1,2}x\d{1,4}\b");

    private static bool StrongSoftware(string title) => Has(title, Software)
        || Has(title, @"\bv\d{1,2}(?:\.\d{1,3}){1,3}\b") && Has(title, @"\b(fix|crack|keygen|activated|portable|installer|macos|windows|win\s*10|win\s*11)\b");

    /// <summary>detectContentKind({ title }): anime | movies | tv | music | games | software | books | other.</summary>
    public static string DetectContentKind(string title)
    {
        title ??= "";
        var hay = $"{title} ";
        var ep = ReleaseEpisodeParser.Parse(title);
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
}
