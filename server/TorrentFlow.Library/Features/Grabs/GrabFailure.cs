namespace TorrentFlow.Library.Features.Grabs;

public sealed record GrabFailure(string Code, string Message, string Action, bool Retryable = true)
{
    public static readonly GrabFailure Sources = new("sources_unavailable",
        "Search sources are still unavailable after automatic retries.",
        "Check your connection and enabled sources, then retry.");
    public static readonly GrabFailure Storage = new("storage_limit",
        "The storage limit prevented these downloads.",
        "Free some space or increase your storage limit, then retry.");
    public static readonly GrabFailure Metadata = new("metadata_unavailable",
        "No release supplied a usable file list.",
        "Retry later when more peers are online, or choose another release.");
    public static readonly GrabFailure Unknown = new("download_failed",
        "The download could not be started.",
        "Retry. If it still fails, check Activity for the details.");

    public static GrabFailure FromException(Exception error) => error switch
    {
        HttpRequestException { StatusCode: System.Net.HttpStatusCode.TooManyRequests } => new("search_busy", "Search is still busy.",
            "Retry in a minute. Episodes that already started will be kept."),
        HttpRequestException or TimeoutException or OperationCanceledException => Sources,
        _ => Unknown
    };

    internal static GrabFailure FromCandidates(int? floor, IEnumerable<CandidateRejection> candidates, bool searchFailed)
    {
        if (searchFailed) return Sources;
        var relevant = candidates.Where(c => !c.Reasons.Any(r =>
            r is "other_work" or "different_episode" or "unknown_episode" or "pack")).ToArray();
        if (relevant.Length > 0 && relevant.All(c => c.Reasons.Any(r => r is "below_floor" or "unknown_quality")))
            return new("quality_floor", floor is { } quality
                ? $"No release met the {quality}p minimum quality."
                : "No release had a known quality.",
                "Choose a lower quality and download again, or retry later for a better release.");
        if (relevant.Any(c => c.Reasons.Contains("no_seeders")))
            return new("no_seeders", "The available releases have no seeders.",
                "Retry later when seeders are online, or choose another release.");
        if (relevant.Length > 0 && relevant.All(c => c.Reasons.Contains("dub_not_preferred")))
            return new("audio_preference", "Only dubbed releases were found.",
                "Retry later for a subtitled release, or change your anime audio preference.");
        return new("no_release", floor is { } q ? $"No matching episode release was found at {q}p or higher."
            : "No matching episode release was found.", "Retry later, or search for another release.");
    }
}

public sealed record SeasonFailureReason(string Code, int Count, string Message, string Action);

public sealed record SeasonFailureSummary(string Message, string Action, bool Retryable,
    IReadOnlyList<SeasonFailureReason> Reasons)
{
    public static SeasonFailureSummary From(SeasonFanoutResult result)
    {
        var reasons = result.Transfers.Where(t => t.Status == "failed").Select(t => t.Failure ?? GrabFailure.Unknown)
            .GroupBy(f => f).OrderByDescending(g => g.Count())
            .Select(g => new SeasonFailureReason(g.Key.Code, g.Count(), g.Key.Message, g.Key.Action)).ToArray();
        var started = result.CoveredEpisodes.Count;
        var message = started == 0 ? "No episodes started." : $"{started} of {result.Transfers.Count} episodes started.";
        if (reasons.Length > 0)
            message += " " + string.Join(" ", reasons.Select(r => $"{r.Count} {(r.Count == 1 ? "episode" : "episodes")}: {r.Message}"));
        return new(message, string.Join(" ", reasons.Select(r => r.Action).Distinct()),
            result.Transfers.Any(t => t.Status == "failed" && (t.Failure?.Retryable ?? true)), reasons);
    }
}
