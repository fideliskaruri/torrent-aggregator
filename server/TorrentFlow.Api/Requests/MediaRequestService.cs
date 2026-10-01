using Microsoft.EntityFrameworkCore;
using TorrentFlow.Api.Notifications;
using Microsoft.Extensions.Options;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Metadata.Browse;
using TorrentFlow.Metadata.Search;
using TorrentFlow.Metadata.Title;

namespace TorrentFlow.Api.Requests;

/// <summary>A title as a requester sees it: catalog identity and art only, never files, releases or owner progress.</summary>
public sealed record RequesterTitle(
    string Key, string Title, int? Year, string MediaType, bool IsSeries, string? Format, string Category,
    string Provider, string? ProviderId, string? PosterUrl, string? Overview, string? ReleaseDate,
    bool InLibrary, string? RequestStatus, string? RequestId);

/// <summary>
/// Own-request + library flags for a catalog hit; never other users' requests. <see cref="RequestStatus"/> is the
/// request's derived phase (<see cref="LibraryOnDisk.Progress"/>); a series is never <see cref="InLibrary"/> as a whole,
/// only by its <see cref="AvailableSeasons"/>.
/// </summary>
public sealed record CatalogRequestState(bool InLibrary, string? RequestStatus, string? RequestId, IReadOnlyList<int>? AvailableSeasons = null,
    int Done = 0, int Total = 0);

/// <summary>A requester's own request. <see cref="Status"/> is the derived phase; <see cref="Done"/> of <see cref="Total"/> counts episodes (or the film) on disk.</summary>
public sealed record RequesterRequest(
    string Id, string Title, int? Year, string MediaType, string Provider, string? ProviderId, string? PosterUrl,
    string Scope, IReadOnlyList<int> Seasons, string? Note, string Status, string? DecisionReason,
    DateTime? DecidedAt, DateTime CreatedAt, DateTime UpdatedAt, int Done = 0, int Total = 0);

/// <summary>The owner's read-only view of a request.</summary>
public sealed record OwnerRequest(
    string Id, string RequestedBy, string Title, int? Year, string MediaType, string Provider, string? ProviderId,
    string WorkKey, string? PosterUrl, string Scope, IReadOnlyList<int> Seasons, string? Note, string Status,
    string? DecisionReason, DateTime? DecidedAt, DateTime CreatedAt, DateTime UpdatedAt,
    string? WatchListItemId, string? AcquisitionTargetId)
{
    /// <summary>Everyone who asked for this title and scope: one card, one decision (<see cref="RequestRules.SameAsk"/>).</summary>
    public IReadOnlyList<string> Requesters { get; init; } = [];
    /// <summary>The derived phase the requesters see, with its counts.</summary>
    public string Phase { get; init; } = "";
    public int Done { get; init; }
    public int Total { get; init; }
}

public enum CreateOutcome { Created, InLibrary, Duplicate, TooManyOpen }

/// <summary>A library title as a requester sees it: no files, no progress, nothing playable.</summary>
public sealed record RequesterLibraryTitle(string Key, string Title, int? Year, string MediaType, string? PosterUrl);

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
    TimeProvider time,
    NotificationService notifications,
    BrowseService browse)
{
    private const int SearchTake = 20;
    // Duplicate and cap checks read then write; one writer at a time keeps two quick taps from both passing.
    private readonly SemaphoreSlim _createLock = new(1, 1);

    public RequestOptions Options => options.CurrentValue;

    public async Task<(IReadOnlyList<RequesterTitle> Results, bool Partial)> SearchAsync(string userId, string scope, string query, CancellationToken ct)
    {
        var outcome = await catalog.SearchAsync(scope, query, SearchTake, ct);
        await using var db = await factory.CreateDbContextAsync(ct);
        var library = await LibraryOnDisk.LoadAsync(db, browse, ct);
        var open = await OpenRequestsAsync(db, userId, ct);
        var results = outcome.Results.Select(hit =>
        {
            var state = StateFor(library, open, hit.WorkKey, hit.MediaType, hit.ProviderId, hit.Provider);
            return new RequesterTitle(hit.WorkKey, hit.Title, hit.Year, hit.MediaType, hit.IsSeries, hit.Format, hit.Category,
                hit.Provider, hit.ProviderId, hit.PosterUrl, hit.Overview, hit.ReleaseDate,
                state.InLibrary, state.RequestStatus, state.RequestId);
        }).ToList();
        return (results, outcome.Partial);
    }

    /// <summary>
    /// Same library + open-request flags the requester title search uses, for shared catalog endpoints
    /// (<c>/api/search/titles</c>, <c>/api/title/{workKey}</c>). Scoped to <paramref name="userId"/> only.
    /// </summary>
    public async Task<IReadOnlyList<CatalogRequestState>> AnnotateCatalogAsync(
        string userId,
        IReadOnlyList<(string WorkKey, string MediaType, string? ProviderId, string Provider)> items,
        CancellationToken ct)
    {
        if (items.Count == 0) return [];
        await using var db = await factory.CreateDbContextAsync(ct);
        var library = await LibraryOnDisk.LoadAsync(db, browse, ct);
        var open = await OpenRequestsAsync(db, userId, ct);
        return items.Select(i => StateFor(library, open, i.WorkKey, i.MediaType, i.ProviderId, i.Provider)).ToList();
    }

    private static CatalogRequestState StateFor(LibraryOnDisk library, List<OpenRequest> open, string workKey, string mediaType, string? providerId, string provider)
    {
        var identity = RequestRules.Identity(provider, providerId, mediaType, workKey);
        // Prefer catalog identity; fall back to work key so title pages without provider ids still see the caller's request.
        var request = open.FirstOrDefault(r => r.Identity == identity)
            ?? open.FirstOrDefault(r => string.Equals(r.Row.WorkKey, workKey, StringComparison.OrdinalIgnoreCase));
        var film = !RequestRules.IsSeriesType(mediaType);
        var progress = request is null ? null : library.Progress(request.Row);
        return new CatalogRequestState(film && library.HasFilm(workKey), progress?.Phase, request?.Row.Id,
            film ? [] : library.AvailableSeasons(workKey), progress?.Done ?? 0, progress?.Total ?? 0);
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
        var posters = await WorkPosters.LoadAsync(db, rows.Select(r => r.WorkKey), ct);
        await WorkPosters.StoreOnRequestsAsync(db, rows.Select(r => (r.Id, r.PosterUrl, WorkPosters.Pick(posters, r.WorkKey, r.PosterUrl))), ct);
        var library = await LibraryOnDisk.LoadAsync(db, browse, ct);
        return rows.Select(r => ToRequester(r, library.Progress(r)) with { PosterUrl = WorkPosters.Pick(posters, r.WorkKey, r.PosterUrl) }).ToList();
    }

    public async Task<IReadOnlyList<OwnerRequest>> AllAsync(string? status, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var query = db.MediaRequests.AsNoTracking();
        if (status is not null) query = query.Where(r => r.Status == status);
        var rows = await query.OrderByDescending(r => r.CreatedAt).Take(500)
            .Select(r => new { Row = r, Email = r.RequestedBy.Email }).ToListAsync(ct);
        var posters = await WorkPosters.LoadAsync(db, rows.Select(x => x.Row.WorkKey), ct);
        await WorkPosters.StoreOnRequestsAsync(db, rows.Select(x => (x.Row.Id, x.Row.PosterUrl, WorkPosters.Pick(posters, x.Row.WorkKey, x.Row.PosterUrl))), ct);
        var library = await LibraryOnDisk.LoadAsync(db, browse, ct);
        // The same title and scope asked by several friends is one card: the oldest ask leads, everyone is named.
        return rows.GroupBy(x => (RequestRules.SameAskKey(x.Row), x.Row.Status))
            .Select(g =>
            {
                var lead = g.OrderBy(x => x.Row.CreatedAt).First();
                var progress = library.Progress(lead.Row);
                return new OwnerRequest(lead.Row.Id, lead.Email ?? "", lead.Row.Title, lead.Row.Year, lead.Row.MediaType, lead.Row.Provider,
                    lead.Row.ProviderId, lead.Row.WorkKey, WorkPosters.Pick(posters, lead.Row.WorkKey, lead.Row.PosterUrl), lead.Row.Scope,
                    RequestRules.ParseSeasons(lead.Row.Seasons), lead.Row.Note, lead.Row.Status, lead.Row.DecisionReason, lead.Row.DecidedAt,
                    lead.Row.CreatedAt, g.Max(x => x.Row.UpdatedAt), lead.Row.WatchListItemId, lead.Row.AcquisitionTargetId)
                {
                    Requesters = g.OrderBy(x => x.Row.CreatedAt).Select(x => x.Email ?? "").Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
                    Phase = progress.Phase, Done = progress.Done, Total = progress.Total,
                };
            })
            .OrderByDescending(r => r.CreatedAt).ToList();
    }

    public async Task<int> PendingCountAsync(CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var pending = await db.MediaRequests.AsNoTracking().Where(r => r.Status == MediaRequestStatus.Pending).ToListAsync(ct);
        return pending.Select(RequestRules.SameAskKey).Distinct().Count();
    }

    /// <summary>
    /// What a requester may browse: the Downloaded rail's works (files on disk, <see cref="BrowseService.DownloadedAsync"/>),
    /// the same source as the owner's. Catalog identity and art only.
    /// </summary>
    public async Task<IReadOnlyList<RequesterLibraryTitle>> LibraryAsync(CancellationToken ct)
    {
        var rail = await browse.DownloadedAsync(LocalUser.Id, 500, ct);
        return (rail?.Cards ?? []).Select(c => new RequesterLibraryTitle(
                c.WorkKey ?? TorrentFlow.Core.Text.WorkKeySlug.WorkKeyFor(c.Title, c.Year), c.Title, c.Year,
                c.MediaType ?? "movie", c.PosterUrl))
            .DistinctBy(t => t.Key).OrderBy(t => t.Title, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public async Task<(CreateOutcome Outcome, RequesterRequest? Request)> CreateAsync(string userId, RequestDraft draft, CancellationToken ct)
    {
        await _createLock.WaitAsync(ct);
        try
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            var library = await LibraryOnDisk.LoadAsync(db, browse, ct);
            if (draft.Scope == MediaRequestScope.Movie ? library.HasFilm(draft.WorkKey)
                : draft.Scope == MediaRequestScope.Seasons && draft.Seasons.All(library.AvailableSeasons(draft.WorkKey).Contains))
                return (CreateOutcome.InLibrary, null);
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
            // Someone else already asked for the same title and scope: this ask joins theirs. Pending, it waits on the
            // same card; approved, it is approved now and shares what is already downloading. Nothing is grabbed again.
            var askKey = RequestRules.SameAskKey(row);
            var others = await db.MediaRequests.AsNoTracking().Where(r => r.WorkKey == row.WorkKey && r.RequestedByUserId != userId &&
                (MediaRequestStatus.Open.Contains(r.Status) || r.Status == MediaRequestStatus.Failed)).OrderBy(r => r.CreatedAt).ToListAsync(ct);
            var joined = others.Where(r => RequestRules.SameAskKey(r) == askKey).OrderBy(r => r.Status == MediaRequestStatus.Pending).FirstOrDefault();
            if (joined is { Status: not MediaRequestStatus.Pending })
            {
                row.Status = joined.Status;
                row.DecisionReason = joined.DecisionReason;
                row.DecidedAt = now;
                row.GrabbedHashes = joined.GrabbedHashes;
            }
            db.MediaRequests.Add(row);
            await db.SaveChangesAsync(ct);
            if (joined is null)
                await notifications.TryPublishAsync(LocalUser.Id, NotificationKind.RequestNew, "New request", row.Title, "/requests");
            else if (row.Status != MediaRequestStatus.Pending)
                await notifications.TryPublishAsync(userId, NotificationKind.RequestApproved, "Request approved", row.Title, "/requests");
            return (CreateOutcome.Created, ToRequester(row, library.Progress(row)));
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
        if (row.Status != MediaRequestStatus.Pending) return (true, false, ToRequester(row, new(row.Status, 0, 0)));
        row.Status = MediaRequestStatus.Cancelled;
        row.UpdatedAt = time.GetUtcNow().UtcDateTime;
        var changed = await db.MediaRequests.Where(r => r.Id == id && r.RequestedByUserId == userId && r.Status == MediaRequestStatus.Pending)
            .ExecuteUpdateAsync(update => update.SetProperty(r => r.Status, MediaRequestStatus.Cancelled)
                .SetProperty(r => r.UpdatedAt, row.UpdatedAt), ct);
        if (changed == 0) await db.Entry(row).ReloadAsync(ct);
        var library = await LibraryOnDisk.LoadAsync(db, browse, ct);
        return (true, changed > 0, ToRequester(row, library.Progress(row)));
    }

    private static RequesterRequest ToRequester(MediaRequest r, RequestProgress progress) => new(r.Id, r.Title, r.Year, r.MediaType, r.Provider,
        r.ProviderId, r.PosterUrl, r.Scope, RequestRules.ParseSeasons(r.Seasons), r.Note, progress.Phase, r.DecisionReason, r.DecidedAt,
        r.CreatedAt, r.UpdatedAt, progress.Done, progress.Total);

    private sealed record OpenRequest(MediaRequest Row, string Identity);

    private static async Task<List<OpenRequest>> OpenRequestsAsync(TorrentFlowDbContext db, string userId, CancellationToken ct)
    {
        var rows = await db.MediaRequests.AsNoTracking()
            .Where(r => r.RequestedByUserId == userId && MediaRequestStatus.Open.Contains(r.Status)).ToListAsync(ct);
        // Newest first, so a title shows the caller's latest ask.
        rows = rows.OrderByDescending(r => r.CreatedAt).ToList();
        return rows.Select(r => new OpenRequest(r, RequestRules.Identity(r.Provider, r.ProviderId, r.MediaType, r.WorkKey))).ToList();
    }
}
