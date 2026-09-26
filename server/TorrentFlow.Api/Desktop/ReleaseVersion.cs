using System.Diagnostics.CodeAnalysis;
using System.Globalization;

namespace TorrentFlow.Api.Desktop;

/// <summary>A release tag such as <c>v1.4.0</c> or <c>1.4.0-beta.2</c>: numeric core plus optional pre-release label.</summary>
public sealed record ReleaseVersion(Version Core, string? PreRelease)
{
    public static bool TryParse(string? text, [NotNullWhen(true)] out ReleaseVersion? version)
    {
        version = null;
        var raw = text?.Trim() ?? "";
        if (raw.StartsWith('v') || raw.StartsWith('V')) raw = raw[1..];
        var plus = raw.IndexOf('+');
        if (plus >= 0) raw = raw[..plus];
        string? pre = null;
        var dash = raw.IndexOf('-');
        if (dash >= 0)
        {
            pre = raw[(dash + 1)..];
            raw = raw[..dash];
            if (pre.Length == 0) return false;
        }
        var parts = raw.Split('.');
        if (parts.Length is < 1 or > 4) return false;
        var numbers = new int[3];
        for (var i = 0; i < parts.Length; i++)
        {
            if (!int.TryParse(parts[i], NumberStyles.None, CultureInfo.InvariantCulture, out var n)) return false;
            if (i < 3) numbers[i] = n;
            else if (n != 0) return false;
        }
        version = new ReleaseVersion(new Version(numbers[0], numbers[1], numbers[2]), pre);
        return true;
    }

    /// <summary>True when <paramref name="latest"/> is a newer release than <paramref name="current"/>. Unparseable input is never newer.</summary>
    public static bool IsNewer(string? latest, string? current)
    {
        if (!TryParse(latest, out var l) || !TryParse(current, out var c)) return false;
        var core = l.Core.CompareTo(c.Core);
        if (core != 0) return core > 0;
        // Same core: a release beats its own pre-releases; two pre-releases compare by label.
        if (l.PreRelease is null) return c.PreRelease is not null;
        if (c.PreRelease is null) return false;
        return ComparePreRelease(l.PreRelease, c.PreRelease) > 0;
    }

    private static int ComparePreRelease(string a, string b)
    {
        var left = a.Split('.');
        var right = b.Split('.');
        for (var i = 0; i < Math.Max(left.Length, right.Length); i++)
        {
            if (i >= left.Length) return -1;
            if (i >= right.Length) return 1;
            var leftNumeric = int.TryParse(left[i], NumberStyles.None, CultureInfo.InvariantCulture, out var ln);
            var rightNumeric = int.TryParse(right[i], NumberStyles.None, CultureInfo.InvariantCulture, out var rn);
            var cmp = leftNumeric && rightNumeric ? ln.CompareTo(rn)
                : leftNumeric ? -1
                : rightNumeric ? 1
                : string.CompareOrdinal(left[i], right[i]);
            if (cmp != 0) return cmp;
        }
        return 0;
    }

    public override string ToString() => PreRelease is null ? Core.ToString(3) : $"{Core.ToString(3)}-{PreRelease}";
}
