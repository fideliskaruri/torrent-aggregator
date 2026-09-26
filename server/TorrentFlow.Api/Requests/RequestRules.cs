using System.Globalization;
using System.Text.RegularExpressions;
using TorrentFlow.Metadata.Text;

namespace TorrentFlow.Api.Requests;

/// <summary><c>TorrentFlow:Requests</c>. Limits apply per requester.</summary>
public sealed class RequestOptions
{
    public const string SectionName = "TorrentFlow:Requests";

    /// <summary>Pending plus approved requests one person may have at once.</summary>
    public int MaxOpenPerUser { get; set; } = 10;

    /// <summary>New requests per person per minute.</summary>
    public int CreatesPerMinute { get; set; } = 5;

    /// <summary>Title searches and season lookups per person per minute.</summary>
    public int SearchesPerMinute { get; set; } = 30;
}

public static class MediaRequestStatus
{
    public const string Pending = "pending";
    public const string Approved = "approved";
    public const string Declined = "declined";
    public const string Fulfilled = "fulfilled";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";

    public static readonly string[] Open = [Pending, Approved];
    public static readonly string[] All = [Pending, Approved, Declined, Fulfilled, Failed, Cancelled];
}

public static class MediaRequestScope
{
    public const string Movie = "movie";
    public const string Seasons = "seasons";
    public const string Series = "series";
}

/// <summary>A validated work reference plus scope, ready to store.</summary>
public sealed record RequestDraft(
    string Provider, string? ProviderId, string WorkKey, string MediaType, string Title, int? Year, string? PosterUrl,
    string Scope, IReadOnlyList<int> Seasons, string? Note)
{
    public string Identity => RequestRules.Identity(Provider, ProviderId, MediaType, WorkKey);
}

/// <summary>Pure validation and overlap rules for media requests.</summary>
public static partial class RequestRules
{
    public const int MaxTitleLength = 300;
    public const int MaxNoteLength = 500;
    public const int MaxSeasons = 100;
    public const int MaxSeasonNumber = 500;
    public static readonly string[] Providers = ["tmdb", "anilist", "tvmaze", "itunes"];
    public static readonly string[] MediaTypes = ["movie", "tv", "anime"];

    private static readonly string[] PosterHosts = ["image.tmdb.org", "s4.anilist.co", "static.tvmaze.com"];
    private static readonly string[] PosterHostSuffixes = [".anilist.co", ".tvmaze.com", ".mzstatic.com"];

    /// <summary>Only https artwork from the catalogs the search uses; anything else is dropped so the owner's inbox never loads an arbitrary URL.</summary>
    public static string? SafePosterUrl(string? raw, string? extraHost = null)
    {
        if (string.IsNullOrWhiteSpace(raw) || raw.Length > 2048) return null;
        if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo) || !uri.IsDefaultPort) return null;
        var host = uri.IdnHost.ToLowerInvariant();
        var ok = PosterHosts.Contains(host) || PosterHostSuffixes.Any(s => host.EndsWith(s, StringComparison.Ordinal))
            || (!string.IsNullOrEmpty(extraHost) && host == extraHost.ToLowerInvariant());
        return ok ? uri.AbsoluteUri : null;
    }

    /// <summary>The identity used to spot duplicates: the catalog id when there is one, else the work key.</summary>
    public static string Identity(string provider, string? providerId, string mediaType, string workKey) =>
        providerId is { Length: > 0 } ? $"{provider}:{mediaType}:{providerId}" : $"work:{mediaType}:{workKey}";

    public static IReadOnlyList<int> ParseSeasons(string? stored) =>
        string.IsNullOrWhiteSpace(stored) ? [] :
        stored.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(s => int.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : 0)
            .Where(n => n >= 1).Distinct().Order().ToList();

    public static string? FormatSeasons(IReadOnlyList<int> seasons) =>
        seasons.Count == 0 ? null : string.Join(',', seasons.Select(s => s.ToString(CultureInfo.InvariantCulture)));

    /// <summary>movie↔movie and series↔anything overlap; two season lists overlap when they share a season.</summary>
    public static bool Overlaps(string scopeA, IReadOnlyList<int> seasonsA, string scopeB, IReadOnlyList<int> seasonsB)
    {
        if (scopeA == MediaRequestScope.Movie || scopeB == MediaRequestScope.Movie) return scopeA == scopeB;
        if (scopeA == MediaRequestScope.Series || scopeB == MediaRequestScope.Series) return true;
        return seasonsA.Intersect(seasonsB).Any();
    }

    /// <summary>Validates a create body. Returns the draft, or an error message for a 400.</summary>
    public static (RequestDraft? Draft, string? Error) Validate(
        string? provider, string? providerId, string? mediaType, string? title, int? year, string? posterUrl,
        string? scope, IReadOnlyList<int>? seasons, string? note, string? extraPosterHost = null)
    {
        provider = provider?.Trim().ToLowerInvariant();
        if (provider is null || !Providers.Contains(provider)) return (null, "provider must be one of tmdb, anilist, tvmaze, itunes");
        providerId = string.IsNullOrWhiteSpace(providerId) ? null : providerId.Trim();
        if (providerId is not null && !ProviderIdPattern().IsMatch(providerId)) return (null, "providerId must be a catalog number");
        mediaType = mediaType?.Trim().ToLowerInvariant();
        if (mediaType is null || !MediaTypes.Contains(mediaType)) return (null, "mediaType must be movie, tv or anime");
        title = title is null ? null : ControlChars().Replace(title, " ").Trim();
        if (string.IsNullOrEmpty(title)) return (null, "title is required");
        if (title.Length > MaxTitleLength) return (null, $"title must be at most {MaxTitleLength} characters");
        if (year is not null && (year < 1870 || year > DateTime.UtcNow.Year + 10)) return (null, "year is out of range");
        scope = scope?.Trim().ToLowerInvariant();
        if (scope is not (MediaRequestScope.Movie or MediaRequestScope.Seasons or MediaRequestScope.Series))
            return (null, "scope must be movie, seasons or series");
        if (mediaType == "movie" && scope != MediaRequestScope.Movie) return (null, "A film can only be requested as a movie");
        if (mediaType == "tv" && scope == MediaRequestScope.Movie) return (null, "A series is requested as seasons or the whole series");
        IReadOnlyList<int> list = [];
        if (scope == MediaRequestScope.Seasons)
        {
            if (seasons is null || seasons.Count == 0) return (null, "Pick at least one season");
            if (seasons.Count > MaxSeasons) return (null, $"At most {MaxSeasons} seasons per request");
            if (seasons.Any(s => s < 1 || s > MaxSeasonNumber)) return (null, $"Season numbers must be between 1 and {MaxSeasonNumber}");
            list = seasons.Distinct().Order().ToList();
        }
        else if (seasons is { Count: > 0 }) return (null, "seasons only apply to a seasons request");
        note = note is null ? null : NoteControlChars().Replace(note, " ").Trim();
        if (note is { Length: 0 }) note = null;
        if (note is { Length: > MaxNoteLength }) return (null, $"note must be at most {MaxNoteLength} characters");
        var isSeries = scope != MediaRequestScope.Movie;
        var workKey = WorkKeys.WorkKeyFor(title, isSeries ? null : year);
        if (workKey.Length == 0 || workKey.Length > 400) return (null, "title is not usable");
        return (new RequestDraft(provider, providerId, workKey, mediaType, title, year, SafePosterUrl(posterUrl, extraPosterHost), scope, list, note), null);
    }

    [GeneratedRegex("^[0-9]{1,12}$")]
    private static partial Regex ProviderIdPattern();

    [GeneratedRegex(@"[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+")]
    private static partial Regex ControlChars();

    // Notes keep line breaks; other control and bidi-override characters become a space.
    [GeneratedRegex(@"[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF-[\n]]+")]
    private static partial Regex NoteControlChars();
}
