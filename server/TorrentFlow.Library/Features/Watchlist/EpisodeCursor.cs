using TorrentFlow.Core.Scheduling;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Library.Features.Watchlist;

public readonly record struct EpisodeCursor(int Season, int Episode)
{
    public string Label => $"S{Season:00}E{Episode:00}";
    public string QueueKey => TorrentFlow.Core.QueueKeys.For(Season, Episode);
    /// <summary>The episode a queue key names; null for films and one-offs.</summary>
    public static EpisodeCursor? FromQueueKey(string? key) =>
        TorrentFlow.Core.QueueKeys.Parse(key) is { } parsed ? new(parsed.Season, parsed.Episode) : null;
    public string Query(string title) => $"{title.Trim()} {Label}";
    public EpisodeCursor Next() => new(Season, Episode + 1);
    public bool IsAfter(EpisodeCursor? other) => other == null || Season > other.Value.Season ||
        (Season == other.Value.Season && Episode > other.Value.Episode);
    public static EpisodeCursor? Parse(string? value) => HuntCursor.Parse(value) is { } parsed ? new(parsed.Season, parsed.Episode) : null;
    public static bool IsSeries(string? type) => HuntCursor.IsSeries(type);
    /// <summary>The shared hunt rule (<see cref="HuntCursor"/>); prewarm and the timeline read rows through it too.</summary>
    public static EpisodeCursor? Resolve(WatchListItem item) =>
        HuntCursor.Resolve(item.MediaType, item.MonitorMode, item.CursorSeason, item.CursorEpisode, item.LastEpisode,
            item.FromSeason, item.FromEpisode, item.NextEpisodeHint) is { } cursor ? new(cursor.Season, cursor.Episode) : null;
    /// <summary>A new-episodes-only series that has not pinned its first new episode yet.</summary>
    public static bool AwaitingFirstNewEpisode(WatchListItem item) =>
        IsSeries(item.MediaType) && HuntCursor.IsNewEpisodesOnly(item.MonitorMode) && Resolve(item) == null;
    public static TimeSpan Backoff(int misses) => misses < 4 ? TimeSpan.Zero : TimeSpan.FromHours(Math.Min(6, Math.Pow(2, Math.Min(10, misses - 4))));
    public (EpisodeCursor Cursor, int Misses) AfterMiss(int misses) =>
        Episode > 1 && misses + 1 >= 3 ? (new(Season + 1, 1), 0) : (this, Math.Max(0, misses) + 1);
}
