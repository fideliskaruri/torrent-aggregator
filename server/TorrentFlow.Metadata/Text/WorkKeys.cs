using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace TorrentFlow.Metadata.Text;

/// <summary>Port of src/components/title/work-key.ts (the parts server routes use).</summary>
public static partial class WorkKeys
{
    public const string TitleHref = "/title";

    [GeneratedRegex(@"[^a-z0-9]+")] private static partial Regex NonSlug();
    [GeneratedRegex(@"^-+|-+$")] private static partial Regex EdgeDashes();
    [GeneratedRegex(@"-\d+(?:-\d+)?-?[kmgt]i?b(?:-(?!(?:19|20)\d{2}$)[a-z0-9]{2,20})?(?=-(?:19|20)\d{2}$|$)")] private static partial Regex LegacySizeGroup();
    [GeneratedRegex(@"^(?:[A-Za-z0-9\-._~]|%[0-9A-Fa-f]{2})*$")] private static partial Regex SafeSegment();

    public static string Slugify(string name)
    {
        var d = TextUtil.CompatibilityFold(name ?? "", true);
        var sb = new StringBuilder();
        foreach (var ch in d)
        {
            if (ch is >= '\u0300' and <= '\u036f') continue;
            if (ch is '\'' or '’' or '`') continue;
            sb.Append(ch);
        }
        var slug = EdgeDashes().Replace(NonSlug().Replace(sb.ToString().ToLowerInvariant(), "-"), "");
        if (slug.Length > 0) return slug;
        var compact = Regex.Replace((name ?? "").Trim().ToLowerInvariant(), @"\s+", "-");
        return compact.Length > 0 ? TextUtil.EncodeUriComponent(compact) : "";
    }

    public static string WorkKeyFor(string name, int? year)
    {
        var slug = Slugify(name ?? "");
        if (slug.Length == 0) return "";
        return year is { } y && y != 0 ? $"{slug}-{y}" : slug;
    }

    public static List<string> Aliases(string key)
    {
        var wanted = (key ?? "").Trim().ToLowerInvariant();
        if (wanted.Length == 0) return [];
        var legacy = LegacySizeGroup().Replace(wanted, "", 1);
        return legacy == wanted ? [wanted] : [wanted, legacy];
    }

    public static string EncodeKeySegment(string key) => SafeSegment().IsMatch(key ?? "") ? key ?? "" : TextUtil.EncodeUriComponent(key ?? "");

    public sealed record TitleLink(string Title, int? Year = null, string? MediaType = null, string? Provider = null, string? ProviderId = null,
        string? SourceType = null, string? Format = null, bool? Series = null, IReadOnlyList<string>? Aliases = null);

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
            foreach (var alias in p.Aliases ?? [])
            {
                var v = alias.Trim();
                if (v.Length > 0) search.Add(("alias", v));
            }
        }
        var qs = TextUtil.BuildQuery(search);
        var segment = EncodeKeySegment(key);
        return qs.Length > 0 ? $"{TitleHref}/{segment}?{qs}" : $"{TitleHref}/{segment}";
    }
}

