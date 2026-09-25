namespace TorrentFlow.Engine.Queue;

/// <summary>
/// The owner's saved "downloads at once" setting, held in memory so queue decisions never hit the database for it.
/// Null means the configured default (<see cref="EngineOptions.MaxActiveDownloads"/>) applies.
/// </summary>
public sealed class DownloadLimits
{
    public const int MinActiveDownloads = 1;
    public const int MaxActiveDownloads = 20;

    private int _maxActive;

    /// <summary>Raised after the saved cap changes, so the engine can refill freed slots right away.</summary>
    public event EventHandler? Changed;

    public int? MaxActiveOverride => Volatile.Read(ref _maxActive) is > 0 and var v ? v : null;

    public void SetMaxActive(int? value)
    {
        var next = value is { } v ? Math.Clamp(v, MinActiveDownloads, MaxActiveDownloads) : 0;
        if (Interlocked.Exchange(ref _maxActive, next) != next) Changed?.Invoke(this, EventArgs.Empty);
    }
}
