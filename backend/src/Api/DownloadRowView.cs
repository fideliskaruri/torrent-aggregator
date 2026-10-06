using TorrentFlow.Domain;

namespace TorrentFlow.Api;

internal sealed record DownloadRowStatus(string Status, string StatusLabel);

internal static class DownloadRowView
{
    internal static string State(bool done, bool paused, bool filing, EngineSnapshot? live)
    {
        var finishing = !done && !paused && (live?.Complete == true || filing);
        var failed = !finishing && (live?.Failure is not null || live is null && !done && !paused);
        return done ? "complete" : paused ? "paused" : finishing ? "finishing" : failed ? "error" :
            live?.Active == true ? !live.MetadataAvailable ? "metaDL" :
                live.StalledProgress ? "stalledDL" : "downloading" :
            live?.Intent == DownloadIntent.Queued ? "queued" :
            live?.MetadataAvailable == false ? "metaDL" :
            live?.StalledProgress == true || live?.StalledMetadata == true ? "stalledDL" : "queued";
    }

    internal static DownloadRowStatus Status(string state, int? queuePosition, bool full,
        bool stalledMetadata, string? error)
    {
        var status = state switch
        {
            "complete" => "ready",
            "paused" => "paused",
            "error" => "error",
            "finishing" => "finishing",
            "downloading" => "downloading",
            "queued" => "queued",
            "metaDL" or "stalledDL" => "waiting",
            _ => "waiting",
        };
        string label;
        if (status == "ready") label = "Ready";
        else if (status == "paused") label = "Paused";
        else if (status == "error") label = ShortError(error);
        else if (status == "finishing") label = "Finishing";
        else if (status == "downloading") label = "Downloading";
        else if (status == "queued")
            label = queuePosition is { } position ? $"Queued ({position})" :
                full ? "Waiting for a download slot" : "Queued";
        else label = state == "metaDL" || stalledMetadata ? "Getting file list" : "Waiting for peers";
        return new(status, label);
    }

    internal static DownloadRowStatus? HeldStatus(string state, EngineSnapshot? live,
        IEnumerable<(int Index, bool Filed)> files)
    {
        if (state is not ("downloading" or "stalledDL") || live is null) return null;
        var pending = files.Where(file => !file.Filed).ToArray();
        if (pending.Length == 0 || pending.Any(file =>
                live.Files.FirstOrDefault(engineFile => engineFile.Index == file.Index)?.Held != true))
            return null;
        return new("queued", "Waiting for a download slot");
    }

    internal static string MediaKind(WorkRow? work, ParsedRelease parsed) => work is not null
        ? work.Anime == true ? "anime" : work.Kind == WorkKind.Series ? "series" : "movie"
        : parsed.Seasons.Length > 0 || parsed.Episodes.Length > 0 || parsed.AbsoluteNumbers.Length > 0 ||
            parsed.EpisodeRanges.Length > 0 || parsed.AbsoluteRanges.Length > 0 ? "series" : "movie";

    internal static bool IsSeries(WorkRow? work, ParsedRelease parsed) => work is not null
        ? work.Kind == WorkKind.Series
        : parsed.Seasons.Length > 0 || parsed.Episodes.Length > 0 || parsed.AbsoluteNumbers.Length > 0 ||
            parsed.EpisodeRanges.Length > 0 || parsed.AbsoluteRanges.Length > 0;

    internal static object Quality(Quality quality)
    {
        var resolution = quality.Resolution switch
        {
            2160 => 2160, 1080 => 1080, 720 => 720, 480 => 480, _ => (int?)null,
        };
        var sourceLabel = quality.Source switch
        {
            "web" => "WEB-DL", "bluray" => "BluRay", "hdtv" => "HDTV", "dvd" => "DVD",
            "cam" => "CAM", "ts" => "TS", _ => null,
        };
        var label = string.Join(" ", new[] { resolution?.ToString(), sourceLabel }.Where(value => value is not null));
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
