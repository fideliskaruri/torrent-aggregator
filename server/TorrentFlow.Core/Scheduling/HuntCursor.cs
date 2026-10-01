using System.Globalization;
using System.Text.RegularExpressions;

namespace TorrentFlow.Core.Scheduling;

/// <summary>
/// Which episode a monitored series hunts next. Automation and the timeline both read a library row
/// through this one rule, so they cannot disagree about the same row.
/// </summary>
public static class HuntCursor
{
    /// <summary>Follow the row's own start: a chosen season, the next-episode hint, or wherever the last grab left it.</summary>
    public const string OngoingMode = "ongoing";

    /// <summary>
    /// "New episodes only": nothing that aired before the row's <c>NewEpisodesSince</c> is hunted. The row names no
    /// episode until the first one to air after that moment is pinned as its cursor from metadata air dates.
    /// </summary>
    public const string NewEpisodesMode = "new";

    private static readonly Regex EpisodePattern = new(@"S(\d{1,3})[ ._-]*E(\d{1,4})",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    /// <summary>A row with only a media type (no work format to hand): <see cref="TorrentFlow.Core.Contracts.Metadata.WorkKinds.IsSeries"/>.</summary>
    public static bool IsSeries(string? mediaType) => TorrentFlow.Core.Contracts.Metadata.WorkKinds.IsSeries(null, mediaType);

    public static bool IsNewEpisodesOnly(string? monitorMode) => monitorMode == NewEpisodesMode;

    public static (int Season, int Episode)? Parse(string? value)
    {
        var match = EpisodePattern.Match(value ?? "");
        return match.Success
            ? (int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture), int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture))
            : null;
    }

    public static (int Season, int Episode)? Resolve(string? mediaType, string? monitorMode, int? cursorSeason, int? cursorEpisode,
        string? lastEpisode, int? fromSeason, int? fromEpisode, string? nextEpisodeHint) =>
        IsSeries(mediaType) ? ResolveSeries(monitorMode, cursorSeason, cursorEpisode, lastEpisode, fromSeason, fromEpisode, nextEpisodeHint) : null;

    /// <summary>
    /// The episode a series hunts next, or null when the row names none yet. In order: the stored cursor; for a
    /// new-episodes-only row nothing else, because it waits for its first new episode to be pinned and never
    /// falls back to the back catalogue; the episode after the last one grabbed; the chosen start season; an
    /// episode named by the hint; S01E01 for a row with no hint at all.
    /// </summary>
    public static (int Season, int Episode)? ResolveSeries(string? monitorMode, int? cursorSeason, int? cursorEpisode,
        string? lastEpisode, int? fromSeason, int? fromEpisode, string? nextEpisodeHint)
    {
        if (cursorSeason is > 0 && cursorEpisode is > 0) return (cursorSeason.Value, cursorEpisode.Value);
        if (IsNewEpisodesOnly(monitorMode)) return null;
        if (Parse(lastEpisode) is { } last) return (last.Season, last.Episode + 1);
        if (fromSeason is > 0) return (fromSeason.Value, fromEpisode is > 0 ? fromEpisode.Value : 1);
        return Parse(nextEpisodeHint) ?? (string.IsNullOrWhiteSpace(nextEpisodeHint) ? (1, 1) : null);
    }
}
