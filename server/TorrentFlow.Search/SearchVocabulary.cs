using static TorrentFlow.Search.EpisodeParser;

namespace TorrentFlow.Search;

public static class SearchVocabulary
{
    public static IReadOnlyList<string> Categories { get; } = Array.AsReadOnly(new[] { "all", "anime", "movies", "tv", "music", "apps", "games", "books" });
    public static string? ParseCategory(string? value) => value?.Trim().ToLowerInvariant() is { } category && Categories.Contains(category) ? category : null;
    public static string? ParseScope(string? value) => value?.Trim().ToLowerInvariant() is { } scope
        && new[] { "all", "movies", "series", "anime", "music", "games", "software", "books", "everything" }.Contains(scope) ? scope : null;
    public static string SourceLabel(string id) => id switch { "nyaa" => "Nyaa", "apibay" => "The Pirate Bay", "torrentscsv" => "Torrents-CSV", "eztv" => "EZTV", "yts" => "YTS", "archive" => "Internet Archive", "torznab" => "Torznab", _ => id };
    public static string SourceShortLabel(string id) => id switch { "apibay" => "TPB", "torrentscsv" => "CSV", "archive" => "IA", _ => SourceLabel(id) };
    public static string SourceErrorReason(string? error)
    {
        if (string.IsNullOrEmpty(error)) return "Unavailable";
        (string Pattern, string Message)[] reasons = [
            (@"\b(403|forbidden)\b", "Blocked this request"), (@"\b(429|rate limit)\b", "Rate limited"),
            (@"\b(401|unauthorized)\b", "Rejected this request"), (@"\b404\b", "Endpoint not found"),
            (@"\b5\d\d\b", "Having server trouble"), ("timeout|timed out|abort", "Timed out"),
            ("enotfound|dns|getaddrinfo", "Could not be resolved"), ("econnrefused|econnreset|socket|network|fetch failed", "Unreachable")
        ];
        return reasons.FirstOrDefault(r => Match(error, r.Pattern).Success).Message ?? "Unavailable";
    }
    public static string DescribeSourceFailure(string id, string? error) => $"{SourceLabel(id)} — {SourceErrorReason(error)}";
}
