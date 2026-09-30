using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace TorrentFlow.Core.Text;

/// <summary>
/// The one work-key slug (port of src/components/title/work-key.ts <c>slugify</c>/<c>workKeyFor</c>). Title routes,
/// requests, catalog matching and release identity all key works through here.
/// </summary>
public static partial class WorkKeySlug
{
    [GeneratedRegex("[^a-z0-9]+")] private static partial Regex NonSlug();
    [GeneratedRegex(@"\s+")] private static partial Regex Whitespace();
    [GeneratedRegex(@"-(?:19|20)\d{2}$")] private static partial Regex TrailingYear();
    [GeneratedRegex(@"-\d+(?:-\d+)?-?[kmgt]i?b(?:-(?!(?:19|20)\d{2}$)[a-z0-9]{2,20})?(?=-(?:19|20)\d{2}$|$)")]
    private static partial Regex LegacySizeGroup();

    // Hosts that run with invariant globalization may not decompose accents, so the common Latin ones fold here too.
    private const string Accented = "ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖòóôõöÙÚÛÜùúûüÝŸýÿÇçÑñ";
    private const string Ascii = "AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuYYyyCcNn";

    public static string Slugify(string? name)
    {
        var source = name ?? "";
        var folded = new StringBuilder(source.Length);
        foreach (var ch in source.Normalize(NormalizationForm.FormKD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark) continue;
            if (ch is '\'' or '’' or '`') continue;
            var accent = Accented.IndexOf(ch, StringComparison.Ordinal);
            folded.Append(accent >= 0 ? Ascii[accent] : ch);
        }
        var slug = NonSlug().Replace(folded.ToString().ToLowerInvariant(), "-").Trim('-');
        if (slug.Length > 0) return slug;
        var compact = Whitespace().Replace(source.Trim().ToLowerInvariant(), "-");
        return compact.Length > 0 ? EncodeUriComponent(compact) : "";
    }

    /// <summary>The slug, suffixed with the year when there is one; empty when the name has no slug.</summary>
    public static string WorkKeyFor(string? name, int? year = null)
    {
        var slug = Slugify(name);
        if (slug.Length == 0) return "";
        return year is { } y && y != 0 ? $"{slug}-{y}" : slug;
    }

    /// <summary>The key and, for keys minted with a size/group suffix by older builds, the key without it.</summary>
    public static IReadOnlyList<string> Aliases(string? key)
    {
        var wanted = (key ?? "").Trim().ToLowerInvariant();
        if (wanted.Length == 0) return [];
        var legacy = LegacySizeGroup().Replace(wanted, "", 1);
        return legacy == wanted ? [wanted] : [wanted, legacy];
    }

    public static bool SameKey(string left, string right) =>
        string.Equals(Uri.UnescapeDataString(left), Uri.UnescapeDataString(right), StringComparison.OrdinalIgnoreCase);

    /// <summary>Port of <c>workKeyMatches</c>: exact key/alias match, or a yearless name that cannot contradict a dated key.</summary>
    public static bool Matches(string? key, string? name, int? year = null)
    {
        var candidates = Aliases(key);
        if (candidates.Count == 0) return false;
        var withYear = WorkKeyFor(name, year);
        var bare = WorkKeyFor(name);
        if (candidates.Any(c => SameKey(c, withYear) || SameKey(c, bare))) return true;
        if (year != null) return false;
        return bare.Length > 0 && candidates.Any(c => SameKey(TrailingYear().Replace(c, ""), bare));
    }

    /// <summary>JS encodeURIComponent.</summary>
    public static string EncodeUriComponent(string value) => Uri.EscapeDataString(value)
        .Replace("%21", "!").Replace("%27", "'").Replace("%28", "(").Replace("%29", ")").Replace("%2A", "*");
}
