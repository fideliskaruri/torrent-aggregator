namespace TorrentFlow.Engine.Queue;

/// <summary>
/// The downloads-at-once cap the queue enforces right now and where it comes from: <see cref="Schedule"/> when an
/// open download window sets its own limit, else <see cref="Setting"/> (the owner's saved cap or the configured default).
/// </summary>
public sealed record EffectiveCap(int MaxActive, string Source)
{
    public const string Setting = "setting";
    public const string Schedule = "schedule";
}

/// <summary>
/// The owner's saved "downloads at once" setting and download hours, held in memory so queue decisions never hit the
/// database for them. A null cap means the configured default (<see cref="EngineOptions.MaxActiveDownloads"/>) applies.
/// </summary>
public sealed class DownloadLimits
{
    public const int MinActiveDownloads = 1;
    public const int MaxActiveDownloads = 20;

    /// <summary>
    /// The one cap rule: an open window's own downloads-at-once wins over the saved cap, which wins over the configured
    /// default. Outside the download hours this is the setting; nothing new starts then anyway.
    /// </summary>
    public static EffectiveCap Effective(ScheduleState schedule, int? saved, int configuredDefault) =>
        schedule.Active?.MaxActiveDownloads is { } windowCap
            ? new EffectiveCap(Math.Max(MinActiveDownloads, windowCap), EffectiveCap.Schedule)
            : new EffectiveCap(Math.Max(MinActiveDownloads, saved ?? configuredDefault), EffectiveCap.Setting);

    private int _maxActive;

    /// <summary>Raised after the saved cap changes, so the engine can refill freed slots right away.</summary>
    public event EventHandler? Changed;

    public int? MaxActiveOverride => Volatile.Read(ref _maxActive) is > 0 and var v ? v : null;

    public void SetMaxActive(int? value)
    {
        var next = value is { } v ? Math.Clamp(v, MinActiveDownloads, MaxActiveDownloads) : 0;
        if (Interlocked.Exchange(ref _maxActive, next) != next) Changed?.Invoke(this, EventArgs.Empty);
    }

    private IReadOnlyList<DownloadWindow> _windows = [];

    /// <summary>The owner's download hours; empty means downloads may start at any time.</summary>
    public IReadOnlyList<DownloadWindow> Windows => Volatile.Read(ref _windows);

    public void SetWindows(IReadOnlyList<DownloadWindow>? windows)
    {
        var next = (IReadOnlyList<DownloadWindow>)(windows ?? []).Select(DownloadWindows.Normalize).ToList();
        var previous = Interlocked.Exchange(ref _windows, next);
        if (DownloadWindows.Serialize(previous) != DownloadWindows.Serialize(next)) Changed?.Invoke(this, EventArgs.Empty);
    }
}
