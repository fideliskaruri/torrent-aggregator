using System.Collections.Immutable;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;

namespace TorrentFlow.Find;

internal sealed partial class FindService(IParser parser, SourceFlights flights, SearchBudget budget,
    IServiceScopeFactory scopes, IConfiguration configuration) : IFind
{
    private readonly object cacheSync = new();
    private readonly Dictionary<string, ScopeAnswer> answers = new(StringComparer.Ordinal);
    private sealed record ScopeAnswer(CandidateBatch Batch, DateTimeOffset ExpiresAt, long RetryRevision,
        SourceRequestBudget Budget);
    private static readonly JsonSerializerOptions SettingsJson = new(JsonSerializerDefaults.Web)
    { Converters = { new JsonStringEnumConverter() } };

    public async IAsyncEnumerable<CandidateBatch> SearchAsync(SearchRequest request,
        IAsyncEnumerable<SearchFeedback> feedback, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        Validate(request);
        var timer = Stopwatch.StartNew();
        var limit = configuration.GetValue<int?>($"TorrentFlow:Find:{(request.Lane == PriorityLane.Owner
            ? "OwnerRequestLimit" : "BackgroundRequestLimit")}") ?? (request.Lane == PriorityLane.Owner ? 12 : 6);
        if (limit is < 1 or > 64) throw new InvalidOperationException("Find request limits must be between 1 and 64.");
        var requestBudget = new SourceRequestBudget(limit);
        var windowBudget = requestBudget;
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var settings = await SettingsAsync(lifetime.Token);
        var scopePoolKey = JsonSerializer.Serialize(new
        {
            work = request.Work.Work.Id,
            seasons = request.Work.Episodes.Where(e => request.Scope.EpisodeIds.Contains(e.Id))
                .Select(e => e.SeasonId).Distinct().Order(StringComparer.Ordinal).ToArray(),
            request.Scope.Film,
            request.Work.Work.NumberingVersion
        });
        var answerKey = JsonSerializer.Serialize(new
        {
            request.Work.Work.Id,
            request.Work.Work.Year,
            request.Work.Work.Kind,
            request.Work.Work.Format,
            request.Work.Work.Anime,
            request.Work.Work.NumberingVersion,
            names = request.Work.Names.Select(n => new
                { Value = SearchQueries.Fold(n.Value), n.Label, n.LinkId, n.Ordinal, n.Authoritative }),
            episodeIds = request.Scope.EpisodeIds.Order(StringComparer.Ordinal),
            request.Scope.Film,
            request.SourceIds,
            request.SourceRevision,
            request.CredentialRevision,
            request.ProvisionalGood,
            request.Exhaust,
            limit,
            settings
        });
        ScopeAnswer? cached;
        CandidateBatch? resumed = null;
        lock (cacheSync) answers.TryGetValue(answerKey, out cached);
        if (cached is not null && cached.ExpiresAt > DateTimeOffset.UtcNow &&
            (cached.Batch.ProvisionalStopped || cached.Batch.EarlyStopped ||
                cached.RetryRevision == flights.RetryRevision(scopePoolKey)))
        {
            var replay = cached.Batch with
            {
                SessionId = request.SessionId,
                PoolRevision = 1,
                CachedPool = true,
                SourceRequests = 0,
                WindowSourceRequests = cached.Budget.Used,
                RequestBudgetExhausted = cached.Budget.Used >= limit,
                FirstCandidateAt = cached.Batch.Candidates.IsEmpty ? null : timer.Elapsed,
                Elapsed = timer.Elapsed,
                Queries = [.. cached.Batch.Queries.Select(q => q with { CacheHit = true, SharedInFlight = false })]
            };
            if (request.ProvisionalGood || request.Exhaust || !cached.Batch.EarlyStopped)
            {
                requestBudget.Finish();
                yield return replay;
                yield break;
            }
            // A cached early-stop pool is not proof for another quality/ownership policy.
            // Replay the pool first; the caller re-runs Check + Plan before any new HTTP.
            yield return replay with { Complete = false, EarlyStopped = false };
            var approved = false;
            using (var revalidation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
            {
                revalidation.CancelAfter(TimeSpan.FromSeconds(20));
                await using var reader = feedback.GetAsyncEnumerator(revalidation.Token);
                try
                {
                    while (await reader.MoveNextAsync())
                    {
                        var answer = reader.Current;
                        if (answer.PoolRevision != 1) continue;
                        approved = answer.Stop && (request.Scope.Film ? answer.FilmCovered :
                            request.Scope.EpisodeIds.All(answer.CoveredEpisodeIds.Contains));
                        if (approved || answer.NeedFallbackTier) break;
                    }
                }
                catch (OperationCanceledException) when (!lifetime.IsCancellationRequested) { }
            }
            if (approved || cached.Budget.Used >= limit)
            {
                requestBudget.Finish();
                yield return replay with { Complete = true, EarlyStopped = approved, Elapsed = timer.Elapsed };
                yield break;
            }
            requestBudget.Finish();
            requestBudget = new SourceRequestBudget(limit, cached.Budget);
            windowBudget = cached.Budget;
            resumed = replay;
        }
        using var admission = await budget.EnterAsync(request.Lane, lifetime.Token);
        var retryRevision = flights.RetryRevision(scopePoolKey);
        var signals = Channel.CreateUnbounded<SearchFeedback>(new() { SingleReader = true, SingleWriter = true });
        var feedbackTask = ListenAsync(feedback, signals.Writer, lifetime.Token);
        var pool = new CandidatePool(parser, request.Work, request.Scope);
        var traces = new Dictionary<string, FindQueryTrace>(StringComparer.Ordinal);
        if (resumed is not null)
            foreach (var trace in resumed.Queries)
            {
                pool.Add(trace.Result, trace.Query);
                traces[trace.NamePhase + "\0" + trace.SourceId + "\0" + trace.Query] = trace;
            }
        var covered = new HashSet<string>(StringComparer.Ordinal);
        var filmCovered = false;
        var early = false;
        var provisional = false;
        long revision = resumed is null ? 0 : 1;
        TimeSpan? first = resumed?.FirstCandidateAt;
        var phase = SearchNamePhase.English;
        var tier = SourceTier.Core;
        var lastFeedbackRevision = -1L;
        var feedbackEnded = false;
        var needFallback = false;
        var stageStartRevision = 1L;
        var englishHealthy = false;
        bool AllCovered() => request.Scope.Film ? filmCovered : request.Scope.EpisodeIds.All(covered.Contains);
        void Feedback()
        {
            while (signals.Reader.TryRead(out var next))
            {
                if (next.PoolRevision < lastFeedbackRevision || next.PoolRevision > revision) continue;
                lastFeedbackRevision = next.PoolRevision;
                // Coverage is supplied only by the coordinator after Check + Plan gates, never by listed seeds.
                covered.UnionWith(next.CoveredEpisodeIds.Where(request.Scope.EpisodeIds.Contains));
                filmCovered |= next.FilmCovered;
                pool.Scrapes(next.ScrapedSeeders);
                if (phase == SearchNamePhase.English)
                    englishHealthy |= next.HasHealthyRelease || next.FilmCovered || !next.CoveredEpisodeIds.IsEmpty;
                if (next.PoolRevision >= stageStartRevision) needFallback = next.NeedFallbackTier;
                if (next.Stop && AllCovered()) early = true;
            }
            feedbackEnded = signals.Reader.Completion.IsCompleted;
        }
        CandidateBatch Snapshot(bool complete, bool tierComplete = false) => new(request.SessionId, ++revision, pool.Candidates,
            [.. traces.Values.Select(t => t.Result)], complete, phase, tier)
        {
            TierComplete = complete || tierComplete,
            Rejections = pool.Rejections,
            Queries = [.. traces.Values],
            FirstCandidateAt = first,
            Elapsed = timer.Elapsed,
            EarlyStopped = early,
            ProvisionalStopped = provisional,
            SourceRequests = requestBudget.Used,
            RequestLimit = limit,
            WindowSourceRequests = windowBudget.Used,
            RequestBudgetExhausted = windowBudget.Used >= limit,
            EnglishLabelMissing = !request.Work.Names.Any(n => n.Label == NameLabel.English)
        };
        try
        {
            foreach (var name in SearchQueries.Names(request.Work))
            {
                phase = name.Phase;
                foreach (var currentTier in new[] { SourceTier.Core, SourceTier.Fallback })
                {
                    Feedback();
                    if (early || provisional || windowBudget.Used >= limit) break;
                    tier = currentTier;
                    var selected = settings.Where(s => s.Enabled && s.Tier == tier && Supports(s, request.Work))
                        .Where(s => request.SourceIds.IsEmpty || request.SourceIds.Contains(s.Id))
                        .OrderByDescending(s => request.Work.Work.Anime == true &&
                            s.Categories.Contains("anime") && !s.Categories.Contains("all")).ToArray();
                    var singleSeason = request.Scope.EpisodeIds.Length > 1 && request.Work.Episodes
                        .Where(e => request.Scope.EpisodeIds.Contains(e.Id)).Select(e => e.SeasonId).Distinct().Count() == 1;
                    var plans = selected.SelectMany((source, index) => SearchQueries.Build(request.Work, request.Scope, name.Name,
                            configuration.GetValue<bool>($"TorrentFlow:Sources:{source.Id}:RequiresYear"))
                        .Skip(tier == SourceTier.Fallback && singleSeason ? 1 : 0)
                        .Take(tier == SourceTier.Fallback ? 1 : int.MaxValue)
                        .Select((query, ordinal) => (Source: source, Query: query, Ordinal: ordinal, Priority: index + ordinal)))
                        .OrderBy(plan => plan.Priority).ThenBy(plan => plan.Ordinal).Take(limit)
                        .Select(plan => (plan.Source, plan.Query)).ToArray();
                    if (plans.Length == 0) continue;
                    needFallback = false;
                    stageStartRevision = revision + 1;
                    using var tierCancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                    var results = Channel.CreateUnbounded<(string Query, string Source, SourceResult Result, bool Cached, bool Shared)>(
                        new() { SingleReader = true, SingleWriter = false });
                    var fallbackSources = settings.Count(s => s.Enabled && s.Tier == SourceTier.Fallback &&
                        Supports(s, request.Work) && (request.SourceIds.IsEmpty || request.SourceIds.Contains(s.Id)));
                    var reserve = fallbackSources == 0 ? 0 :
                        Math.Min(fallbackSources + 1, request.Lane == PriorityLane.Owner ? limit / 2 : limit / 3);
                    var tierBudget = tier == SourceTier.Core && reserve > 0
                        ? new SourceRequestBudget(limit - reserve, requestBudget) : requestBudget;
                    var producers = ProduceTierAsync(request, phase, plans, tierBudget, scopePoolKey,
                        results.Writer, tierCancel.Token);
                    try
                    {
                        while (true)
                        {
                            Feedback();
                            if (early || provisional) { await tierCancel.CancelAsync(); break; }
                            if (results.Reader.TryRead(out var answer))
                            {
                                pool.Add(answer.Result, answer.Query);
                                if (first is null && !pool.Candidates.IsEmpty) first = timer.Elapsed;
                                traces[phase + "\0" + answer.Source + "\0" + answer.Query] =
                                    new(answer.Query, answer.Source, phase, tier, answer.Cached, answer.Shared, answer.Result);
                                provisional = !request.Exhaust && request.ProvisionalGood &&
                                    pool.Candidates.Any(c => c.TrustedSeeders is >= 1);
                                yield return Snapshot(false);
                                continue;
                            }
                            if (results.Reader.Completion.IsCompleted) break;
                            // Do not leave an unbounded pile of pending ReadAsync tasks when feedback wins.
                            using var wake = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                            var data = results.Reader.WaitToReadAsync(wake.Token).AsTask();
                            var signal = feedbackEnded ? Task.Delay(Timeout.Infinite, wake.Token) :
                                signals.Reader.WaitToReadAsync(wake.Token).AsTask();
                            await Task.WhenAny(data, signal);
                            await wake.CancelAsync();
                        }
                    }
                    finally
                    {
                        await tierCancel.CancelAsync();
                        await producers;
                        if (!ReferenceEquals(tierBudget, requestBudget)) tierBudget.Finish();
                    }
                    yield return Snapshot(false, true);
                    Feedback();
                    if (early || provisional) break;
                    // Let already-started checks answer at a tier boundary, at most twenty seconds.
                    if (!request.Exhaust && !pool.Candidates.IsEmpty && !feedbackEnded && !needFallback)
                    {
                        using var wait = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                        wait.CancelAfter(TimeSpan.FromSeconds(20));
                        while (!early && !feedbackEnded && !needFallback)
                        {
                            try { await signals.Reader.WaitToReadAsync(wait.Token); }
                            catch (OperationCanceledException) when (!lifetime.IsCancellationRequested) { break; }
                            Feedback();
                        }
                    }
                }
                if (early || provisional || windowBudget.Used >= limit || englishHealthy) break;
            }
            var final = Snapshot(true);
            lock (cacheSync)
            {
                var expiry = traces.Values.Where(t => t.Result.CacheExpiresAt is not null)
                    .Select(t => t.Result.CacheExpiresAt!.Value)
                    .Append(DateTimeOffset.UtcNow.AddMinutes(30)).Min();
                answers[answerKey] = new(final, expiry, retryRevision, windowBudget);
                while (answers.Count > 200) answers.Remove(answers.MinBy(pair => pair.Value.ExpiresAt).Key);
            }
            yield return final;
        }
        finally
        {
            await lifetime.CancelAsync();
            requestBudget.Finish();
            await feedbackTask;
        }
    }

    private async Task ProduceTierAsync(SearchRequest request, SearchNamePhase phase,
        (SourceSettings Source, string Query)[] plans, SourceRequestBudget requestBudget, string poolKey,
        ChannelWriter<(string Query, string Source, SourceResult Result, bool Cached, bool Shared)> output,
        CancellationToken ct)
    {
        async Task Produce(SourceSettings settings, string query)
        {
            var source = settings.Id;
            var category = request.Work.Work.Anime == true && (settings.Categories.Contains("anime") ||
                settings.Categories.Contains("all")) ? "anime" : request.Scope.Film ? "films" : "series";
            var imdb = request.Work.Links.FirstOrDefault(l => l.Provider == "imdb" && l.Status == LinkStatus.Verified);
            var call = new SourceQuery(query, category,
                imdb is null ? null : new("imdb", imdb.ExternalId, request.Scope.Film ? "movie" : "series"),
                request.Lane, 80, DateTimeOffset.UtcNow.AddSeconds(6), request.SourceRevision, request.CredentialRevision)
            { RequestBudget = requestBudget };
            var seasonIds = request.Work.Episodes.Where(e => request.Scope.EpisodeIds.Contains(e.Id))
                .Select(e => e.SeasonId).Distinct().Order(StringComparer.Ordinal).ToArray();
            var key = JsonSerializer.Serialize(new
            {
                queryVersion = 3,
                query = SearchQueries.Fold(query),
                source,
                category,
                work = request.Work.Work.Id,
                request.Work.Work.Year,
                request.Work.Work.Kind,
                request.Work.Work.NumberingVersion,
                seasons = seasonIds,
                phase,
                request.SourceRevision,
                request.CredentialRevision,
                parserVersion = 1,
                sources = request.SourceIds.Order(StringComparer.Ordinal),
                settings
            });
            try
            {
                for (var attempt = 0; attempt < 2; attempt++)
                {
                    var refusedSharedBudget = false;
                    await foreach (var answer in flights.ReadAsync(poolKey, key, source, call, ct))
                    {
                        output.TryWrite((query, source, answer.Result, answer.Cached, answer.Shared));
                        refusedSharedBudget |= answer.Shared && request.Lane == PriorityLane.Owner &&
                            answer.Result.Diagnostics is { Code: "RequestBudget", Requests: 0 };
                    }
                    if (!refusedSharedBudget || requestBudget.Used >= requestBudget.Limit) break;
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        }
        try { await Task.WhenAll(plans.Select(plan => Produce(plan.Source, plan.Query))); }
        finally { output.TryComplete(); }
    }

    private static async Task ListenAsync(IAsyncEnumerable<SearchFeedback> input, ChannelWriter<SearchFeedback> writer,
        CancellationToken ct)
    {
        try
        {
            await foreach (var feedback in input.WithCancellation(ct)) await writer.WriteAsync(feedback, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        finally { writer.TryComplete(); }
    }

    private async Task<ImmutableArray<SourceSettings>> SettingsAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<IStore>();
        var rows = await store.ReadAsync<SettingRow>(new("sources", null, null, null, null, null, null,
            null, null, null, null, null, null, null, 1, StoreOrder.PrimaryKey), ct);
        if (rows.IsEmpty) return [];
        return [.. rows[0].Value.Deserialize<ImmutableArray<SourceSettings>>(SettingsJson).Select(settings =>
        {
            var section = configuration.GetSection($"TorrentFlow:Sources:{settings.Id}");
            return settings with
            {
                BaseUrl = section["BaseUrl"] ?? settings.BaseUrl,
                Enabled = section.GetValue<bool?>("Enabled") ?? settings.Enabled
            };
        })];
    }

    private static bool Supports(SourceSettings source, WorkSnapshot work)
    {
        var category = work.Work.Kind == WorkKind.Film ? "films" : "series";
        return source.Categories.Contains("all") || source.Categories.Contains(category) ||
            work.Work.Anime == true && source.Categories.Contains("anime");
    }

    private static void Validate(SearchRequest request)
    {
        if (request.Work.Work.Id != request.Scope.WorkId || request.Work.Work.Kind == WorkKind.Unknown ||
            request.Scope.Film != (request.Work.Work.Kind == WorkKind.Film) || request.Work.Names.IsEmpty ||
            request.Scope.Film && !request.Scope.EpisodeIds.IsEmpty ||
            request.SourceRevision < 0 || request.CredentialRevision < 0)
            throw new ArgumentException("A confirmed work identity, names and matching scope are required.");
        if (!request.Scope.Film && (request.Scope.EpisodeIds.IsEmpty ||
            request.Scope.EpisodeIds.Any(id => !request.Work.Episodes.Any(e => e.Id == id &&
                e.MappingStatus == MappingStatus.Confirmed &&
                request.Work.Seasons.Any(s => s.Id == e.SeasonId && s.MappingStatus == MappingStatus.Confirmed)))))
            throw new ArgumentException("Episode scope requires confirmed catalog numbering.");
    }

    public async Task<RawSearchResult> SearchRawAsync(RawSearchQuery query, CancellationToken ct)
    {
        var page = Math.Max(1, query.Page);
        var size = Math.Clamp(query.PageSize, 1, 200);
        var settings = await SettingsAsync(ct);
        var descriptors = settings.Where(s => s.Enabled).Select(s => new SourceDescriptor(s.Id, s.Id, s.Categories)).ToImmutableArray();
        if (string.IsNullOrWhiteSpace(query.Query))
            return new([], [], descriptors, 0, page, size, null);
        using var admission = await budget.EnterAsync(PriorityLane.Owner, ct);
        var pool = new CandidatePool(parser, null, null);
        var selected = settings.Where(s => s.Enabled && (query.SourceIds.IsEmpty || query.SourceIds.Contains(s.Id))).ToArray();
        var results = await Task.WhenAll(selected.Select(async source =>
        {
            SourceResult? result = null;
            var call = new SourceQuery(query.Query.Trim(), query.Category, null, PriorityLane.Owner,
                80, DateTimeOffset.UtcNow.AddSeconds(6), 0, 0);
            var poolKey = JsonSerializer.Serialize(new { raw = SearchQueries.Fold(query.Query), query.Category });
            var key = JsonSerializer.Serialize(new { raw = SearchQueries.Fold(query.Query), query.Category, source });
            await foreach (var answer in flights.ReadAsync(poolKey, key, source.Id, call, ct, query.Refresh)) result = answer.Result;
            return result!;
        }));
        foreach (var result in results) pool.Add(result, query.Query);
        var rows = pool.Candidates.Where(c => Matches(c, query.Filters))
            .OrderByDescending(c => c.TrustedSeeders ?? -1).ThenBy(c => c.Release.Id, StringComparer.Ordinal).ToArray();
        return new([.. rows.Skip((page - 1) * size).Take(size)], [.. results], descriptors, rows.Length, page, size, null);
    }

    private static bool Matches(Candidate c, RawSearchFilters f) =>
        (f.MinSeeders is null || c.TrustedSeeders >= f.MinSeeders) &&
        (f.MaxSeeders is null || c.TrustedSeeders <= f.MaxSeeders) &&
        (f.MinBytes is null || c.Release.TotalBytes >= f.MinBytes) &&
        (f.MaxBytes is null || c.Release.TotalBytes <= f.MaxBytes) &&
        (f.Season is null || c.Release.Parsed.Seasons.Contains(f.Season.Value)) &&
        (f.Episode is null || c.Release.Parsed.Episodes.Contains(f.Episode.Value)) &&
        (f.Resolution is null || c.Release.Parsed.Quality.Resolution?.ToString() == f.Resolution.TrimEnd('p')) &&
        (f.Codec is null || string.Equals(c.Release.Parsed.Quality.Codec, f.Codec, StringComparison.OrdinalIgnoreCase)) &&
        (f.ReleaseKind is null || string.Equals(c.Release.Parsed.Kind.ToString(), f.ReleaseKind, StringComparison.OrdinalIgnoreCase)) &&
        (f.HasMagnet is null || f.HasMagnet == !string.IsNullOrEmpty(c.Release.Magnet));
}
