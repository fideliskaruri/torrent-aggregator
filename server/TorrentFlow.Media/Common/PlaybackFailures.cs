namespace TorrentFlow.Media.Common;

/// <summary>Port of src/lib/clients/errors.ts classifyPlaybackFailure.</summary>
public sealed record PlaybackFailure(string Kind, string FailureClass, bool Retryable, string DefaultMessage);

public sealed record PlaybackFailureSignals
{
    public Exception? Error { get; init; }
    public string? ErrorMessage { get; init; }
    public int? PeerCount { get; init; }
    public string? StallReason { get; init; }
    public bool Undecodable { get; init; }
    public bool NotFound { get; init; }
}

public static class PlaybackFailures
{
    public static PlaybackFailure Of(string kind) => kind switch
    {
        "NO_PEERS" => new(kind, "delivery", true, "This isn\u2019t available to play right now. Try again in a moment."),
        "CONNECTION_BLOCKED" => new(kind, "delivery", true, "The connection was blocked. Check your network and try again."),
        "STALLED" => new(kind, "delivery", true, "This stopped loading. Try again in a moment."),
        "NOT_FOUND" => new(kind, "not-found", false, "This isn\u2019t available."),
        "UNPLAYABLE" => new(kind, "playability", false, "This can\u2019t be played. Try a different version."),
        _ => new("ENGINE_ERROR", "engine", false, "Something went wrong. Try again."),
    };

    public static PlaybackFailure Classify(PlaybackFailureSignals s)
    {
        if (s.NotFound) return Of("NOT_FOUND");
        if (s.Undecodable) return Of("UNPLAYABLE");
        var hay = Hay(s);
        var hasError = s.Error is not null || s.ErrorMessage is not null;
        if (hasError && IsConnectionBlocked(hay)) return Of("CONNECTION_BLOCKED");
        var noPeers = s.PeerCount is null or 0;
        if (s.StallReason == "stalled") return Of(noPeers ? "NO_PEERS" : "STALLED");
        if (s.StallReason is not null && noPeers && !hasError) return Of("NO_PEERS");
        if (hasError) return Of(IsClientOffline(hay) && noPeers ? "NO_PEERS" : "ENGINE_ERROR");
        return Of(noPeers ? "NO_PEERS" : "ENGINE_ERROR");
    }

    private static string Hay(PlaybackFailureSignals s) =>
        $"{s.ErrorMessage ?? s.Error?.Message} {s.Error?.InnerException?.Message}".ToLowerInvariant();

    private static readonly string[] Blocked =
        ["econnreset", "econnrefused", "enetunreach", "ehostunreach", "enetdown", "ehostdown", "blocked", "und_err_connect", "connect timeout", "proxy"];

    private static readonly string[] Offline =
        ["econnrefused", "enotfound", "econnreset", "etimedout", "networkerror", "fetch failed", "aborted", "timeout", "und_err_connect", "connect timeout"];

    public static bool IsConnectionBlocked(string hay) => Blocked.Any(hay.Contains);
    public static bool IsClientOffline(string hay) => Offline.Any(hay.Contains);
}
