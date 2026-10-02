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
    [GeneratedRegex("[-_]+")] private static partial Regex Separators();
    [GeneratedRegex(@"-(?:19|20)\d{2}$")] private static partial Regex TrailingYear();
    [GeneratedRegex(@"-\d+(?:-\d+)?-?[kmgt]i?b(?:-(?!(?:19|20)\d{2}$)[a-z0-9]{2,20})?(?=-(?:19|20)\d{2}$|$)")]
    private static partial Regex LegacySizeGroup();
    [GeneratedRegex(@"((?:-(?:19|20)\d{2})?)-(tv|film)(?:-(?:tmdb|tvmaze|anilist|imdb|cinemeta|itunes|mal)[a-z0-9]+)?$")]
    private static partial Regex KindSuffix();

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

    /// <summary>The key and, for keys minted with a size/group suffix by older builds, the key without it; a dated key
    /// kept apart from a namesake of the other kind ("the-flash-2023-tv", see SearchRanking) also answers to its name and
    /// year.</summary>
    public static IReadOnlyList<string> Aliases(string? key)
    {
        var wanted = (key ?? "").Trim().ToLowerInvariant();
        if (wanted.Length == 0) return [];
        var legacy = KindSuffix().Replace(LegacySizeGroup().Replace(wanted, "", 1), "$1");
        return legacy == wanted ? [wanted] : [wanted, legacy];
    }

    /// <summary>The key a work key takes when a stored work of the other kind holds it: "the-flash-2023-tv", "family-guy-film".</summary>
    public static string KindKey(string key, bool series) => $"{key}-{(series ? "tv" : "film")}";

    /// <summary>
    /// The keys a record named <paramref name="key"/> may take, in order: the key, its <see cref="KindKey"/>, then the kind
    /// key tagged with its own catalog id ("the-flash-2023-tv-tmdb200"), which no other record can hold.
    /// </summary>
    public static IReadOnlyList<string> KeyCandidates(string key, bool series, string? provider, string? providerId)
    {
        // A key that already carries this kind's tag (or the id tag too) is extended from its name and year, never doubled.
        var name = KindOf(key) == series ? KindSuffix().Replace(key, "$1") : key;
        var kind = KindKey(name, series);
        var tag = Slugify($"{provider}{providerId}").Replace("-", "", StringComparison.Ordinal);
        List<string> keys = provider is { Length: > 0 } && providerId is { Length: > 0 } && tag.Length > 0 ? [key, kind, $"{kind}-{tag}"] : [key, kind];
        return keys.Distinct(StringComparer.Ordinal).ToList();
    }

    /// <summary>Whether a <see cref="KindKey"/> names a series (true) or a film (false); null for any other key.</summary>
    public static bool? KindOf(string? key) =>
        KindSuffix().Match((key ?? "").Trim().ToLowerInvariant()) is { Success: true } m ? m.Groups[2].Value == "tv" : null;

    /// <summary>A key's name alone: "doctor-who-1963", "doctor-who-1963-tv" and "doctor-who" all name "doctor-who".</summary>
    public static string NameOf(string? key)
    {
        var plain = KindSuffix().Replace((key ?? "").Trim().ToLowerInvariant(), "$1");
        return TrailingYear().Replace(plain, "");
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

    private static readonly HashSet<string> MinorWords =
        ["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to"];

    /// <summary>work-key.ts displayTitleFromWorkKey: the slug spelled back out as words, never a guessed year.</summary>
    public static string DisplayTitle(string? key)
    {
        var raw = (key ?? "").Trim();
        try { raw = Uri.UnescapeDataString(raw); } catch (UriFormatException) { }
        var words = Whitespace().Replace(Separators().Replace(raw, " "), " ").Trim();
        if (words.Length == 0) return "";
        return string.Join(' ', words.Split(' ').Select((w, i) =>
            i > 0 && MinorWords.Contains(w.ToLowerInvariant()) ? w.ToLowerInvariant()
            : w[0] is >= 'a' and <= 'z' ? char.ToUpperInvariant(w[0]) + w[1..] : w));
    }

    /// <summary>JS encodeURIComponent.</summary>
    public static string EncodeUriComponent(string value) => Uri.EscapeDataString(value)
        .Replace("%21", "!").Replace("%27", "'").Replace("%28", "(").Replace("%29", ")").Replace("%2A", "*");
}
