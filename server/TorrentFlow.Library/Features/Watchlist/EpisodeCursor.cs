using System.Text.RegularExpressions;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Library.Features.Watchlist;

public readonly record struct EpisodeCursor(int Season, int Episode)
{
    public string Label => $"S{Season:00}E{Episode:00}";
    public string QueueKey => $"s{Season:00000}e{Episode:00000}";
    public string Query(string title) => $"{title.Trim()} {Label}";
    public EpisodeCursor Next() => new(Season, Episode + 1);
    public bool IsAfter(EpisodeCursor? other) => other == null || Season > other.Value.Season ||
        (Season == other.Value.Season && Episode > other.Value.Episode);
    public static EpisodeCursor? Parse(string? value)
    {
        var match = Regex.Match(value ?? "", @"S(\d{1,3})[ ._-]*E(\d{1,4})", RegexOptions.IgnoreCase);
        return match.Success ? new(int.Parse(match.Groups[1].Value), int.Parse(match.Groups[2].Value)) : null;
    }
    public static bool IsSeries(string? type) => type is "tv" or "anime" or "series";
    public static EpisodeCursor? Resolve(WatchListItem item)
    {
        if (!IsSeries(item.MediaType)) return null;
        if (item.CursorSeason is > 0 && item.CursorEpisode is > 0) return new(item.CursorSeason.Value, item.CursorEpisode.Value);
        if (Parse(item.LastEpisode) is { } last) return last.Next();
        if (item.FromSeason is > 0) return new(item.FromSeason.Value, item.FromEpisode ?? 1);
        return Parse(item.NextEpisodeHint) ?? (string.IsNullOrWhiteSpace(item.NextEpisodeHint) ? new(1, 1) : null);
    }
    public static TimeSpan Backoff(int misses) => misses < 4 ? TimeSpan.Zero : TimeSpan.FromHours(Math.Min(6, Math.Pow(2, Math.Min(10, misses - 4))));
    public (EpisodeCursor Cursor, int Misses) AfterMiss(int misses) =>
        Episode > 1 && misses + 1 >= 3 ? (new(Season + 1, 1), 0) : (this, Math.Max(0, misses) + 1);
}
