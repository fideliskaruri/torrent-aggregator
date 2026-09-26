using System.Text.Json.Serialization;

namespace TorrentFlow.Core.Scheduling;

[JsonConverter(typeof(JsonStringEnumConverter<WaitReasonKind>))]
public enum WaitReasonKind
{
    None, OutsideWindow, QueueFull, WaitingForSeeders, NotAiredYet, LowerLane, NextCheckScheduled
}

public sealed record WaitReason(WaitReasonKind Reason, string Text, DateTime? Until = null, DateTime? Since = null);

public sealed record WaitContext
{
    public bool Queued { get; init; }
    public bool WindowOpen { get; init; } = true;
    public DateTime? NextWindowStart { get; init; }
    public int? MaxActive { get; init; }
    public int Lane { get; init; }
    public int? BestQueuedLane { get; init; }
    public DateTime? AirDate { get; init; }
    public DateTime? SeederWaitSince { get; init; }
    public int MinimumSeeders { get; init; }
    public int SeederWaitTimeoutMinutes { get; init; }
    public DateTime? NextCheckAt { get; init; }
}

/// <summary>Pure, shared policy used by the engine, monitoring scheduler and timeline.</summary>
public static class WaitReasonService
{
    public static bool IsFuture(DateTime? at, DateTime now) => at > now;

    public static bool WaitingForSeeders(DateTime? since, DateTime now, int minimumSeeders, int timeoutMinutes) =>
        minimumSeeders > 0 && since is { } start && now < start.AddMinutes(timeoutMinutes);

    public static bool QueueBlocked(bool windowOpen, int active, int cap) => !windowOpen || active >= cap;

    public static WaitReason Evaluate(WaitContext context, DateTime now)
    {
        if (context.Queued)
        {
            if (!context.WindowOpen)
                return new(WaitReasonKind.OutsideWindow, "Outside download hours", context.NextWindowStart);
            if (context.BestQueuedLane < context.Lane)
                return new(WaitReasonKind.LowerLane, "Higher-priority downloads are waiting");
            return new(WaitReasonKind.QueueFull, context.MaxActive is { } cap
                ? $"Waiting for a download slot (maximum {cap} active)" : "Waiting for a download slot");
        }
        if (IsFuture(context.AirDate, now))
            return new(WaitReasonKind.NotAiredYet, "Not aired yet", context.AirDate);
        if (WaitingForSeeders(context.SeederWaitSince, now, context.MinimumSeeders, context.SeederWaitTimeoutMinutes))
            return new(WaitReasonKind.WaitingForSeeders, "Waiting for seeders",
                context.SeederWaitSince!.Value.AddMinutes(context.SeederWaitTimeoutMinutes), context.SeederWaitSince);
        if (IsFuture(context.NextCheckAt, now))
            return new(WaitReasonKind.NextCheckScheduled, "Next check scheduled", context.NextCheckAt);
        return new(WaitReasonKind.None, "Ready for next check");
    }
}
