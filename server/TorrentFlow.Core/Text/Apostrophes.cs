namespace TorrentFlow.Core.Text;

/// <summary>
/// Catalog titles arrive with typographic apostrophes ("Frieren: Beyond Journey’s End"); release names and search sites
/// use the plain one. Every title a search is built from goes through <see cref="Normalize"/> so a query never carries a
/// curly quote that no release name contains.
/// </summary>
public static class Apostrophes
{
    // Right and left single quotes, the modifier letter apostrophe, the acute accent, the grave accent and the prime.
    private static readonly char[] Lookalikes = ['\u2019', '\u2018', '\u02BC', '\u00B4', '`', '\u2032'];

    /// <summary>The text with every apostrophe lookalike turned into a plain <c>'</c>.</summary>
    public static string Normalize(string? value)
    {
        if (string.IsNullOrEmpty(value)) return value ?? "";
        if (value.IndexOfAny(Lookalikes) < 0) return value;
        var chars = value.ToCharArray();
        for (var i = 0; i < chars.Length; i++)
            if (Array.IndexOf(Lookalikes, chars[i]) >= 0) chars[i] = '\'';
        return new string(chars);
    }
}
