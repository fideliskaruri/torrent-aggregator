using TorrentFlow.Library.Features.Watchlist;
using TorrentFlow.Core.Scheduling;

namespace TorrentFlow.Library.Features.Automation;

public sealed record CheckSchedule(DateTime At, string Reason)
{
    public static bool FreshlyAired(DateTime? airDate, DateTime now) =>
        airDate is { } aired && aired <= now && now - aired <= TimeSpan.FromHours(12);

    public static bool WaitingForSeeders(DateTime? since, DateTime now, AutomationOptions options) =>
        WaitReasonService.WaitingForSeeders(since, now, options.MinimumSeeders, options.SeederWaitTimeoutMinutes);

    public static CheckSchedule Next(DateTime now, DateTime? airDate, int misses, DateTime? seederWaitSince,
        int intervalMinutes, AutomationOptions options)
    {
        var wait = WaitReasonService.Evaluate(new()
        {
            AirDate = airDate, SeederWaitSince = seederWaitSince,
            MinimumSeeders = options.MinimumSeeders, SeederWaitTimeoutMinutes = options.SeederWaitTimeoutMinutes
        }, now);
        if (wait.Reason == WaitReasonKind.NotAiredYet)
            return new(airDate!.Value < now.AddDays(1) ? airDate.Value : now.AddDays(1), "not aired yet");
        if (wait.Reason == WaitReasonKind.WaitingForSeeders)
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
