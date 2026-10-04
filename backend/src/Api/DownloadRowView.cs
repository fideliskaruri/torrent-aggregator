using TorrentFlow.Domain;

namespace TorrentFlow.Api;

internal sealed record DownloadRowStatus(string Status, string StatusLabel);

internal static class DownloadRowView
{
    internal static DownloadRowStatus Status(string state, int? queuePosition, bool full,
        string? waitingReason, string? error)
    {
        var status = state switch
        {
            "complete" => "ready",
            "paused" => "paused",
            "error" => "error",
            "finishing" => "finishing",
            "downloading" => "downloading",
            "queued" => "queued",
            _ => "waiting",
        };
        var label = status switch
        {
            "ready" => "Ready",
            "paused" => "Paused",
            "error" => ShortError(error),
            "finishing" => "Finishing",
            "downloading" => "Downloading",
            "queued" => queuePosition is { } position ? $"Queued ({position})" :
                full ? "Waiting for a download slot" : "Queued",
            "waiting" => state == "metaDL" || waitingReason?.Contains("file list", StringComparison.OrdinalIgnoreCase) == true
                ? "Getting file list"
                : "Waiting for peers",
            _ => "Waiting for peers",
        };
        return new(status, label);
    }

    internal static string MediaKind(WorkRow? work, ParsedRelease parsed) => work is not null
        ? work.Anime == true ? "anime" : work.Kind == WorkKind.Series ? "series" : "movie"
        : parsed.Seasons.Length > 0 || parsed.Episodes.Length > 0 || parsed.AbsoluteNumbers.Length > 0 ||
            parsed.EpisodeRanges.Length > 0 || parsed.AbsoluteRanges.Length > 0 ? "series" : "movie";

    internal static object Quality(Quality quality)
    {
        var resolution = quality.Resolution switch
        {
            2160 => "2160p", 1080 => "1080p", 720 => "720p", 480 => "480p", _ => null,
        };
        var sourceLabel = quality.Source switch
        {
            "web" => "WEB-DL", "bluray" => "BluRay", "hdtv" => "HDTV", "dvd" => "DVD",
            "cam" => "CAM", "ts" => "TS", _ => null,
        };
        var label = string.Join(" ", new[] { resolution, sourceLabel }.Where(value => value is not null));
        return new { resolution, source = quality.Source, label = label.Length == 0 ? null : label };
    }

    internal static object Actions(string status, bool forced, bool servesTarget, bool filesExist) => new
    {
        pause = status is "downloading" or "queued" or "waiting",
        resume = status == "paused",
        downloadNow = status == "queued" && !forced,
        findAnother = servesTarget && status is not ("ready" or "finishing"),
        open = status == "ready" && filesExist,
        remove = true,
    };

    internal static string WantedStatusLabel(TargetState state, string? reason) =>
        state is TargetState.Wanted or TargetState.Searching ? "Looking for a release" :
        string.IsNullOrWhiteSpace(reason) ? "Waiting" : reason;

    private static string ShortError(string? error)
    {
        if (string.IsNullOrWhiteSpace(error)) return "Download failed";
        var value = error.Trim().TrimEnd('.');
        return value.Length <= 120 ? value : value[..117] + "...";
    }
}
