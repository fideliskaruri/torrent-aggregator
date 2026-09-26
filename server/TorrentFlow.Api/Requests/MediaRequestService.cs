using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Metadata.Search;
using TorrentFlow.Metadata.Title;

namespace TorrentFlow.Api.Requests;

/// <summary>A title as a requester sees it: catalog identity and art only, never files, releases or owner progress.</summary>
public sealed record RequesterTitle(
    string Key, string Title, int? Year, string MediaType, bool IsSeries, string? Format, string Category,
    string Provider, string? ProviderId, string? PosterUrl, string? Overview, string? ReleaseDate,
    bool InLibrary, string? RequestStatus, string? RequestId);

/// <summary>A requester's own request.</summary>
public sealed record RequesterRequest(
    string Id, string Title, int? Year, string MediaType, string Provider, string? ProviderId, string? PosterUrl,
    string Scope, IReadOnlyList<int> Seasons, string? Note, string Status, string? DecisionReason,
    DateTime? DecidedAt, DateTime CreatedAt, DateTime UpdatedAt);

/// <summary>The owner's read-only view of a request.</summary>
public sealed record OwnerRequest(
    string Id, string RequestedBy, string Title, int? Year, string MediaType, string Provider, string? ProviderId,
    string WorkKey, string? PosterUrl, string Scope, IReadOnlyList<int> Seasons, string? Note, string Status,
    string? DecisionReason, DateTime? DecidedAt, DateTime CreatedAt, DateTime UpdatedAt,
    string? WatchListItemId, string? AcquisitionTargetId);

public enum CreateOutcome { Created, InLibrary, Duplicate, TooManyOpen }

/// <summary>The catalog lookups a requester may trigger; a seam so tests never reach TMDB or AniList.</summary>
public interface IRequesterCatalog
{
    Task<WorkSearchOutcome> SearchAsync(string scope, string query, int take, CancellationToken ct);

    Task<IReadOnlyList<int>> SeasonsAsync(RequestDraft work, CancellationToken ct);
}

public sealed class RequesterCatalog(WorkSearchService works, TitleExtrasService extras) : IRequesterCatalog
{
    public Task<WorkSearchOutcome> SearchAsync(string scope, string query, int take, CancellationToken ct) => works.SearchAsync(scope, query, take, ct);

    public async Task<IReadOnlyList<int>> SeasonsAsync(RequestDraft work, CancellationToken ct)
    {
        var payload = await extras.GetAsync(new TitleExtrasQuery(work.WorkKey, work.Title, work.Year, work.MediaType, null,
            work.Provider, work.ProviderId, null, SeriesHint: true), ct);
        return payload.Seasons;
    }
}

public sealed class MediaRequestService(
    IDbContextFactory<TorrentFlowDbContext> factory,
    IRequesterCatalog catalog,
    IOptionsMonitor<RequestOptions> options,
    TimeProvider time)
{
    private const int SearchTake = 20;
    // Duplicate and cap checks read then write; one writer at a time keeps two quick taps from both passing.
    private readonly SemaphoreSlim _createLock = new(1, 1);

    public RequestOptions Options => options.CurrentValue;

    public async Task<(IReadOnlyList<RequesterTitle> Results, bool Partial)> SearchAsync(string userId, string scope, string query, CancellationToken ct)
    {
        var outcome = await catalog.SearchAsync(scope, query, SearchTake, ct);
        await using var db = await factory.CreateDbContextAsync(ct);
        var library = await LibraryIndex.LoadAsync(db, ct);
        var open = await OpenRequestsAsync(db, userId, ct);
        var results = outcome.Results.Select(hit =>
        {
            var identity = RequestRules.Identity(hit.Provider, hit.ProviderId, hit.MediaType, hit.WorkKey);
            var request = open.FirstOrDefault(r => r.Identity == identity);
            return new RequesterTitle(hit.WorkKey, hit.Title, hit.Year, hit.MediaType, hit.IsSeries, hit.Format, hit.Category,
                hit.Provider, hit.ProviderId, hit.PosterUrl, hit.Overview, hit.ReleaseDate,
                library.Contains(hit.WorkKey, hit.MediaType, hit.ProviderId), request?.Row.Status, request?.Row.Id);
        }).ToList();
        return (results, outcome.Partial);
    }

    public async Task<IReadOnlyList<int>> SeasonsAsync(RequestDraft work, CancellationToken ct)
    {
        var seasons = await catalog.SeasonsAsync(work, ct);
        return seasons.Where(s => s >= 1 && s <= RequestRules.MaxSeasonNumber).Distinct().Order().Take(RequestRules.MaxSeasons).ToList();
    }

    public async Task<IReadOnlyList<RequesterRequest>> MineAsync(string userId, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var rows = await db.MediaRequests.AsNoTracking().Where(r => r.RequestedByUserId == userId)
            .OrderByDescending(r => r.CreatedAt).Take(200).ToListAsync(ct);
        return rows.Select(ToRequester).ToList();
    }

    public async Task<IReadOnlyList<OwnerRequest>> AllAsync(string? status, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var query = db.MediaRequests.AsNoTracking();
        if (status is not null) query = query.Where(r => r.Status == status);
        var rows = await query.OrderByDescending(r => r.CreatedAt).Take(500)
            .Select(r => new { Row = r, Email = r.RequestedBy.Email }).ToListAsync(ct);
        return rows.Select(x => new OwnerRequest(x.Row.Id, x.Email ?? "", x.Row.Title, x.Row.Year, x.Row.MediaType, x.Row.Provider,
            x.Row.ProviderId, x.Row.WorkKey, x.Row.PosterUrl, x.Row.Scope, RequestRules.ParseSeasons(x.Row.Seasons), x.Row.Note, x.Row.Status,
            x.Row.DecisionReason, x.Row.DecidedAt, x.Row.CreatedAt, x.Row.UpdatedAt, x.Row.WatchListItemId, x.Row.AcquisitionTargetId)).ToList();
    }

    public async Task<int> PendingCountAsync(CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.MediaRequests.CountAsync(r => r.Status == MediaRequestStatus.Pending, ct);
    }

    public async Task<(CreateOutcome Outcome, RequesterRequest? Request)> CreateAsync(string userId, RequestDraft draft, CancellationToken ct)
    {
        await _createLock.WaitAsync(ct);
        try
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            var library = await LibraryIndex.LoadAsync(db, ct);
            if (library.Contains(draft.WorkKey, draft.MediaType, draft.ProviderId)) return (CreateOutcome.InLibrary, null);
            var open = await OpenRequestsAsync(db, userId, ct);
            if (open.Any(r => r.Identity == draft.Identity && RequestRules.Overlaps(r.Row.Scope, RequestRules.ParseSeasons(r.Row.Seasons), draft.Scope, draft.Seasons)))
                return (CreateOutcome.Duplicate, null);
            if (open.Count >= Math.Max(1, options.CurrentValue.MaxOpenPerUser)) return (CreateOutcome.TooManyOpen, null);
            var now = time.GetUtcNow().UtcDateTime;
            var row = new MediaRequest
            {
                Id = Ids.New(), RequestedByUserId = userId, Provider = draft.Provider, ProviderId = draft.ProviderId, WorkKey = draft.WorkKey,
                MediaType = draft.MediaType, Title = draft.Title, Year = draft.Year, PosterUrl = draft.PosterUrl, Scope = draft.Scope,
                Seasons = RequestRules.FormatSeasons(draft.Seasons), Note = draft.Note, Status = MediaRequestStatus.Pending,
                CreatedAt = now, UpdatedAt = now,
            };
            db.MediaRequests.Add(row);
            await db.SaveChangesAsync(ct);
            return (CreateOutcome.Created, ToRequester(row));
        }
        finally
        {
            _createLock.Release();
        }
    }

    /// <summary>Null when the request is not this user's (or does not exist); otherwise the row after the attempt.</summary>
    public async Task<(bool Found, bool Cancelled, RequesterRequest? Request)> CancelAsync(string userId, string id, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var row = await db.MediaRequests.FirstOrDefaultAsync(r => r.Id == id && r.RequestedByUserId == userId, ct);
        if (row is null) return (false, false, null);
        if (row.Status != MediaRequestStatus.Pending) return (true, false, ToRequester(row));
        row.Status = MediaRequestStatus.Cancelled;
        row.UpdatedAt = time.GetUtcNow().UtcDateTime;
        await db.SaveChangesAsync(ct);
        return (true, true, ToRequester(row));
    }

    private static RequesterRequest ToRequester(MediaRequest r) => new(r.Id, r.Title, r.Year, r.MediaType, r.Provider, r.ProviderId, r.PosterUrl,
        r.Scope, RequestRules.ParseSeasons(r.Seasons), r.Note, r.Status, r.DecisionReason, r.DecidedAt, r.CreatedAt, r.UpdatedAt);

    private sealed record OpenRequest(MediaRequest Row, string Identity);

    private static async Task<List<OpenRequest>> OpenRequestsAsync(TorrentFlowDbContext db, string userId, CancellationToken ct)
    {
        var rows = await db.MediaRequests.AsNoTracking()
            .Where(r => r.RequestedByUserId == userId && MediaRequestStatus.Open.Contains(r.Status)).ToListAsync(ct);
        return rows.Select(r => new OpenRequest(r, RequestRules.Identity(r.Provider, r.ProviderId, r.MediaType, r.WorkKey))).ToList();
    }

    /// <summary>What the owner already has or is fetching, matched the way the title page matches its library row.</summary>
    private sealed class LibraryIndex
    {
        private readonly List<(string MediaType, string ExternalId, string Title)> _watches;
        private readonly HashSet<string> _targetKeys;

        private LibraryIndex(List<(string, string, string)> watches, HashSet<string> targetKeys)
        {
            _watches = watches;
            _targetKeys = targetKeys;
        }

        public static async Task<LibraryIndex> LoadAsync(TorrentFlowDbContext db, CancellationToken ct)
        {
            var watches = await db.WatchListItems.AsNoTracking().Where(w => w.UserId == LocalUser.Id)
                .OrderByDescending(w => w.UpdatedAt).Take(2000)
                .Select(w => new { w.MediaType, w.ExternalId, w.Title }).ToListAsync(ct);
            var keys = await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.Status != "failed")
                .Select(t => t.WorkKey).Distinct().Take(5000).ToListAsync(ct);
            return new LibraryIndex(watches.Select(w => (w.MediaType, w.ExternalId, w.Title)).ToList(), keys.ToHashSet(StringComparer.Ordinal));
        }

        public bool Contains(string workKey, string mediaType, string? providerId)
        {
            if (_targetKeys.Contains(workKey)) return true;
            return _watches.Any(w =>
                (w.MediaType == mediaType && (providerId is not null && w.ExternalId == providerId || w.ExternalId == "work:" + workKey))
                || ReleaseSelection.MatchesWork(workKey, w.Title));
        }
    }
}
