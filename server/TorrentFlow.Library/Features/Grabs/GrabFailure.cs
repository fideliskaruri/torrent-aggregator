using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>
/// Why a grab did not start, in the owner's words: <see cref="Message"/> says what happened and <see cref="Action"/> is the
/// one next step. <see cref="Brief"/> is the same fact without a subject, so a season can group episodes by it.
/// Copy rules (docs/rules.md): plain words, no internal counts, no em dashes. <see cref="Detail"/> is the exception: the
/// record of what the search really returned and which filter turned each result down ("12 results, all season packs"),
/// kept in the activity log and the wanted list so the owner can see why something is still missing.
/// </summary>
public sealed record GrabFailure(string Code, string Message, string Action, bool Retryable = true)
{
    public const string PickYourself = "Pick a release yourself.";

    public string Brief { get; init; } = "could not be started";
    public string? Detail { get; init; }
    public string Sentence => $"{Message} {Action}";

    /// <summary>
    /// Failures that mean the search really happened and found nothing usable. Only these count toward the season pack
    /// fallback; refused, busy, storage, setup and unknown failures never do. A release held back or refused for its
    /// language is never a real miss: the release exists (docs/release-language.md).
    /// </summary>
    public static bool IsRealMiss(string? code) => code is "no_release" or "quality_floor" or "no_seeders";

    public static readonly GrabFailure Sources = new("sources_unavailable",
        "We couldn't reach the search sites, so nothing was searched.",
        "Check your connection and try again in a few minutes.") { Brief = "could not be searched" };
    public static readonly GrabFailure Storage = new("storage_limit",
        "There isn't enough room under your storage limit.",
        "Free some space or raise the limit in Settings, then try again.") { Brief = "did not fit under the storage limit" };
    public static readonly GrabFailure Metadata = new("metadata_unavailable",
        "The release we picked never sent its file list.",
        "Try again later, or pick a release yourself.") { Brief = "had a release that never sent its file list" };
    public static readonly GrabFailure BadRelease = new("bad_release",
        "The release we picked had a program file or no video in it.", PickYourself)
        { Brief = "had only unsafe or fake releases" };
    /// <summary>The engine's file-list check found the wrong audio. It passes: the wanted queue keeps looking (docs/release-language.md).</summary>
    public static readonly GrabFailure WrongLanguage = new("audio_language",
        "The release we picked turned out to be in another language.",
        "We'll keep looking. You can also pick a release yourself.") { Brief = "had releases only in another language" };
    public static readonly GrabFailure Unknown = new("download_failed",
        "The download could not be started.",
        "Try again. If it keeps failing, pick a release yourself.");

    /// <summary>"season 1, episode 5" for an episode; the title otherwise.</summary>
    public static string Subject(string? title, int? season, int? episode) =>
        season is { } s && episode is { } e ? $"season {s}, episode {e}" : string.IsNullOrWhiteSpace(title) ? "this title" : title.Trim();

    public static GrabFailure NotFound(string subject, int? floor) => new("no_release",
        floor is { } q ? $"We couldn't find {subject} at {q}p or better." : $"We couldn't find {subject}.", PickYourself)
        { Brief = "could not be found" };
    public static GrabFailure BelowQuality(string subject, int floor) => new("quality_floor",
        $"We found {subject}, but only below {floor}p.", "Pick a release yourself, or choose a lower quality.")
        { Brief = $"only turned up below {floor}p" };
    public static GrabFailure NoSeeders(string subject) => new("no_seeders",
        $"We found {subject}, but nobody is sharing it right now.", "Try again later, or pick a release yourself.")
        { Brief = "had nobody sharing them" };

    public static GrabFailure FromException(Exception error) => error switch
    {
        HttpRequestException { StatusCode: System.Net.HttpStatusCode.TooManyRequests } => new("search_busy",
            "The search sites are busy right now.", "Try again in a minute. Anything that already started is kept.")
            { Brief = "hit busy search sites" },
        HttpRequestException or TimeoutException or OperationCanceledException => Sources,
        _ => Unknown
    };

    /// <summary>
    /// What a search really returned, for <see cref="Detail"/>: which sites refused, "no results", or the results
    /// counted by the first filter that turned each one down.
    /// </summary>
    public static string Explain(IEnumerable<SourceStatus> sources, int total, IEnumerable<(string Label, int Count)> filtered)
    {
        var refused = sources.Where(s => !string.IsNullOrWhiteSpace(s.Error)).GroupBy(s => s.Id, StringComparer.OrdinalIgnoreCase)
            .Select(g => $"{g.Key} ({g.First().Error!.Trim()})").ToArray();
        var refusal = refused.Length == 0 ? null : $"search refused by {string.Join(", ", refused)}";
        if (total == 0) return refusal ?? "no results";
        var groups = filtered.Where(g => g.Count > 0).OrderByDescending(g => g.Count).ToArray();
        var counted = $"{total} result{(total == 1 ? "" : "s")}";
        var text = groups.Length == 1 && groups[0].Count == total && total > 1 ? $"{counted}, all {groups[0].Label}"
            : groups.Length == 0 ? $"{counted}, none taken" : $"{counted}: {string.Join(", ", groups.Select(g => $"{g.Count} {g.Label}"))}";
        return refusal == null ? text : $"{text}; {refusal}";
    }

    /// <summary>The episode path's rejection codes (<see cref="EpisodeRejections"/>) in words, counted by each result's first reason.</summary>
    internal static string Explain(IEnumerable<SourceStatus> sources, IReadOnlyCollection<CandidateRejection> candidates, int? floor) =>
        Explain(sources, candidates.Count, candidates.GroupBy(c => c.Reasons.FirstOrDefault() ?? "not_selected")
            .Select(g => (ReasonLabel(g.Key, floor), g.Count())));

    private static string ReasonLabel(string reason, int? floor) => reason switch
    {
        "other_work" => "other titles",
        "pack" => "season packs",
        "unknown_episode" => "with no episode number",
        "different_episode" => "other episodes",
        "below_floor" => $"below {floor}p",
        "unknown_quality" => "with no quality in the name",
        "no_link" => "with no download link",
        "no_seeders" => "with no seeders",
        _ when ReleaseLanguage.IsReason(reason) => ReleaseLanguage.ReasonLabel(reason),
        "unsafe" => "unsafe files",
        "query_filter" => "filtered out by the search",
        "send_failed" => "that failed to start",
        _ => "not taken"
    };

    internal static GrabFailure FromCandidates(string subject, int? floor, IEnumerable<CandidateRejection> candidates, bool searchFailed)
    {
        if (searchFailed) return Sources;
        var rows = candidates.ToArray();
        var mine = rows.Where(c => !c.Reasons.Contains("other_work")).ToArray();
        var relevant = mine.Where(c => !c.Reasons.Any(r => r is "different_episode" or "unknown_episode" or "pack")).ToArray();
        if (relevant.Length > 0 && floor is { } quality && relevant.All(c => c.Reasons.Any(r => r is "below_floor" or "unknown_quality")))
            return BelowQuality(subject, quality);
        if (relevant.Any(c => c.Reasons.Contains("no_seeders"))) return NoSeeders(subject);
        return NotFound(subject, floor);
    }
}

public sealed record SeasonFailureReason(string Code, int Count, string Message, string Action);

public sealed record SeasonFailureSummary(string Message, string Action, bool Retryable,
    IReadOnlyList<SeasonFailureReason> Reasons)
{
    public static SeasonFailureSummary From(SeasonFanoutResult result)
    {
        var failures = result.Transfers.Where(t => t.Status == "failed").Select(t => t.Failure ?? GrabFailure.Unknown).ToArray();
        var reasons = failures.GroupBy(f => f.Code).OrderByDescending(g => g.Count())
            .Select(g => new SeasonFailureReason(g.Key, g.Count(), g.First().Brief, g.First().Action)).ToArray();
        var started = result.CoveredEpisodes.Count;
        var total = result.Transfers.Count;
        var message = started == 0 ? "No episodes started."
            : $"Started {started} of {total} episodes.";
        if (reasons.Length > 0)
            message += " " + string.Join(" ", reasons.Select(r =>
                $"{r.Count} {(r.Count == 1 ? "episode" : "episodes")} {r.Message}."));
        // One next step: the most common failure's action.
        var action = reasons.FirstOrDefault()?.Action ?? "";
        return new(message, action, failures.Any(f => f.Retryable), reasons);
    }

    /// <summary>A season download's one notification, counts only: "Frieren S1: 36 started, 2 not found yet".</summary>
    public static SeasonFailureSummary Counts(string title, int season, int started, int notFound) =>
        new($"{title} S{season}: {started} started" + (notFound > 0 ? $", {notFound} not found yet" : ""),
            notFound > 0 ? "We'll keep looking for the rest." : "", notFound > 0, []);
}
