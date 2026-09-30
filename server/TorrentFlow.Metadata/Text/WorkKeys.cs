using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Text;

namespace TorrentFlow.Metadata.Text;

/// <summary>Port of src/components/title/work-key.ts (the parts server routes use).</summary>
public static partial class WorkKeys
{
    public const string TitleHref = "/title";

    [GeneratedRegex(@"^(?:[A-Za-z0-9\-._~]|%[0-9A-Fa-f]{2})*$")] private static partial Regex SafeSegment();

    public static string Slugify(string name) => WorkKeySlug.Slugify(name);

    public static string WorkKeyFor(string name, int? year) => WorkKeySlug.WorkKeyFor(name, year);

    public static List<string> Aliases(string key) => [.. WorkKeySlug.Aliases(key)];

    public static string EncodeKeySegment(string key) => SafeSegment().IsMatch(key ?? "") ? key ?? "" : TextUtil.EncodeUriComponent(key ?? "");

    public sealed record TitleLink(string Title, int? Year = null, string? MediaType = null, string? Provider = null, string? ProviderId = null,
        string? SourceType = null, string? Format = null, bool? Series = null);

    public static string TitlePath(string key, TitleLink p)
    {
        var search = new List<(string, string)>();
        var title = p.Title?.Trim() ?? "";
        if (title.Length > 0) search.Add(("t", title));
        if (p.Year is { } y && y != 0) search.Add(("y", y.ToString(CultureInfo.InvariantCulture)));
        var mediaType = p.MediaType?.Trim();
        if (!string.IsNullOrEmpty(mediaType)) search.Add(("type", mediaType));
        var providerId = p.ProviderId?.Trim();
        var sourceType = p.SourceType?.Trim();
        if (!string.IsNullOrEmpty(p.Provider) && !string.IsNullOrEmpty(providerId) && !string.IsNullOrEmpty(sourceType) && p.Series != null &&
            (p.Provider != "anilist" || !string.IsNullOrEmpty(p.Format)))
        {
            search.Add(("provider", p.Provider));
            search.Add(("providerId", providerId));
            search.Add(("sourceType", sourceType));
            if (!string.IsNullOrEmpty(p.Format)) search.Add(("format", p.Format));
            search.Add(("series", p.Series.Value ? "1" : "0"));
        }
        var qs = TextUtil.BuildQuery(search);
        var segment = EncodeKeySegment(key);
        return qs.Length > 0 ? $"{TitleHref}/{segment}?{qs}" : $"{TitleHref}/{segment}";
    }
}

