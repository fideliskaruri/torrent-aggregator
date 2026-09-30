using TorrentFlow.Library.Features.Watchlist;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Scheduling;

namespace TorrentFlow.Library.Features.Automation;

public sealed record CheckSchedule(DateTime At, string Reason)
{
    public const string NextCheckReason = "next check";
    public const string NotAiredYetReason = "not aired yet";
    public const string WaitingForSeedersReason = "waiting for seeders";
    /// <summary>A new-episodes-only series whose provider lists nothing after the moment it was added.</summary>
    public const string NoNewEpisodesReason = "no new episodes announced";
    /// <summary>A new-episodes-only series whose next episode, or its air date, the provider cannot name yet.</summary>
    public const string AirDateUnknownReason = "air date unknown";

    public static bool FreshlyAired(DateTime? airDate, DateTime now) =>
        airDate is { } aired && aired <= now && now - aired <= TimeSpan.FromHours(12);

    public static bool WaitingForSeeders(DateTime? since, DateTime now, AutomationOptions options) =>
        WaitReasonService.WaitingForSeeders(since, now, options.MinimumSeeders, options.SeederWaitTimeoutMinutes);

    /// <summary>
    /// When a new-episodes-only series looks for its first new episode again. Nothing announced is slow news,
    /// so twice a day; an unknown air date is asked again on the normal cadence, but at most hourly.
    /// </summary>
    public static CheckSchedule AwaitingNewEpisodes(DateTime now, NewEpisodeStatus status, int intervalMinutes) =>
        status == NewEpisodeStatus.NoneAnnounced
            ? new(now.AddHours(12), NoNewEpisodesReason)
            : new(now + TimeSpan.FromMinutes(Math.Max(60, intervalMinutes)), AirDateUnknownReason);

    public static CheckSchedule Next(DateTime now, DateTime? airDate, int misses, DateTime? seederWaitSince,
        int intervalMinutes, AutomationOptions options)
    {
        var wait = WaitReasonService.Evaluate(new()
        {
            AirDate = airDate, SeederWaitSince = seederWaitSince,
            MinimumSeeders = options.MinimumSeeders, SeederWaitTimeoutMinutes = options.SeederWaitTimeoutMinutes
        }, now);
        if (wait.Reason == WaitReasonKind.NotAiredYet)
            return new(airDate!.Value < now.AddDays(1) ? airDate.Value : now.AddDays(1), NotAiredYetReason);
        if (wait.Reason == WaitReasonKind.WaitingForSeeders)
            return new(new[] { now.AddMinutes(options.SeederRecheckMinutes), seederWaitSince!.Value.AddMinutes(options.SeederWaitTimeoutMinutes) }.Min(), WaitingForSeedersReason);
        if (FreshlyAired(airDate, now)) return new(now.AddMinutes(15), NextCheckReason);
        var backoff = EpisodeCursor.Backoff(misses);
        var interval = TimeSpan.FromMinutes(Math.Max(15, intervalMinutes));
        return new(now + (backoff > interval ? backoff : interval), NextCheckReason);
    }

    public static TimeSpan Delay(DateTime now, DateTime? earliest, int intervalMinutes)
    {
        var maximum = TimeSpan.FromMinutes(Math.Max(15, intervalMinutes));
        var delay = earliest is { } at ? at - now : maximum;
        return delay < TimeSpan.FromMinutes(1) ? TimeSpan.FromMinutes(1) : delay > maximum ? maximum : delay;
    }
}
