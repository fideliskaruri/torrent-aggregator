using System.Globalization;
using System.Xml;
using System.Xml.Linq;
using System.Text.RegularExpressions;

namespace TorrentFlow.Sources;

internal static class FeedXml
{
    internal static XDocument Load(string xml)
    {
        var end = xml.LastIndexOf("</rss>", StringComparison.OrdinalIgnoreCase);
        if (end >= 0 && xml[(end + 6)..].TrimStart().StartsWith("<script", StringComparison.OrdinalIgnoreCase))
            xml = xml[..(end + 6)];
        using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 8 * 1024 * 1024
        });
        return XDocument.Load(reader);
    }

    internal static string EscapeBareTitleAmpersands(string xml) =>
        Regex.Replace(xml, @"<title>([^<]*)</title>", title =>
            "<title>" + Regex.Replace(title.Groups[1].Value,
                @"&(?!(?:amp|lt|gt|apos|quot|#[0-9]+|#x[0-9a-fA-F]+);)", "&amp;") + "</title>");

    internal static XElement[] Items(XDocument document)
    {
        if (document.Root?.Name.LocalName != "rss" ||
            !document.Descendants().Any(e => e.Name.LocalName == "channel"))
            throw new SourceException("SourceFailure", "The source did not return RSS.");
        return document.Descendants().Where(e => e.Name.LocalName == "item").ToArray();
    }

    internal static string Value(XElement item, string name) =>
        item.Elements().FirstOrDefault(e => e.Name.LocalName == name)?.Value.Trim() ?? "";

    internal static int? Count(string text) =>
        int.TryParse(text.Replace(",", ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) && n >= 0 ? n : null;
    internal static long? Bytes(string text) =>
        long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) && n >= 0 ? n : null;
}
