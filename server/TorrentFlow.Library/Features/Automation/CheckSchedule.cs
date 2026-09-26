using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Automation;

public sealed record CheckSchedule(DateTime At, string Reason)
{
    public static bool FreshlyAired(DateTime? airDate, DateTime now) =>
        airDate is { } aired && aired <= now && now - aired <= TimeSpan.FromHours(12);

    public static bool WaitingForSeeders(DateTime? since, DateTime now, AutomationOptions options) =>
        options.MinimumSeeders > 0 && since is { } start && now < start.AddMinutes(options.SeederWaitTimeoutMinutes);

    public static CheckSchedule Next(DateTime now, DateTime? airDate, int misses, DateTime? seederWaitSince,
        int intervalMinutes, AutomationOptions options)
    {
        if (airDate > now) return new(airDate.Value < now.AddDays(1) ? airDate.Value : now.AddDays(1), "not aired yet");
        if (WaitingForSeeders(seederWaitSince, now, options))
            return new(new[] { now.AddMinutes(options.SeederRecheckMinutes), seederWaitSince!.Value.AddMinutes(options.SeederWaitTimeoutMinutes) }.Min(), "waiting for seeders");
        if (FreshlyAired(airDate, now)) return new(now.AddMinutes(15), "next check");
        var backoff = EpisodeCursor.Backoff(misses);
        var interval = TimeSpan.FromMinutes(Math.Max(15, intervalMinutes));
        return new(now + (backoff > interval ? backoff : interval), "next check");
    }

    public static TimeSpan Delay(DateTime now, DateTime? earliest, int intervalMinutes)
    {
        var maximum = TimeSpan.FromMinutes(Math.Max(15, intervalMinutes));
        var delay = earliest is { } at ? at - now : maximum;
        return delay < TimeSpan.FromMinutes(1) ? TimeSpan.FromMinutes(1) : delay > maximum ? maximum : delay;
    }
}
