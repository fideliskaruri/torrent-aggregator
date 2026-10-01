using System.Collections.Concurrent;
using TorrentFlow.Core;
using TorrentFlow.Core.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Watchlist;
using TorrentFlow.Library.Features.Storage;
using TorrentFlow.Library.Features.Automation;
using System.Text.Json;

namespace TorrentFlow.Library.Features.Grabs;

public sealed record GrabInput(string Title, string MediaType, EpisodeCursor? Cursor = null,
    string? WatchListItemId = null, string? WorkId = null, int? PreferredResolution = null,
    bool OverrideStorageCap = false, IReadOnlyList<string>? Aliases = null,
    bool Background = false, int? Year = null, string? WorkKey = null, string? Lane = null,
    string? Provider = null, string? ProviderId = null, AnimeEpisodeMapping? EpisodeMapping = null,
    SearchFilters? Constraints = null, string[]? Sources = null, bool ReuseExisting = false, bool Urgent = false, bool Anime = false,
    LanguageWant? Language = null, IReadOnlySet<string>? Blocked = null)
{
    /// <summary>Background hunts are automation; anything the owner pressed is the owner's lane unless named.</summary>
    public string QueueLane => Lane ?? (Background ? TorrentLane.Automation : TorrentLane.Owner);
}

/// <summary>An attempt cut short by shutdown: never a failed release; the wanted queue picks it up again after the restart.</summary>
public sealed class ShuttingDownException(CancellationToken ct) : OperationCanceledException("TorrentFlow is shutting down.", ct);

/// <summary>What one ladder rung fetched and how much survived each filter (TS RungDiagnostic).</summary>
public sealed class RungDiagnostic
{
    public required string Kind { get; init; }
    public required string Query { get; init; }
    public required string Category { get; init; }
    public long? MinSeeders { get; init; }
    public int Fetched { get; init; }
    public int WorkEligible { get; init; }
    public int QualityEligible { get; init; }
    public int EpisodeEligible { get; init; }
    public int Attempted { get; set; }
    public IReadOnlyList<SourceStatus> Sources { get; init; } = [];
    public IReadOnlyList<CandidateRejection> Candidates { get; set; } = [];
}

public sealed partial class GrabService(IDbContextFactory<TorrentFlowDbContext> factory, ITorrentSearchService search, ITorrentEngine engine,
    IOptions<AutomationOptions> automationOptions, ILibraryAnimeLookup anime, ILogger<GrabService>? logger = null,
    EpisodeSearchIdentity? searchIdentity = null, AnimeEpisodeMappings? episodeMappings = null, IHostApplicationLifetime? lifetime = null,
    IMetadataResolver? metadata = null)
{
    /// <summary>True once the app began shutting down: probes are cancelled and the client stops before callers' tokens fire.</summary>
    private bool Stopping => lifetime?.ApplicationStopping.IsCancellationRequested == true;

    private readonly object episodeGate = new();
    /// <summary>A TMDB title's original language and anime call, kept for the life of the process.</summary>
    private readonly ConcurrentDictionary<string, (string? Original, bool Anime)> catalogLanguages = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Task<GrabResult>> episodeFlights = [];

    public async Task<GrabResult> Grab(GrabInput input, CancellationToken ct, Func<Task>? beforeSend = null)
    {
        if (!input.ReuseExisting || input.WorkId == null || input.Cursor == null)
            return await GrabCore(input, ct, beforeSend);
        var key = $"{input.WorkId}:{input.Cursor.Value.QueueKey}:{input.PreferredResolution}";
        Task<GrabResult> work;
        lock (episodeGate)
        {
            if (!episodeFlights.TryGetValue(key, out work!))
            {
                work = Task.Run(() => GrabCore(input, ct, beforeSend), CancellationToken.None);
                episodeFlights[key] = work;
                _ = work.ContinueWith(completed =>
                {
                    if (completed.IsFaulted) logger?.LogWarning(completed.Exception, "Season episode attempt failed");
                    lock (episodeGate) episodeFlights.Remove(key);
                }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            }
        }
        return await work.WaitAsync(ct);
    }

    private async Task<GrabResult> GrabCore(GrabInput input, CancellationToken ct, Func<Task>? beforeSend)
    {
        // The pick-it-yourself link searches with this text too, so it carries plain apostrophes like every rung.
        var plain = Apostrophes.Normalize(input.Title);
        var query = input.Cursor?.Query(plain) ?? plain;
        await using var db = await factory.CreateDbContextAsync(ct);
        if (input.ReuseExisting && input.WorkId != null && input.Cursor is { } requested)
        {
            var existing = await db.EngineTorrents.AsNoTracking().FirstOrDefaultAsync(t => t.UserId == LocalUser.Id &&
                t.WorkId == input.WorkId && t.QueueKey == requested.QueueKey && t.Origin == TorrentOrigin.User &&
                t.Status != EngineTorrentStatus.Error && t.Status != EngineTorrentStatus.Removed, ct);
            if (existing != null)
                return new(true, "This episode has already started.") { InfoHash = existing.Hash, Title = existing.Name,
                    Queued = existing.Status == EngineTorrentStatus.Queued, Query = query };
            if (await PackOwner(db, input.WorkId, requested, ct) is { } pack)
                return new(true, "This episode is already downloading as part of a season pack.") { InfoHash = pack.Hash, Title = pack.Name,
                    Queued = pack.Status == EngineTorrentStatus.Queued, Query = query };
        }
        var (prepared, settings, floor, refusal) = await Prepare(db, input, query, ct);
        if (refusal != null) return refusal;
        input = prepared;
        if (input.Cursor is { } cursor) return await Episode(db, settings!, input, cursor, query, floor, beforeSend, ct);
        return await Film(db, settings!, input, floor, beforeSend, ct);
    }

    /// <summary>The healthy season pack transfer that owns this episode, if any.</summary>
    private static async Task<EngineTorrent?> PackOwner(TorrentFlowDbContext db, string workId, EpisodeCursor cursor, CancellationToken ct)
    {
        var hash = await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkId == workId && t.Scope == "episode" &&
            t.Season == cursor.Season && t.Episode == cursor.Episode && t.FileIndex != null && t.InfoHash != null && t.Status != "failed")
            .Select(t => t.InfoHash).FirstOrDefaultAsync(ct);
        return hash == null ? null : await db.EngineTorrents.AsNoTracking().FirstOrDefaultAsync(t => t.UserId == LocalUser.Id && t.Hash == hash &&
            t.Status != EngineTorrentStatus.Error && t.Status != EngineTorrentStatus.Removed, ct);
    }

    /// <summary>
    /// What every grab resolves before it searches: download settings, the search identity (saved and provider aliases,
    /// the AniList episode mapping) and the quality floor. Episodes and films share it.
    /// </summary>
    private async Task<(GrabInput Input, ClientSetting? Settings, int? Floor, GrabResult? Refusal)> Prepare(TorrentFlowDbContext db,
        GrabInput input, string query, CancellationToken ct)
    {
        var settings = await db.ClientSettings.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == LocalUser.Id, ct);
        if (settings == null) return (input, null, null, new(false, "Set up your download folder in Settings first.") { Query = query,
            Failure = new("setup_required", "Downloads have not been set up.", "Choose your download folder in Settings, then retry.") });
        var work = input.WorkId == null ? null : await db.Works.AsNoTracking().FirstOrDefaultAsync(w => w.Id == input.WorkId, ct);
        if (input.Cursor != null)
        {
            var savedAliases = work?.ReadNames().Others(work.CanonicalTitle) ?? [];
            input = input with { Aliases = (input.Aliases ?? []).Concat(savedAliases).Distinct(StringComparer.OrdinalIgnoreCase).ToArray() };
            var identity = await (searchIdentity ?? new EpisodeSearchIdentity(anime)).ResolveAsync(input.Title,
                input.Year ?? work?.Year, work?.MediaType == "anime" ? "anime" : input.MediaType, input.Aliases, ct,
                input.Provider ?? work?.Provider, input.ProviderId ?? work?.ProviderId);
            input = input with { MediaType = identity.MediaType, Aliases = identity.Aliases };
            var provider = input.Provider ?? work?.Provider;
            var providerId = input.ProviderId ?? work?.ProviderId;
            if (input.EpisodeMapping == null)
            {
                try
                {
                    input = input with { EpisodeMapping = await (episodeMappings ?? new AnimeEpisodeMappings(anime)).ForAsync(
                        work?.WorkKey ?? input.WorkKey, work?.CanonicalTitle ?? input.Title, input.Year ?? work?.Year, input.MediaType,
                        provider, providerId, input.Cursor.Value, ct) };
                }
                catch (Exception) when (!ct.IsCancellationRequested) { }
            }
            var saved = input.Aliases;
            if (input.EpisodeMapping is { } mapping)
            {
                input = input with { Aliases = (input.Aliases ?? []).Concat(mapping.EntryTitles).Concat(mapping.FranchiseTitles)
                    .Where(n => !string.IsNullOrWhiteSpace(n)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray() };
                // A later cour's names search its own episodes only; the work keeps the names of its own entry.
                if (mapping is { TargetSeason: 1, EntryEpisodeOffset: 0 }) saved = input.Aliases;
            }
            if (work != null && (saved is { Count: > 0 } || work.MediaType != input.MediaType))
            {
                var namesJson = work.ReadNames().With(saved).ToJson();
                await db.Works.Where(w => w.Id == work.Id).ExecuteUpdateAsync(s =>
                    s.SetProperty(w => w.NamesJson, namesJson).SetProperty(w => w.MediaType, input.MediaType), ct);
            }
        }
        int? floor = input.PreferredResolution ?? SettingsDefaults.ResolutionOrDefault(settings.PreferredResolution);
        if (input.Cursor == null)
        {
            // A film keeps searching as a film; the shared anime rule only decides where it lands.
            var film = await (searchIdentity ?? new EpisodeSearchIdentity(anime)).ResolveAsync(input.Title, input.Year, input.MediaType,
                input.Aliases, ct, input.Provider, input.ProviderId);
            input = input with { Anime = film.MediaType == "anime" };
        }
        input = input with { Language = await LanguageWantAsync(settings.AudioLanguage, input.Anime ? "anime" : input.MediaType, input.Provider ?? work?.Provider,
            input.ProviderId ?? work?.ProviderId, ct), Blocked = await ReleaseBlocks.BlockedHashesAsync(db, LocalUser.Id, ct) };
        return (input, settings, floor, null);
    }

    /// <summary>
    /// What the owner wants to hear for a title (docs/release-language.md): the audio language setting, whether it is
    /// anime, and for a TMDB title its original language, which is the backup outside anime. A failed lookup leaves the
    /// original language unknown and is tried again next time.
    /// </summary>
    internal async Task<LanguageWant> LanguageWantAsync(string? preference, string? mediaType, string? provider, string? providerId,
        CancellationToken ct)
    {
        // The one anime rule decides first; only a TMDB title needs its catalog entry for that and its original language.
        var type = AnimeIdentity.IsAnime(provider, mediaType, providerId) ? "anime" : mediaType;
        string? original = null;
        if (type != "anime" && metadata != null &&
            string.Equals(provider, "tmdb", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(providerId))
        {
            var kind = string.Equals(mediaType, "movie", StringComparison.OrdinalIgnoreCase) ? "movie" : "tv";
            var key = $"{kind}:{providerId}";
            if (!catalogLanguages.TryGetValue(key, out var known))
            {
                try
                {
                    var catalog = await metadata.GetByIdAsync("tmdb", kind, providerId, ct);
                    known = (catalog?.OriginalLanguage, catalog != null && AnimeIdentity.IsAnime(catalog));
                    catalogLanguages[key] = known;
                }
                catch (Exception error) when (!ct.IsCancellationRequested)
                {
                    logger?.LogDebug(error, "Original language lookup failed for {Kind} {Id}", kind, providerId);
                }
            }
            original = known.Original;
            if (known.Anime) type = "anime";
        }
        return LanguageWant.For(preference, type, original);
    }

    /// <summary>
    /// A whole season is the single-episode grab (the same path as an episode's own Download button) run once per
    /// episode, batched. Episodes already on their way are reused, not grabbed twice. Title page, the wanted queue and
    /// requests all use this.
    /// </summary>
    public Task<SeasonFanoutResult> Season(GrabInput input, int season, IEnumerable<int> episodes, CancellationToken ct,
        Func<EpisodeTransfer, Task>? settled = null) =>
        SeasonFanout.Run(episodes.Where(e => e > 0).Distinct().Order(),
            (ep, before) => Grab(input with { Cursor = new EpisodeCursor(season, ep) }, ct, before), ct, settled: settled);

    /// <summary>Port of grabSingleEpisode's ladder: each rung is searched once, and the first working send wins.</summary>
    private async Task<GrabResult> Episode(TorrentFlowDbContext db, ClientSetting settings, GrabInput input, EpisodeCursor cursor,
        string query, int? floor, Func<Task>? beforeSend, CancellationToken ct)
    {
        var rungs = EpisodeLadder.BuildEpisodeRungs(input.Title, cursor, input.MediaType, input.Aliases, floor, input.EpisodeMapping,
            preferRequestedQuality: true);
        if (input.Background)
            rungs = rungs.Select(r => r with { Filters = r.Filters with { MinSeeders = null }, Relaxed = true }).DistinctBy(r => r.SearchKey).ToArray();
        var accepted = (input.Aliases ?? []).Prepend(input.Title).SelectMany(EpisodeLadder.AliasTitleForms).ToList();
        var memo = new Dictionary<string, SearchResponse>(StringComparer.Ordinal);
        var attempted = new HashSet<string>(StringComparer.Ordinal);
        var diagnostics = new List<RungDiagnostic>();
        var decisions = new Dictionary<string, CandidateRejection>(StringComparer.Ordinal);
        var searchFailed = false;
        GrabFailure? searchFailure = null;
        GrabResult? lastFailure = null;
        var allSendsWithoutFileList = true;
        // The English rule (docs/release-language.md): Pass releases go first, Unknown ones wait, Fail ones never go.
        var hold = new LanguageHold();
        foreach (var rung in rungs)
        {
            var queryFailed = false;
            if (!memo.TryGetValue(rung.SearchKey, out var raw))
            {
                GrabFailure? rungFailure;
                (raw, rungFailure) = await SearchRung(input, rung, floor, applyMaxSize: true, ct);
                if (rungFailure != null) { searchFailure = rungFailure; queryFailed = true; }
                memo[rung.SearchKey] = raw;
            }
            searchFailed |= raw.Sources.Any(s => s.Error != null);
            var work = raw.Results.Where(x => EpisodeLadder.ReleaseMatchesWork(x, accepted, PremiereYear(input))).ToList();
            var quality = Eligible(input, floor, work);
            var rungCandidates = new Dictionary<string, CandidateRejection>(StringComparer.Ordinal);
            foreach (var row in raw.RejectedResults.Concat(raw.Results.Select(r => new SearchRejectedResult(r, ""))))
            {
                var key = EpisodeLadder.CandidateKey(row.Result);
                var decision = attempted.Contains(key) && decisions.TryGetValue(key, out var previous)
                    ? previous : EpisodeRejections.Explain(row.Result, accepted, cursor, input.EpisodeMapping, floor, rung.Relaxed,
                        row.Reason.Length > 0 ? row.Reason : null, PremiereYear(input));
                if (IsBlocked(input, row.Result) && !decision.Reasons.Contains("blocked"))
                    decision = decision with { Reasons = decision.Reasons.Append("blocked").ToArray() };
                if (Judge(input, row.Result) is { ReasonCode: { } code } && !decision.Reasons.Contains(code))
                    decision = decision with { Reasons = decision.Reasons.Append(code).ToArray() };
                rungCandidates[key] = decisions[key] = decision;
            }
            var diagnostic = new RungDiagnostic { Kind = rung.Kind, Query = rung.Query, Category = rung.Category, MinSeeders = rung.Filters.MinSeeders,
                Fetched = raw.Results.Count, WorkEligible = work.Count, QualityEligible = quality.Count,
                EpisodeEligible = quality.Count(r => EpisodeLadder.MatchesTargetEpisode(r, cursor, input.EpisodeMapping)),
                Sources = raw.Sources, Candidates = rungCandidates.Values.ToArray() };
            diagnostics.Add(diagnostic);
            if (logger?.IsEnabled(LogLevel.Debug) == true)
                logger.LogDebug("Episode search rung: {Diagnostic}", JsonSerializer.Serialize(diagnostic));
            var normal = quality.Where(r => Judge(input, r).Verdict == EnglishVerdict.Pass).ToList();
            while (EpisodeLadder.Select(rung, normal, cursor, attempted, input.EpisodeMapping) is { } candidate)
            {
                attempted.Add(EpisodeLadder.CandidateKey(candidate));
                hold.Tried(candidate);
                diagnostic.Attempted++;
                if (input.Background && await BackgroundPolicy(db, settings, input, query, candidate, ct) is { } waiting)
                    return waiting;
                var result = await Send(db, settings, input, query, candidate, beforeSend, rung.Relaxed, ct,
                    context: new(SendContext.RungLabel(rung), Judge(input, candidate)));
                if (result.Ok) return result;
                if (result.Storage != null || result.Failure?.Code == "download_folder") return result;
                var key = EpisodeLadder.CandidateKey(candidate);
                // Its file list showed no English: it counts as a Fail release.
                if (result.LanguageRefusal != null) hold.Refused(candidate);
                rungCandidates[key] = decisions[key] = new(candidate.Title, candidate.Source, [result.LanguageRefusal ?? "send_failed"]);
                diagnostic.Candidates = rungCandidates.Values.ToArray();
                // One bad pick no longer ends the attempt: fall through to the next candidate, then the next rung.
                lastFailure = result;
                allSendsWithoutFileList &= result.Failure?.Code is "metadata_unavailable" or "no_seeders";
            }
            // The same picker chooses which Unknown and Fail releases this rung would have sent; they are held or counted, not sent.
            var later = quality.Where(r => Judge(input, r).Verdict != EnglishVerdict.Pass).ToList();
            while (EpisodeLadder.Select(rung, later, cursor, hold.Keys, input.EpisodeMapping) is { } held)
                hold.Add(held, Judge(input, held), SendContext.RungLabel(rung), rung.Relaxed);
            if (queryFailed) break;
        }
        // A search cut short by shutdown is no miss: the run starts over after the restart.
        if (Stopping) throw new ShuttingDownException(ct);
        // Every rung is exhausted with no working Pass send. Unknown releases go only when no healthy Pass release turned
        // up; a ladder cut short by a failed search keeps them for the retry, which may still find an English one.
        var languageHeld = hold.Failed > 0 || hold.Unknown > 0;
        if (searchFailure == null)
            foreach (var held in hold.Sendable())
            {
                if (input.Background && await BackgroundPolicy(db, settings, input, query, held.Release, ct) is { } waiting)
                    return waiting;
                var result = await Send(db, settings, input, query, held.Release, beforeSend, held.Relaxed, ct,
                    context: new(held.Rung, held.Call));
                if (result.Ok)
                {
                    logger?.LogInformation("Episode {Title} {Episode}: no healthy English release, sent one with English not stated: {Release}",
                        input.Title, cursor.Label, held.Release.Title);
                    return result;
                }
                if (result.Storage != null || result.Failure?.Code == "download_folder") return result;
                decisions[EpisodeLadder.CandidateKey(held.Release)] = new(held.Release.Title, held.Release.Source, ["send_failed"]);
                lastFailure = result;
                allSendsWithoutFileList &= result.Failure?.Code is "metadata_unavailable" or "no_seeders";
            }
        var searches = memo.Count;
        object Report(string reason) => new { reason, searches, triedSeasonPacks = false, manualSearchQuery = query,
            mapping = input.EpisodeMapping, candidates = decisions.Values.ToArray(), rungs = diagnostics };
        var failure = searchFailure ?? (memo.Values.All(r => r.Sources.Count == 0 && r.Results.Count == 0 && r.RejectedResults.Count == 0)
            ? new GrabFailure("no_sources", "No search sites are turned on for this kind of title.",
                "Turn one on in Settings, then try again.") { Brief = "had no search sites to look on" }
            : GrabFailure.FromCandidates(GrabFailure.Subject(input.Title, cursor.Season, cursor.Episode), floor, decisions.Values, searchFailed));
        var detail = memo.Values.All(r => r.Sources.Count == 0 && r.Results.Count == 0 && r.RejectedResults.Count == 0)
            ? "no search sites turned on" : GrabFailure.Explain(memo.Values.SelectMany(r => r.Sources), decisions.Values, floor);
        failure = failure with { Detail = detail };
        // Releases exist but none has English: wait for one, never send them (the owner's rule).
        if (searchFailure == null && lastFailure == null && hold.WaitingForEnglish) failure = GrabFailure.NoEnglish with { Detail = detail };
        var message = failure.Sentence;
        logger?.LogInformation("Episode not found {Title} {Episode}: {Detail}", input.Title, cursor.Label, detail);
        // A language hold or refusal is never a real miss: the release exists, so the season pack fallback must not count it.
        if (lastFailure != null)
        {
            if (lastFailure.Storage != null) return lastFailure with { NoReleaseFound = Report("send_failed") };
            await LogSkip(db, input, query, WithDetail(message, detail), ct);
            return lastFailure with { Message = message, NoReleaseFound = Report("send_failed"),
                Failure = (lastFailure.Failure ?? failure) with { Detail = detail },
                RealMiss = !languageHeld && !searchFailed && searchFailure == null && allSendsWithoutFileList };
        }
        await LogSkip(db, input, query, WithDetail(message, detail), ct);
        return new(false, message) { Query = query, Skipped = true,
            HuntMiss = input.Background && !searchFailed && !decisions.Values.Any(d =>
                !d.Reasons.Contains("other_work") && !d.Reasons.Contains("different_episode") && !d.Reasons.Contains("unknown_episode") && !d.Reasons.Contains("pack")),
            NoReleaseFound = Report(searchFailed ? "search_incomplete" : "no_release"), Failure = failure,
            RealMiss = !languageHeld && !searchFailed && searchFailure == null && GrabFailure.IsRealMiss(failure.Code) };
    }

    /// <summary>
    /// One search of the ladder, shared by the single-episode path and the season pack fallback. A pack search leaves
    /// the caller's single-release size limit out (<paramref name="applyMaxSize"/>): that limit applies per chosen file.
    /// </summary>
    private async Task<(SearchResponse Raw, GrabFailure? Failure)> SearchRung(GrabInput input, LadderRung rung, int? floor, bool applyMaxSize,
        CancellationToken ct)
    {
        // `Limit` caps what is fetched and `PageSize` what is returned; both must be 40 or the single is paged away.
        try
        {
            return (await search.SearchAsync(new() { Query = rung.Query, Category = rung.Category, Limit = EpisodeLadder.SearchLimit,
                PageSize = EpisodeLadder.SearchLimit, TargetResolution = floor ?? input.PreferredResolution, Enrich = false,
                SkipCache = true, Background = input.Background, WaitForBudget = true, Urgent = input.Urgent, Sources = input.Sources,
                Filters = rung.Filters with { MinSeeders = input.Constraints?.MinSeeders ?? rung.Filters.MinSeeders,
                    MaxSizeBytes = applyMaxSize ? input.Constraints?.MaxSizeBytes : null, Resolution = input.Constraints?.Resolution },
                IncludeRejectedResults = true }, ct), null);
        }
        catch (Exception error) when (!ct.IsCancellationRequested)
        {
            logger?.LogWarning(error, "Search failed for {Query}", rung.Query);
            return (new() { Query = rung.Query, Sources = [new("search", 0, error.Message)] }, GrabFailure.FromException(error));
        }
    }

    /// <summary>
    /// The quality gate every pick shares: the floor and the caller's constraints, best first, then by language fit
    /// (preferred, neutral, backup, clash). Language never filters here; it only orders (docs/release-language.md).
    /// Releases the owner blocked never pass: only a hand pick can take one again.
    /// </summary>
    private List<TorrentResult> Eligible(GrabInput input, int? floor, IEnumerable<TorrentResult> releases, bool applyMaxSize = true)
    {
        var quality = releases.Where(x => !IsBlocked(input, x) && ReleaseSelection.MeetsFloor(x.Title, floor) &&
            (input.Sources == null || input.Sources.Contains(x.Source)) &&
            (input.Constraints?.MinSeeders == null || x.Seeders >= input.Constraints.MinSeeders) &&
            (!applyMaxSize || input.Constraints?.MaxSizeBytes == null || x.SizeBytes <= input.Constraints.MaxSizeBytes) &&
            (input.Constraints?.Resolution == null || ReleaseSelection.Resolution(x.Title) is { } r && $"{r}p" == input.Constraints.Resolution)).ToList();
        if (floor != null)
            quality = PreferRequestedQuality(quality, floor.Value).ToList();
        return quality.OrderBy(x => ReleaseLanguage.Order(ReleaseLanguage.Verdict(WantOf(input), x.Title, x.Category))).ToList();
    }

    /// <summary>
    /// The language call for one release under the owner's want: <see cref="ReleaseLanguage"/> over its name, the search
    /// site's category and, when known, its files (docs/release-language.md).
    /// </summary>
    private static LanguageCall Judge(GrabInput input, TorrentResult release, IEnumerable<string>? files = null) =>
        LanguageCall.From(ReleaseLanguage.Verdict(WantOf(input), release.Title, release.Category, files));

    private static LanguageWant WantOf(GrabInput input) => input.Language ?? LanguageWant.For(null, input.MediaType, null);

    /// <summary>A release on the owner's blocklist (a replaced release, or one that failed the video check).</summary>
    private static bool IsBlocked(GrabInput input, TorrentResult release) => input.Blocked is { Count: > 0 } blocked &&
        (LibraryJson.Hash(release.InfoHash) ?? LibraryJson.Hash(release.Magnet)) is { } hash && blocked.Contains(hash);


    private static int? PremiereYear(GrabInput input) => input.Cursor is { Season: 1 }
        && input.EpisodeMapping is not { IsSequel: true }
        && input.EpisodeMapping?.AbsoluteOffset is not > 0
        && input.EpisodeMapping?.FranchiseSeason is not > 1 ? input.Year : null;

    /// <summary>The activity log keeps what the search really returned after the owner's sentence.</summary>
    private static string WithDetail(string message, string? detail) =>
        string.IsNullOrWhiteSpace(detail) ? message : $"{message} What we saw: {detail}.";

    /// <summary>Port of the title page's grabWholeWork: one search, identity-checked first survivor, one send.</summary>
    private async Task<GrabResult> Film(TorrentFlowDbContext db, ClientSetting settings, GrabInput input, int? floor, Func<Task>? beforeSend, CancellationToken ct)
    {
        var title = Apostrophes.Normalize(input.Title).Trim();
        if (title.Length == 0) return new(false, "This title has no name to search for. Pick a release yourself.") { Query = title };
        // A wrong category guess returns nothing; an unfiltered search still finds it and identity still rejects other works.
        var category = EpisodeLadder.SearchCategory(input.MediaType) ?? "all";
        var response = await search.SearchAsync(new() { Query = title, Category = category, Limit = 20, TargetResolution = floor ?? input.PreferredResolution,
            Enrich = false, SkipCache = true, Background = input.Background, WaitForBudget = true, Urgent = input.Urgent, Filters = new() { HasMagnet = true, MinSeeders = input.Background ? null : 1 } }, ct);
        var key = input.WorkKey ?? WorkKeySlug.WorkKeyFor(title, input.Year);
        var releases = (floor != null
            ? PreferRequestedQuality(response.Results, floor.Value) : response.Results.AsEnumerable()).Where(r => !IsBlocked(input, r)).ToList();
        GrabResult? lastFailure = null;
        var rung = $"film: {title}";
        // The English rule (docs/release-language.md): Pass releases first, Unknown ones only when no healthy Pass release
        // turned up, Fail ones never.
        var hold = new LanguageHold();
        while (FilmSelection.Select(releases, key, floor) is { } candidate)
        {
            releases.Remove(candidate);
            var call = Judge(input, candidate);
            if (call.Verdict != EnglishVerdict.Pass) { hold.Add(candidate, call, rung, relaxed: false); continue; }
            hold.Tried(candidate);
            if (input.Background && await BackgroundPolicy(db, settings, input, title, candidate, ct) is { } waiting)
                return waiting;
            var result = await Send(db, settings, input, title, candidate, beforeSend, false, ct, context: new(rung, call));
            if (result.Ok) return result;
            if (result.LanguageRefusal != null) hold.Refused(candidate);
            lastFailure = result;
        }
        foreach (var held in hold.Sendable())
        {
            if (input.Background && await BackgroundPolicy(db, settings, input, title, held.Release, ct) is { } waiting)
                return waiting;
            var result = await Send(db, settings, input, title, held.Release, beforeSend, false, ct, context: new(rung, held.Call));
            if (result.Ok)
            {
                logger?.LogInformation("Film {Title}: no healthy English release, sent one with English not stated: {Release}", title, held.Release.Title);
                return result;
            }
            lastFailure = result;
        }
        if (lastFailure != null) return lastFailure;
        if (Stopping) throw new ShuttingDownException(ct);
        var summary = FilmSelection.Summarize(response.Results, key, floor);
        var failure = FilmSelection.NoMatch(title, floor, response.Sources, summary) with { Detail = FilmSelection.Explain(response.Sources, summary, floor) };
        // Releases exist but none has English: wait for one, never send them (the owner's rule).
        if (hold.WaitingForEnglish)
            failure = GrabFailure.NoEnglish with { Detail = $"{hold.Failed} release{(hold.Failed == 1 ? "" : "s")} without English audio or subtitles" };
        logger?.LogInformation("Film not found {Title}: {Detail}", title, failure.Detail);
        await LogSkip(db, input, title, WithDetail(failure.Sentence, failure.Detail), ct);
        return new(false, failure.Sentence) { Query = title, Skipped = true, Failure = failure,
            NoReleaseFound = new { reason = failure.Code, searches = 1, manualSearchQuery = title } };
    }

    private async Task<GrabResult?> BackgroundPolicy(TorrentFlowDbContext db, ClientSetting settings, GrabInput input,
        string query, TorrentResult candidate, CancellationToken ct)
    {
        var options = automationOptions.Value;
        var identity = LibraryJson.Hash(candidate.InfoHash) ?? LibraryJson.Hash(candidate.Magnet) ?? candidate.TorrentUrl ?? candidate.Id;
        if (input.WatchListItemId != null)
        {
            var watch = await db.WatchListItems.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == LocalUser.Id && x.Id == input.WatchListItemId, ct);
            if (watch != null)
            {
                if (watch.LatestReleaseMagnet == candidate.Magnet && candidate.Magnet != null ||
                    await db.EngineTorrents.AnyAsync(x => x.UserId == LocalUser.Id && x.Hash == identity && x.Status != "removed" && x.Status != "error", ct))
                {
                    if (input.Cursor != null) await Advance(db, watch.Id, input.Cursor.Value, candidate.Title, ct);
                    await LogSkip(db, input, query, "Already sent this release", ct);
                    return new(false, "Already sent this release") { Query = query, Skipped = true };
                }
                var since = watch.SeederWaitSince ?? DateTime.UtcNow;
                if (candidate.Seeders < options.MinimumSeeders && CheckSchedule.WaitingForSeeders(since, DateTime.UtcNow, options))
                {
                    var minutes = Math.Max(1, Math.Ceiling(options.SeederWaitTimeoutMinutes - (DateTime.UtcNow - since).TotalMinutes));
                    var message = $"Waiting for seeders: {candidate.Seeders} of {options.MinimumSeeders} are sharing it. Trying again in about {minutes} min.";
                    var next = CheckSchedule.Next(DateTime.UtcNow, null, watch.CursorMisses, since, SettingsDefaults.AutomationIntervalOrDefault(settings.AutomationIntervalMinutes), options);
                    await db.WatchListItems.Where(x => x.Id == watch.Id).ExecuteUpdateAsync(x => x.SetProperty(w => w.SeederWaitSince, since)
                        .SetProperty(w => w.NextCheckAt, next.At).SetProperty(w => w.NextCheckReason, next.Reason)
                        .SetProperty(w => w.LastChecked, DateTime.UtcNow), ct);
                    await LogSkip(db, input, query, message, ct);
                    return new(false, message) { Query = query, Skipped = true };
                }
            }
        }
        return null;
    }

    /// <summary>A release the owner chose by hand (<see cref="ReleasePicker"/>), sent like any automatic pick.</summary>
    public async Task<GrabResult> SendPicked(GrabInput input, TorrentResult release, string query, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var (prepared, settings, _, refusal) = await Prepare(db, input, query, ct);
        if (refusal != null) return refusal;
        // A hand pick always goes: the owner saw the language note and chose it.
        return await Send(db, settings!, prepared, query, release, null, relaxed: true, ct,
            context: new("picked by hand", Judge(prepared, release), Picked: true));
    }

    /// <summary>Sends one pinned candidate and records the attempt; the recorded query stays the canonical one.</summary>
    /// <param name="pack">A season pack admission: only these files, with the reservation of the pieces they touch.</param>
    /// <param name="context">The rung that found the release and its language call, kept on the GrabJob row.</param>
    private async Task<GrabResult> Send(TorrentFlowDbContext db, ClientSetting settings, GrabInput input, string query, TorrentResult candidate,
        Func<Task>? beforeSend, bool relaxed, CancellationToken ct, PackSelection? pack = null, SendContext? context = null)
    {
        if (beforeSend != null) await beforeSend();
        EngineAddResult result;
        try
        {
            result = await engine.AddAsync(new() { Magnet = candidate.Magnet, TorrentUrl = candidate.TorrentUrl,
                InfoHash = candidate.InfoHash, Name = candidate.Title, Purpose = TorrentPurpose.Keep,
                Source = candidate.Source, SearchCategory = EpisodeLadder.SearchCategory(input.MediaType) ?? "all",
                Placement = Placement(input, candidate, pack),
                SourceCategory = candidate.Category,
                Language = new EngineLanguageCheck(WantOf(input), context?.Language?.Fit, context?.Language?.Label, context?.AcceptClash ?? false),
                QueueKey = pack?.QueueKey ?? input.Cursor?.QueueKey, WorkId = input.WorkId, ExpectedSizeBytes = pack?.ReserveBytes ?? candidate.SizeBytes,
                OverrideStorageCap = input.OverrideStorageCap, Lane = input.QueueLane, RequireMetadata = true, SelectedFiles = pack?.Files }, ct);
            result = EngineAddMessages.WithFormattedMessage(result);
        }
        catch (Exception error) when (!ct.IsCancellationRequested && !Stopping) { result = new(false, error.Message); }
        // A failure caused by shutdown is no verdict on the release: nothing is recorded and the attempt resumes after the restart.
        if (!result.Ok && Stopping) throw new ShuttingDownException(ct);
        var hash = LibraryJson.Hash(result.Hash) ?? LibraryJson.Hash(candidate.InfoHash) ?? LibraryJson.Hash(candidate.Magnet);
        var queued = result.Details?.Action == EngineAddDetails.Queued;
        var logged = EngineAddMessages.Outcome(result);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var now = DateTime.UtcNow;
        db.GrabJobs.Add(new GrabJob { Id = Ids.New(), UserId = LocalUser.Id, Title = candidate.Title, Query = query,
            Status = result.Ok ? "sent" : "failed", Message = logged, Magnet = candidate.Magnet, InfoHash = hash,
            Source = candidate.Source, Kind = input.Background ? "library" : "ondemand", ExternalId = input.WatchListItemId, Retention = "keep",
            Rung = context?.Rung, Language = context?.NoteWith(result.Language), CreatedAt = now, UpdatedAt = now });
        db.DownloadHistories.Add(new DownloadHistory { Id = Ids.New(), UserId = LocalUser.Id, Title = candidate.Title,
            Status = result.Ok ? "sent" : "failed", Message = logged, Magnet = candidate.Magnet, TorrentUrl = candidate.TorrentUrl,
            InfoHash = hash, Source = candidate.Source, WorkId = input.WorkId, Retention = "keep", Context = "ondemand",
            ClientType = "builtin", SendKind = candidate.Magnet != null ? "magnet" : "torrent", CreatedAt = now });
        var advanced = false;
        if (result.Ok && input.WatchListItemId != null && input.Cursor != null)
            advanced = await Advance(db, input.WatchListItemId, input.Cursor.Value, candidate.Title, ct);
        if (result.Ok && input.Background && input.WatchListItemId != null)
            await db.WatchListItems.Where(x => x.Id == input.WatchListItemId).ExecuteUpdateAsync(x =>
                x.SetProperty(w => w.LatestReleaseMagnet, candidate.Magnet).SetProperty(w => w.CursorMisses, 0)
                    .SetProperty(w => w.SeederWaitSince, (DateTime?)null).SetProperty(w => w.NextCheckAt, (DateTime?)null)
                    .SetProperty(w => w.NextCheckReason, (string?)null), ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        if (!result.Ok)
        {
            var storage = result.StorageLimit == null ? null : StorageFacts.Refusal(settings, result.StorageLimit, result.Message,
                pack?.ReserveBytes ?? candidate.SizeBytes, await engine.QueuedReservedBytesAsync(ct));
            var refusedFor = result.Unusable == "audio_language" ? result.Language ?? "audio_other" : null;
            var failure = storage != null ? GrabFailure.Storage
                : refusedFor != null ? GrabFailure.WrongLanguage
                : result.Unusable != null ? GrabFailure.BadRelease
                : result.InvalidField == "savePath" ? new GrabFailure("download_folder", "The download folder cannot be used.",
                    "Choose a writable download folder in Settings, then retry.")
                : result.Message.Contains("file list", StringComparison.OrdinalIgnoreCase)
                    ? candidate.Seeders <= 0
                        ? new GrabFailure("no_seeders", "The available releases have no seeders and supplied no file list.",
                            "Retry later when seeders are online, or find another source.")
                        : GrabFailure.Metadata
                    : GrabFailure.Unknown;
            return new(false, result.Message) { Query = query, Title = candidate.Title, Magnet = candidate.Magnet,
                Source = candidate.Source, Storage = storage, Failure = failure, LanguageRefusal = refusedFor };
        }
        // Honestly label the provenance when the ladder had to relax to win.
        var notes = new List<string>();
        if (advanced && !input.Background) notes.Add($"advanced past {input.Cursor?.Label}");
        if (relaxed) notes.Add("low-seed release");
        var next = input.Cursor?.Next();
        // The engine picks the smart target on add; report where the transfer actually lives.
        var savePath = hash == null ? null : (await engine.GetAsync(hash, ct))?.SavePath;
        return new(true, notes.Count == 0 ? result.Message : $"{result.Message} · {string.Join(" · ", notes)}") { Query = query, Title = candidate.Title,
            Magnet = candidate.Magnet, InfoHash = hash, Queued = queued, QueuePosition = result.Details?.QueuePosition, Advanced = advanced,
            SavePath = savePath, Source = candidate.Source,
            LastEpisode = advanced ? input.Cursor?.Label : null, CursorSeason = advanced ? next?.Season : null,
            CursorEpisode = advanced ? next?.Episode : null, NextEpisodeHint = advanced ? next?.Query(input.Title) : null };
    }

    /// <summary>
    /// Where the work lands: its catalog title and the catalog season (the episode's, or the pack's), so every episode
    /// of a show shares one folder whatever its release is called.
    /// </summary>
    private static WorkPlacement? Placement(GrabInput input, TorrentResult release, PackSelection? pack)
    {
        var title = (input.Title ?? "").Trim();
        if (title.Length == 0) return null;
        var season = (pack == null ? null : TorrentFlow.Core.QueueKeys.Parse(pack.QueueKey)?.Season) ?? input.Cursor?.Season;
        var film = pack == null && input.Cursor == null;
        // An anime source decides on its own: the work's AniList (or other anime catalog) identity, or a release from a site's anime category.
        var anime = input.Anime || AnimeIdentity.IsAnime(input.Provider, input.MediaType, input.ProviderId) || AnimeIdentity.IsAnimeSiteCategory(release.Category);
        return new(title, input.Year, anime, film, film ? null : season);
    }

    private static async Task LogSkip(TorrentFlowDbContext db, GrabInput input, string query, string message, CancellationToken ct)
    {
        db.GrabJobs.Add(new() { Id = Ids.New(), UserId = LocalUser.Id, Title = input.Title, Query = query, Status = "skipped",
            Message = message, Kind = input.Background ? "library" : "ondemand", ExternalId = input.WatchListItemId, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync(ct);
    }

    internal static IOrderedEnumerable<TorrentResult> PreferRequestedQuality(IEnumerable<TorrentResult> releases, int floor) =>
        releases.OrderBy(r => r.Seeders > 0 ? 0 : 1)
            .ThenBy(r => ReleaseSelection.Resolution(r.Title) is { } resolution ? Math.Abs(resolution - floor) : int.MaxValue)
            .ThenBy(r => System.Text.RegularExpressions.Regex.IsMatch(r.Title, @"\bremux\b",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant,
                TimeSpan.FromSeconds(1)) ? 1 : 0)
            .ThenBy(r => r.SizeBytes is > 0 ? r.SizeBytes : long.MaxValue)
            .ThenByDescending(r => r.Seeders);

    internal static async Task<bool> Advance(TorrentFlowDbContext db, string id, EpisodeCursor grabbed, string title, CancellationToken ct)
    {
        var item = await db.WatchListItems.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.UserId == LocalUser.Id, ct);
        if (item == null || EpisodeCursor.Resolve(item) != grabbed) return false;
        var next = grabbed.Next();
        var now = DateTime.UtcNow;
        var moved = await db.WatchListItems.Where(x => x.Id == id && x.CursorSeason == item.CursorSeason && x.CursorEpisode == item.CursorEpisode)
            .ExecuteUpdateAsync(x => x.SetProperty(w => w.CursorSeason, next.Season).SetProperty(w => w.CursorEpisode, next.Episode)
                .SetProperty(w => w.LastEpisode, grabbed.Label).SetProperty(w => w.NextEpisodeHint, next.Query(item.Title))
                .SetProperty(w => w.CursorMisses, 0).SetProperty(w => w.SeederWaitSince, (DateTime?)null)
                .SetProperty(w => w.NextCheckAt, (DateTime?)null).SetProperty(w => w.NextCheckReason, (string?)null)
                .SetProperty(w => w.LastChecked, now).SetProperty(w => w.UpdatedAt, now)
                .SetProperty(w => w.LatestReleaseTitle, title).SetProperty(w => w.LatestReleaseAt, now)
                .SetProperty(w => w.FromSeason, item.FromSeason ?? grabbed.Season).SetProperty(w => w.FromEpisode, item.FromSeason == null ? grabbed.Episode : item.FromEpisode), ct);
        return moved > 0;
    }
}
