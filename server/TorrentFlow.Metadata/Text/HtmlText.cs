using System.Globalization;
using System.Text.RegularExpressions;

namespace TorrentFlow.Metadata.Text;

/// <summary>Port of <c>stripHtmlToText</c> (src/lib/metadata/keyless-detail.ts).</summary>
public static partial class HtmlText
{
    private static readonly Dictionary<string, string> NamedEntities = new(StringComparer.Ordinal)
    {
        ["amp"] = "&", ["lt"] = "<", ["gt"] = ">", ["quot"] = "\"", ["apos"] = "'", ["nbsp"] = " ", ["hellip"] = "…",
        ["mdash"] = "—", ["ndash"] = "–", ["rsquo"] = "\u2019", ["lsquo"] = "\u2018", ["ldquo"] = "\u201c", ["rdquo"] = "\u201d",
    };

    [GeneratedRegex(@"<br\s*/?>", RegexOptions.IgnoreCase)] private static partial Regex Br();
    [GeneratedRegex(@"</(p|div|li|h[1-6])>", RegexOptions.IgnoreCase)] private static partial Regex BlockEnd();
    [GeneratedRegex(@"<li\b[^>]*>", RegexOptions.IgnoreCase)] private static partial Regex ListItem();
    [GeneratedRegex(@"<[^>]*>")] private static partial Regex Tag();
    [GeneratedRegex(@"&#(\d+);")] private static partial Regex DecimalEntity();
    [GeneratedRegex(@"&#x([0-9a-f]+);", RegexOptions.IgnoreCase)] private static partial Regex HexEntity();
    [GeneratedRegex(@"&([a-z]+);", RegexOptions.IgnoreCase)] private static partial Regex NamedEntity();
    [GeneratedRegex("[ \t\u00a0]+")] private static partial Regex Spaces();
    [GeneratedRegex(@"\s*\n\s*")] private static partial Regex LineBreak();
    [GeneratedRegex(@"\n{3,}")] private static partial Regex BlankLines();

    /// <summary>
    /// A provider's HTML summary (TVmaze's <c>&lt;p&gt;…&lt;/p&gt;</c>) as plain text. Block tags become newlines, other tags
    /// are dropped, and entities are decoded after tag removal so an encoded tag in the prose is never re-read as markup.
    /// </summary>
    public static string? StripToText(string? html)
    {
        if (html is null) return null;
        var text = Br().Replace(html, "\n");
        text = BlockEnd().Replace(text, "\n");
        text = ListItem().Replace(text, "\n");
        text = Tag().Replace(text, "");
        text = DecimalEntity().Replace(text, m => CodePoint(double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture)));
        text = HexEntity().Replace(text, m => long.TryParse(m.Groups[1].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var n) ? CodePoint(n) : "");
        text = NamedEntity().Replace(text, m => NamedEntities.TryGetValue(m.Groups[1].Value.ToLowerInvariant(), out var v) ? v : m.Value);
        text = Spaces().Replace(text, " ");
        text = LineBreak().Replace(text, "\n");
        text = BlankLines().Replace(text, "\n\n").Trim();
        return text.Length == 0 ? null : text;
    }

    private static string CodePoint(double value) =>
        value > 0 && value <= 0x10ffff && !(value is >= 0xd800 and <= 0xdfff) ? char.ConvertFromUtf32((int)value) : "";
}
