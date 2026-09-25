using System.Globalization;
using System.Text.RegularExpressions;

namespace TorrentFlow.Metadata.Browse;

public sealed record ReleaseStatus(bool Unreleased, bool Released, string? ComingLabel, DateTimeOffset? Date);

public sealed record TheatricalStatus(bool InTheatricalWindow, string? TheatricalLabel);

public sealed record BrowseReleaseGate(bool Gated, string? Label, string? Reason);

/// <summary>
/// src/lib/browse/release-status.ts: future-gating and theatrical-window labels. The TS renders in the browser's
/// zone; the server port evaluates in UTC, where ISO day strings land on their own calendar day.
/// </summary>
public static partial class ReleaseGates
{
    private static readonly string[] MonthsShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    [GeneratedRegex(@"^(\d{4})-(\d{2})")] private static partial Regex YearMonth();

    public static DateTimeOffset? ParseReleaseDate(string? input) =>
        !string.IsNullOrWhiteSpace(input) && DateTimeOffset.TryParse(input, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var d) ? d : null;

    public static ReleaseStatus Of(string? input, DateTimeOffset now) => Of(ParseReleaseDate(input), now);

    public static ReleaseStatus Of(DateTimeOffset? date, DateTimeOffset now)
    {
        if (date is not { } d || d <= now) return new(false, true, null, date);
        var utc = d.UtcDateTime;
        var label = utc is { Month: 1, Day: 1 }
            ? $"Coming {utc.Year.ToString(CultureInfo.InvariantCulture)}"
            : $"Coming {MonthsShort[utc.Month - 1]} {utc.Year.ToString(CultureInfo.InvariantCulture)}";
        return new(true, false, label, d);
    }

    public static bool IsUnreleased(string? input, DateTimeOffset now) => Of(input, now).Unreleased;

    public static TheatricalStatus TheatricalWindowStatus(bool inTheatricalWindow, string? nextHomeReleaseAt)
    {
        if (!inTheatricalWindow) return new(false, null);
        return new(true, string.IsNullOrEmpty(nextHomeReleaseAt) ? "In cinemas" : FormatHomeDate(nextHomeReleaseAt));
    }

    private static string FormatHomeDate(string isoDate)
    {
        var m = YearMonth().Match(isoDate);
        if (!m.Success) return "In cinemas";
        var idx = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture) - 1;
        return idx is < 0 or > 11 ? "In cinemas" : $"Digital {MonthsShort[idx]} {m.Groups[1].Value}";
    }

    public static BrowseReleaseGate Gate(string? releaseDate, string? mediaType, bool inTheatricalWindow, string? nextHomeReleaseAt, DateTimeOffset now)
    {
        var primary = Of(releaseDate, now);
        if (primary.Unreleased) return new(true, primary.ComingLabel ?? "Coming soon", "future");
        var theatrical = TheatricalWindowStatus(HomeRelease.IsMovie(mediaType) && inTheatricalWindow, nextHomeReleaseAt);
        return theatrical.InTheatricalWindow ? new(true, theatrical.TheatricalLabel ?? "In cinemas", "theatrical") : new(false, null, null);
    }
}
