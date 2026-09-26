using System.Text.Json;
using System.Text.Json.Serialization;

namespace TorrentFlow.Engine.Queue;

/// <summary>
/// One weekly rule of the owner's download hours. <see cref="Days"/> are the days the window STARTS on (0 = Sunday).
/// <see cref="EndHour"/> ≤ <see cref="StartHour"/> runs overnight into the next day (22→6 on Monday is Mon 22:00 to
/// Tue 06:00). The caps are optional: null keeps the base downloads-at-once and leaves the engine unthrottled.
/// </summary>
public sealed record DownloadWindow(
    IReadOnlyList<int> Days,
    int StartHour,
    int EndHour,
    int? MaxActiveDownloads = null,
    long? MaxDownloadRate = null,
    long? MaxUploadRate = null);

/// <summary>What the schedule says right now. With nothing configured it is always open and never capped.</summary>
public sealed record ScheduleState(bool Configured, bool Open, DownloadWindow? Active)
{
    public static readonly ScheduleState Unrestricted = new(false, true, null);
}

public static class DownloadWindows
{
    public const int MaxWindows = 14;
    /// <summary>MonoTorrent rates are ints (bytes/s).</summary>
    public const long MaxRate = int.MaxValue;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static string? Serialize(IReadOnlyList<DownloadWindow> windows) =>
        windows.Count == 0 ? null : JsonSerializer.Serialize(windows, Json);

    /// <summary>Stored JSON back to rules; anything unreadable or invalid is dropped rather than blocking downloads.</summary>
    public static IReadOnlyList<DownloadWindow> Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            var list = JsonSerializer.Deserialize<List<DownloadWindow>>(json, Json) ?? [];
            return list.Where(w => w is not null && Validate(w) is null).Take(MaxWindows).Select(Normalize).ToList();
        }
        catch (JsonException)
        {
            return [];
        }
    }

    public static DownloadWindow Normalize(DownloadWindow w) =>
        w with { Days = (w.Days ?? []).Distinct().Order().ToList() };

    /// <summary>Null when the rule is usable, otherwise the reason (settings API error text).</summary>
    public static string? Validate(DownloadWindow w)
    {
        if (w.Days is null || w.Days.Count == 0) return "each download window needs at least one day";
        if (w.Days.Any(d => d is < 0 or > 6)) return "download window days must be 0 (Sunday) to 6 (Saturday)";
        if (w.StartHour is < 0 or > 23) return "download window startHour must be 0 to 23";
        if (w.EndHour is < 1 or > 24) return "download window endHour must be 1 to 24";
        if (w.StartHour == w.EndHour) return "download window startHour and endHour must differ";
        if (w.MaxActiveDownloads is { } m && (m < DownloadLimits.MinActiveDownloads || m > DownloadLimits.MaxActiveDownloads))
            return $"download window maxActiveDownloads must be {DownloadLimits.MinActiveDownloads} to {DownloadLimits.MaxActiveDownloads}";
        if (w.MaxDownloadRate is { } dl && (dl < 1 || dl > MaxRate)) return "download window maxDownloadRate must be a positive number of bytes per second";
        if (w.MaxUploadRate is { } ul && (ul < 1 || ul > MaxRate)) return "download window maxUploadRate must be a positive number of bytes per second";
        return null;
    }

    /// <summary>Whether <paramref name="w"/> covers <paramref name="localNow"/> (server local time).</summary>
    public static bool Covers(DownloadWindow w, DateTimeOffset localNow)
    {
        var day = (int)localNow.DayOfWeek;
        var hour = localNow.Hour;
        if (w.EndHour > w.StartHour) return w.Days.Contains(day) && hour >= w.StartHour && hour < w.EndHour;
        // Overnight: the evening part belongs to the start day, the morning part to the day after it.
        if (hour >= w.StartHour) return w.Days.Contains(day);
        var previous = (day + 6) % 7;
        return hour < w.EndHour && w.Days.Contains(previous);
    }

    /// <summary>The first matching rule (list order) is the active one, so its caps apply.</summary>
    public static ScheduleState Evaluate(IReadOnlyList<DownloadWindow> windows, DateTimeOffset localNow)
    {
        if (windows.Count == 0) return ScheduleState.Unrestricted;
        var active = windows.FirstOrDefault(w => Covers(w, localNow));
        return new ScheduleState(true, active is not null, active);
    }
}
