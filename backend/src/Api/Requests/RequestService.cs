using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Domain;
using TorrentFlow.Targets;

namespace TorrentFlow.Api.Requests;

internal sealed class RequestService(IStore store, IMetadata metadata, TargetPipeline pipeline)
{
    private readonly CatalogState catalog = new(store);
    internal static readonly SemaphoreSlim Gate = new(1, 1);

    internal Task<ImmutableArray<T>> Read<T>(StoreQuery query, CancellationToken ct) where T : StoreRow =>
        catalog.ReadAsync<T>(query, ct);

    internal async Task Commit(string actor, IEnumerable<RowWrite> writes, CancellationToken ct,
        IEnumerable<RowDelete>? deletes = null)
    {
        var key = Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        var receipt = new AttemptRow { Id = $"commit:requests:{actor}:{key}", TargetId = null, WorkId = null, ReleaseHash = null, ActorUserId = actor, Kind = AttemptKind.LegacyEvent, StartedAt = now, EndedAt = now, Outcome = "Request", ReasonCode = null, ReasonText = null, Decision = null, LegacyContext = null, BatchId = null, DownloadId = null, DeadlineAt = null, Swap = null };
        var result = await store.CommitAsync(new(key, StoreOwner.Targets,
            [.. writes, new(receipt, null, null)], [.. deletes ?? []]), ct);
        if (!result.Applied) throw new InvalidOperationException("The request changed. Reload and try again.");
    }

    internal async Task<RequestRow> Create(string user, CreateRequest input, CancellationToken ct)
    {
        if (input.Provider is not ("tmdb" or "anilist" or "tvmaze" or "cinemeta" or "itunes") ||
            string.IsNullOrWhiteSpace(input.ProviderId) || input.ProviderId.Length > 200 ||
            string.IsNullOrWhiteSpace(input.Title) || input.Title.Length > 300 ||
            input.MediaType is not ("movie" or "tv" or "series" or "anime") ||
            input.Scope is not ("movie" or "seasons" or "series") || input.Note?.Length > 500 ||
            input.Year is < 1800 or > 2200 ||
            input.Seasons.Any(s => s is < 0 or > 999) || input.Seasons.Length > 100)
            throw new ArgumentException("Provide a supported title, scope and season list.");
        var film = input.MediaType == "movie";
        if (film != (input.Scope == "movie") || input.Scope == "seasons" && input.Seasons.IsEmpty)
            throw new ArgumentException("Choose a film, specific seasons, or the whole series.");
        var resolved = await metadata.ResolveAsync(new(new(input.Provider, input.ProviderId,
            film ? "movie" : "tv"), input.Title, input.Year, film ? WorkKind.Film : WorkKind.Series), ct);
        var work = resolved.Work ?? throw new ArgumentException(
            "This title could not be resolved. Check its provider and try again.");
        var mine = await Read<RequestRow>(CatalogState.Query(userId: user), ct);
        var seasons = input.Scope == "series" ? work.Seasons.Select(s => s.Number).ToImmutableArray() :
            input.Seasons.Distinct().Order().ToImmutableArray();
        var priorItems = await Read<RequestItemRow>(CatalogState.Query(), ct);
        var priorOwned = await catalog.OwnedAsync(work.Work.Id, ct);
        bool Fulfilled(RequestRow r)
        {
            var items = priorItems.Where(i => i.RequestId == r.Id).ToArray();
            return items.Length > 0 && items.All(i => i.Settlement == ItemSettlement.Fulfilled ||
                priorOwned.Any(f => f.EpisodeId == i.EpisodeId && File.Exists(f.Path)));
        }
        if (mine.Any(r => r.WorkId == work.Work.Id && r.Decision is RequestDecision.Pending or RequestDecision.Approved &&
            (film || r.Scope == RequestScope.Series || input.Scope == "series" || r.ScopeData.Seasons.Intersect(seasons).Any()) &&
            !Fulfilled(r)))
            throw new RequestConflict("duplicate", "You've already asked for this.");
        var settings = (await Read<SettingRow>(CatalogState.Query("requests"), ct)).Single();
        var maximum = settings.Value.TryGetProperty("maxOpenPerRequester", out var max) ? max.GetInt32() : 20;
        if (mine.Count(r => r.Decision is RequestDecision.Pending or RequestDecision.Approved && !Fulfilled(r)) >= maximum)
            throw new RequestConflict("too_many_open", $"You have {maximum} open requests. Wait for the owner to handle them.");
        var now = DateTimeOffset.UtcNow;
        var request = new RequestRow { Id = Guid.NewGuid().ToString("N"), UserId = user, WorkId = work.Work.Id, Scope = film ? RequestScope.Film : input.Scope == "series" ? RequestScope.Series : RequestScope.Seasons, ScopeData = new(seasons, input.Scope == "series"), Note = input.Note?.Trim(), Decision = RequestDecision.Pending, DecisionReason = null, DecidedAt = null, DecidedBy = null, CreatedAt = now, UpdatedAt = now, Version = 1 };
        var selected = film ? new string?[] { null } : work.Episodes
            .Where(e => work.Seasons.Any(s => s.Id == e.SeasonId && seasons.Contains(s.Number)))
            .Select(e => (string?)e.Id).ToArray();
        var owned = await catalog.OwnedAsync(work.Work.Id, ct);
        var items = selected.Select(episode => new RequestItemRow { Id = Guid.NewGuid().ToString("N"), RequestId = request.Id, EpisodeId = episode, TargetId = null, Settlement = owned.Any(f => f.EpisodeId == episode && File.Exists(f.Path))
                ? ItemSettlement.Fulfilled : ItemSettlement.Open, SettledAt = owned.Any(f => f.EpisodeId == episode && File.Exists(f.Path)) ? now : null, CreatedAt = now, UpdatedAt = now }).ToArray();
        if (items.Length > 0 && items.All(i => i.Settlement == ItemSettlement.Fulfilled))
            request = request with { Decision = RequestDecision.Approved, DecidedBy = "local",
                DecidedAt = now, DecisionReason = "Already in your library" };
        // Target.createdBy is a User FK. A non-login attribution actor lets the public Acquire
        // API name the request while preserving that constraint and the actual requesting user.
        var attribution = new UserRow { Id = request.Id, NormalizedEmail = null, Name = $"Request {request.Id}", Image = null, Role = UserRole.Requester, CreatedAt = now, UpdatedAt = now };
        await Commit(user, [new(attribution, null, null), new(request, null, null),
            .. items.Select(i => new RowWrite(i, null, null))], ct);
        return request;

    }

    internal async Task<RequestRow> Decide(string id, string actor, string action, string? reason, CancellationToken ct)
    {
        var request = (await Read<RequestRow>(CatalogState.Query(id), ct)).SingleOrDefault()
            ?? throw new KeyNotFoundException("Request not found.");
        if (action == "decline" && request.Decision != RequestDecision.Pending)
            throw new RequestConflict("not_pending", "Only a pending request can be declined.");
        if (action == "approve" && request.Decision is RequestDecision.Declined or RequestDecision.Cancelled)
            throw new RequestConflict("not_pending", "Retry this request before approving it.");
        var now = DateTimeOffset.UtcNow;
        var shared = (await Read<RequestRow>(CatalogState.Query(workId: request.WorkId), ct))
            .Where(r => SameAsk(r, request) && (r.Id == id || r.Decision == RequestDecision.Pending ||
                action != "decline" && r.Decision == RequestDecision.Approved))
            .OrderBy(r => r.CreatedAt).ToArray();
        var changes = shared.Select(r => r with
        {
            Decision = action == "decline" ? RequestDecision.Declined : RequestDecision.Approved,
            DecisionReason = reason, DecidedBy = actor, DecidedAt = now, UpdatedAt = now, Version = r.Version + 1,
        }).ToArray();
        await Commit(actor, changes.Select((r, i) => new RowWrite(r, shared[i].Version, null)), ct);
        if (action != "decline")
        {
            foreach (var next in changes) await Acquire(next, ct);
            if (action == "retry")
            {
                var items = await Read<RequestItemRow>(CatalogState.Query() with { RequestId = id }, ct);
                foreach (var targetId in items.Where(i => i.Settlement == ItemSettlement.Open && i.TargetId is not null)
                    .Select(i => i.TargetId!).Distinct())
                    await pipeline.ActionAsync(targetId, TargetAction.TryNow, ct);
            }
        }
        return changes.Single(r => r.Id == id);
    }

    internal static bool SameAsk(RequestRow left, RequestRow right) =>
        left.WorkId == right.WorkId && left.Scope == right.Scope &&
        left.ScopeData.Seasons.Order().SequenceEqual(right.ScopeData.Seasons.Order());

    internal async Task Acquire(RequestRow request, CancellationToken ct)
    {
        var work = (await Read<WorkRow>(CatalogState.Query(request.WorkId), ct)).Single();
        var priorItems = await Read<RequestItemRow>(CatalogState.Query() with { RequestId = request.Id }, ct);
        var priorTargets = (await pipeline.ReadAsync(ct)).Targets;
        var seasons = request.Scope == RequestScope.Series
            ? (await Read<SeasonRow>(CatalogState.Query(workId: request.WorkId), ct)).Select(s => s.Number)
            : request.ScopeData.Seasons;
        var seasonRows = await Read<SeasonRow>(CatalogState.Query(workId: request.WorkId), ct);
        var episodes = await Read<EpisodeRow>(CatalogState.Query(), ct);
        var preferences = (await Read<WorkPreferenceRow>(CatalogState.Query(workId: request.WorkId), ct)).FirstOrDefault();
        bool Settled(string? episodeId) => priorItems.Any(i => i.EpisodeId == episodeId &&
            (i.Settlement != ItemSettlement.Open || priorTargets.Any(t => t.Id == i.TargetId && t.State == TargetState.Removed)));
        var inputs = new List<AcquireInput>();
        if (request.Scope == RequestScope.Film)
        {
            if (!Settled(null)) inputs.Add(new(work.WorkKey, Quality: preferences?.ResolutionFloor));
        }
        else foreach (var number in seasons)
        {
            var season = seasonRows.FirstOrDefault(s => s.Number == number);
            var selected = episodes.Where(e => e.SeasonId == season?.Id && e.MappingStatus == MappingStatus.Confirmed).ToArray();
            if (selected.Length == 0) inputs.Add(new(work.WorkKey, number, Quality: preferences?.ResolutionFloor));
            else inputs.AddRange(selected.Where(e => !Settled(e.Id))
                .Select(e => new AcquireInput(work.WorkKey, number, e.Number, preferences?.ResolutionFloor)));
        }
        foreach (var input in inputs)
        {
            var result = await pipeline.AcceptRequestAsync(input, request.Id, ct);
            await RequestTargetAdapter.Attach(store, catalog, request, result.TargetIds, ct);
        }
    }

    internal async Task Reconcile(CancellationToken ct)
    {
        var requests = await Read<RequestRow>(CatalogState.Query(), ct);
        foreach (var request in requests.Where(r => r.Decision == RequestDecision.Approved))
        {
            var owned = await catalog.OwnedAsync(request.WorkId, ct);
            var items = await Read<RequestItemRow>(CatalogState.Query() with { RequestId = request.Id }, ct);
            var targets = (await pipeline.ReadAsync(ct)).Targets;
            var now = DateTimeOffset.UtcNow;
            var writes = items.Where(i => i.Settlement == ItemSettlement.Open)
                .Select(i => (Item: i, Settlement: owned.Any(f => f.EpisodeId == i.EpisodeId && File.Exists(f.Path))
                    ? ItemSettlement.Fulfilled : targets.Any(t => t.Id == i.TargetId && t.State == TargetState.Removed)
                        ? ItemSettlement.StoppedByOwner : ItemSettlement.Open))
                .Where(x => x.Settlement != ItemSettlement.Open)
                .Select(x => new RowWrite(x.Item with { Settlement = x.Settlement, SettledAt = now, UpdatedAt = now },
                    null, x.Item)).ToArray();
            if (writes.Length > 0) await Commit(request.UserId, writes, ct);
            if (request.Scope != RequestScope.Film)
            {
                await metadata.GetWorkAsync(request.WorkId, false, ct);
                await Acquire(request, ct);
            }
        }
    }

    internal async Task<object> Project(RequestRow request, bool owner, CancellationToken ct)
    {
        var work = (await Read<WorkRow>(CatalogState.Query(request.WorkId), ct)).Single();
        var names = await Read<WorkNameRow>(CatalogState.Query(workId: work.Id), ct);
        var link = (await Read<WorkLinkRow>(CatalogState.Query(workId: work.Id), ct))
            .OrderByDescending(l => l.IsPrimary).FirstOrDefault();
        var items = await Read<RequestItemRow>(CatalogState.Query() with { RequestId = request.Id }, ct);
        var snapshot = await pipeline.ReadAsync(ct);
        var ids = items.Where(i => i.TargetId is not null).Select(i => i.TargetId).ToHashSet();
        var targets = snapshot.Targets.Where(t => ids.Contains(t.Id)).ToArray();
        var owned = await catalog.OwnedAsync(work.Id, ct);
        var done = items.Count(i => i.Settlement == ItemSettlement.Fulfilled ||
            owned.Any(f => f.EpisodeId == i.EpisodeId && File.Exists(f.Path)));
        var phase = request.Decision.ToString().ToLowerInvariant();
        if (request.Decision == RequestDecision.Approved)
            phase = items.Length > 0 && done == items.Length ? "fulfilled" :
                targets.Any(t => t.State is TargetState.Fetching or TargetState.Filing) ? "downloading" :
                items.Any(i => i.Settlement == ItemSettlement.StoppedByOwner) ||
                    targets.Any(t => t.State == TargetState.Waiting && t.SubstantiveMisses > 0)
                        ? done > 0 ? "partial" : "failed" : "approved";
        var associations = await Read<DownloadTargetRow>(CatalogState.Query(), ct);
        var downloads = snapshot.Downloads.Where(d => associations.Any(a => a.DownloadId == d.Id &&
            ids.Contains(a.TargetId) && a.Role == AssociationRole.Current)).ToArray();
        var live = snapshot.Live.Where(l => downloads.Any(d => d.Id == l.DownloadId)).ToArray();
        var releases = await Read<ReleaseRow>(CatalogState.Query(), ct);
        var release = releases.FirstOrDefault(r => downloads.Any(d => d.Hash == r.Id) ||
            targets.Any(t => t.ChosenReleaseHash == r.Id));
        var bindings = await Read<DownloadFileRow>(CatalogState.Query(), ct);
        var relevantFiles = live.SelectMany(l => l.Files.Where(f => bindings.Any(b =>
            b.DownloadId == l.DownloadId && b.FileIndex == f.Index && b.Selected && ids.Contains(b.TargetId)))).ToArray();
        var bytes = relevantFiles.Sum(f => f.Bytes);
        var completed = relevantFiles.Sum(f => f.CompletedBytes);
        var speed = live.Sum(l => l.BytesPerSecond);
        var requester = (await Read<UserRow>(CatalogState.Query(request.UserId), ct)).SingleOrDefault();
        var requesters = new List<string>();
        if (owner)
        {
            var shared = (await Read<RequestRow>(CatalogState.Query(workId: request.WorkId), ct))
                .Where(r => SameAsk(r, request) && r.Decision == request.Decision).ToArray();
            var users = await Read<UserRow>(CatalogState.Query(), ct);
            requesters.AddRange(shared.Select(r => users.FirstOrDefault(u => u.Id == r.UserId)?.NormalizedEmail ?? r.UserId));
        }
        var episodes = await Read<EpisodeRow>(CatalogState.Query(), ct);
        var expected = targets.Select(t => t.ExpectedAt).Where(d => d is not null).Min() ??
            (request.Scope == RequestScope.Film ? work.DigitalAt ?? work.PhysicalAt ?? work.TheatricalAt :
                episodes.Where(e => items.Any(i => i.EpisodeId == e.Id)).Select(e => e.AirAt).Where(d => d > DateTimeOffset.UtcNow).Min());
        return new
        {
            request.Id, title = names.OrderBy(n => n.Ordinal).FirstOrDefault()?.Value ?? work.WorkKey,
            work.Year, mediaType = work.Kind == WorkKind.Film ? "movie" : "tv",
            provider = link?.Provider, providerId = link?.ExternalId, work.PosterUrl,
            scope = request.Scope == RequestScope.Film ? "movie" : request.Scope.ToString().ToLowerInvariant(),
            seasons = request.ScopeData.Seasons, request.Note, status = owner && phase == "downloading" ? "approved" : phase,
            request.DecisionReason, request.DecidedAt, request.CreatedAt, request.UpdatedAt,
            done, total = items.Length, airing = episodes.Any(e => items.Any(i => i.EpisodeId == e.Id) && e.AirAt > DateTimeOffset.UtcNow),
            requestedBy = owner ? requester?.NormalizedEmail ?? request.UserId : null,
            requesters = owner ? requesters.Distinct().ToArray() : null,
            phase, workKey = owner ? work.WorkKey : null,
            quality = release?.Parsed.Quality.Resolution ?? targets.FirstOrDefault()?.PreferredResolution,
            size = bytes > 0 ? bytes : release?.TotalBytes, releaseName = release?.Name,
            seeders = live.Sum(l => l.Seeders), progress = bytes > 0 ? (double)completed / bytes * 100 :
                items.Length > 0 ? (double)done / items.Length * 100 : 0,
            speed, eta = speed > 0 ? (bytes - completed) / speed : (long?)null,
            pickReasons = snapshot.History.Where(h => ids.Contains(h.TargetId))
                .SelectMany(h => new[] { h.ReasonText ?? h.Outcome }
                    .Concat(h.Decision?.Rejections.Select(r => (string?)r.Explanation) ?? []))
                .Where(r => r is not null).Distinct().Take(40),
            expectedDate = expected,
        };
    }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record CreateRequest(string Provider, string ProviderId, string MediaType, string Title,
    int? Year, string? PosterUrl, string Scope, ImmutableArray<int> Seasons, string? Note);
internal sealed class RequestConflict(string code, string message) : Exception(message)
{
    internal string Code { get; } = code;
}
