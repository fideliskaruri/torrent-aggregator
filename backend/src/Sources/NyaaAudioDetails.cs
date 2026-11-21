using System.Collections.Immutable;
using System.Text.RegularExpressions;
using AngleSharp.Html.Parser;
using TorrentFlow.Domain;

namespace TorrentFlow.Sources;

internal static partial class NyaaAudioDetails
{
    internal static string? ListingId(string sourceItemId)
    {
        var path = sourceItemId.StartsWith('/') ? sourceItemId :
            Uri.TryCreate(sourceItemId, UriKind.Absolute, out var uri) ? uri.AbsolutePath : sourceItemId;
        var match = Listing().Match(path);
        return match.Success ? match.Groups["id"].Value : null;
    }

    internal static SourceAudioEvidence? Parse(string html, string sourceItemId, string hash)
    {
        // Nyaa's upstream view template renders the infohash in a labelled row and the
        // uploader's escaped Markdown in #torrent-description. Comments are a separate panel.
        using var page = new HtmlParser().ParseDocument(html);
        var description = page.QuerySelector("#torrent-description");
        var hashRow = page.QuerySelectorAll(".row").FirstOrDefault(row =>
            row.Children.Any(cell => cell.TextContent.Trim() == "Info hash:"));
        if (description is null || hashRow?.QuerySelector("kbd")?.TextContent.Trim()
                .Equals(hash, StringComparison.OrdinalIgnoreCase) != true)
            return null;
        return new("nyaa", sourceItemId, hash, TrackLanguages(description.TextContent));
    }

    private static ImmutableArray<string> TrackLanguages(string description)
    {
        var languages = new HashSet<string>(StringComparer.Ordinal);
        var blockLanguages = new HashSet<string>(StringComparer.Ordinal);
        var inAudioBlock = false;
        var supplementaryBlock = false;
        var hasAudioField = false;
        var generalHeadings = 0;
        var mediaNames = 0;
        foreach (var raw in description.Split('\n'))
        {
            if (raw.Length > 512) continue;
            var line = raw.Trim().TrimStart('#', '*', '-', '|', '>', '\u0060', ' ', '\t').Replace("**", "");
            if (EpisodeHeading().IsMatch(line)) return ["und"];
            if (line.Equals("General", StringComparison.OrdinalIgnoreCase) && ++generalHeadings > 1 ||
                MediaName().IsMatch(line) && ++mediaNames > 1)
                return ["und"];
            if (line.Length == 0 || MediaInfoHeader().IsMatch(line))
            {
                FinishBlock();
                inAudioBlock = line.StartsWith("Audio", StringComparison.OrdinalIgnoreCase);
                hasAudioField |= inAudioBlock;
                continue;
            }
            if (inAudioBlock)
            {
                var mediaInfoLanguage = LanguageField().Match(line);
                if (mediaInfoLanguage.Success)
                {
                    AddTags(blockLanguages, mediaInfoLanguage.Groups["value"].Value);
                    continue;
                }
                if (TrackTitle().Match(line) is { Success: true } title &&
                    AnimeAudioPolicy.IsSupplementaryAudio(title.Groups["value"].Value))
                    supplementaryBlock = true;
            }
            var field = AudioField().Match(line);
            if (!field.Success) continue;
            hasAudioField = true;
            AddTags(languages, field.Groups["value"].Value);
        }
        FinishBlock();
        return hasAudioField && languages.Count == 0 ? ["und"] : [.. languages.Order(StringComparer.Ordinal)];

        void FinishBlock()
        {
            if (inAudioBlock && !supplementaryBlock)
            {
                if (blockLanguages.Count == 0) languages.Add("und");
                else languages.UnionWith(blockLanguages);
            }
            blockLanguages.Clear();
            supplementaryBlock = false;
        }

        static void AddTags(HashSet<string> destination, string value) =>
            destination.UnionWith(AnimeAudioPolicy.AudioFieldLanguages(value));
    }

    [GeneratedRegex(@"^(?:/view/)?(?<id>[1-9][0-9]{0,9})/?$", RegexOptions.CultureInvariant)]
    private static partial Regex Listing();

    [GeneratedRegex(@"^(?:audio(?:\s*(?:tracks?|streams?))?(?:\s*#?\d{1,2})?|a[12])\s*\.*\s*[:=|\-]\s*(?<value>.*)$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex AudioField();

    [GeneratedRegex(@"^(?:audio|video|text|subtitles?|menu|image|general|other)(?:\s*#\d+)?$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex MediaInfoHeader();

    [GeneratedRegex(@"^language\s*:\s*(?<value>.*)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex LanguageField();

    [GeneratedRegex(@"^title\s*:\s*(?<value>.*)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex TrackTitle();

    [GeneratedRegex(@"^[\[(]?\s*(?:(?:episodes?|eps?\.?)\s*#?\s*\d+|(?:s\d+\s*)?e\d+)\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex EpisodeHeading();

    [GeneratedRegex(@"^complete name\s*:", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex MediaName();
}
