using TorrentFlow.Core;
using TorrentFlow.Core.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using System.Text.Json;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Grabs;

public sealed record ReleaseAlternative(string Token, string Hash, string Title, int Seeders, int Peers,
    long? SizeBytes, int? Quality, string Source, string Why, ReleaseBlockInfo? Blocked = null, ReleaseLanguageInfo? Languages = null);
public sealed record ReleaseSwapSource(string Id, string Name, int? Count);
/// <summary>The download being replaced, as the dialog shows it above the alternatives.</summary>
public sealed record ReleaseSwapCurrent(string Title, string? Source, long? SizeBytes, int? Quality, bool Finished, ReleaseLanguageInfo? Languages);
/// <param name="Note">What happens to the current files; null leaves the dialog's own words for an unfinished download.</param>
public sealed record ReleaseAlternatives(TransferHealth Health, IReadOnlyList<ReleaseAlternative> Alternatives,
    IReadOnlyList<ReleaseSwapSource> Sources, string? RecommendedToken, ReleaseSwapCurrent? Current = null, string? Note = null);
public sealed record RankedRelease(TorrentResult Result, double Score, string Why);

/// <summary>A release's languages under the owner's audio language setting, as the release dialogs show them (web release-language.tsx).</summary>
/// <param name="Audio">Display names, e.g. "Japanese".</param>
/// <param name="SubtitleState">known_english, known_non_english, unknown or mixed. Untagged subtitles are unknown, never English.</param>
/// <param name="Fit">preferred, neutral, backup or clash.</param>
/// <param name="Basis">Where the deciding fact came from: name, category, files, header, indexer, group or none.</param>
/// <param name="Confidence">high, medium or low.</param>
/// <param name="English">The English rule: pass, unknown or fail (docs/release-language.md).</param>
/// <param name="EnglishReason">What decided it, in plain words ("English subtitles", "French subtitles only").</param>
/// <param name="Hint">Where facts from before the download came from: animetosho (its track lists) or filelist (the site's file
/// list); null when only the name and site category spoke.</param>
public sealed record ReleaseLanguageInfo(IReadOnlyList<string> Audio, IReadOnlyList<string> Subtitles, string SubtitleState,
    string Fit, string Basis, string Confidence, string Label, string English = "unknown", string? EnglishReason = null, string? Hint = null)
{
    public static ReleaseLanguageInfo From(LanguageVerdict verdict) => new(
        verdict.Audio.Select(ReleaseLanguage.LanguageName).Distinct().ToArray(),
        verdict.Subtitles.Select(ReleaseLanguage.LanguageName).Distinct().ToArray(),
        verdict.SubtitleState switch
        {
            TorrentFlow.Core.SubtitleState.KnownEnglish => "known_english",
            TorrentFlow.Core.SubtitleState.KnownNonEnglish => "known_non_english",
            TorrentFlow.Core.SubtitleState.Mixed => "mixed",
            _ => "unknown"
        },
        verdict.Fit.ToString().ToLowerInvariant(), verdict.Basis, verdict.Confidence, verdict.Label,
        verdict.English.Verdict.ToString().ToLowerInvariant(), verdict.English.Reason, verdict.Hint);
}

/// <summary>Manual selection today; a future recovery policy can consume the same alternatives and swap command.</summary>
public sealed class ReleaseSwapService(IDbContextFactory<TorrentFlowDbContext> factory, ITorrentSearchService search,
    ITorrentEngine engine, IMemoryCache cache, TorrentFlow.Core.Sources.SourceRegistry? registry = null,
    EpisodeSearchIdentity? searchIdentity = null, TorrentFlow.Core.Contracts.Library.ILibraryAnimeLookup? anime = null,
    GrabService? grabs = null, AnimeEpisodeMappings? episodeMappings = null)
{
    private sealed record Choice(string CurrentHash, EngineReleaseSwap Swap);

    public Task<ReleaseAlternatives> Alternatives(string hash, CancellationToken ct) => Alternatives(hash, null, ct);

    public async Task<ReleaseAlternatives> Alternatives(string hash, string? source, CancellationToken ct)
    {
        source = string.IsNullOrWhiteSpace(source) || source.Trim().Equals("all", StringComparison.OrdinalIgnoreCase) ? null : source.Trim().ToLowerInvariant();
        hash = hash.Trim().ToLowerInvariant();
        await using var db = await factory.CreateDbContextAsync(ct);
        var row = await db.EngineTorrents.AsNoTracking().Include(r => r.Work)
            .SingleOrDefaultAsync(r => r.UserId == LocalUser.Id && r.Hash == hash, ct)
            ?? throw new InvalidOperationException("Download no longer exists.");
        var info = await engine.GetAsync(hash, ct) ?? throw new InvalidOperationException("Download no longer exists.");
        if (info.Progress >= .9999 || row.VerifiedAt is not null && row.Progress >= .9999)
            throw new InvalidOperationException("This download is already complete, so there's nothing to replace.");
        if (info.Imported)
            throw new InvalidOperationException("This download was added from files already on your disk, so it has no release to swap. Delete it and download the title again to choose a release.");
        // Torrent metadata can rename a release to an opaque payload filename. Keep the acquisition identity.
        var grabbed = await ReleaseBlocks.GrabbedAsync(db, LocalUser.Id, hash, ct);
        var releaseName = grabbed?.Title ?? row.Name;
        var identity = ReleaseNames.IdentityFor(releaseName);
        var title = Apostrophes.Normalize(row.Work?.CanonicalTitle ?? identity.Name);
        var previousWorkKey = await ReleaseBlocks.WorkKeyForAsync(db, LocalUser.Id, hash, ct);
        var workKey = row.Work?.WorkKey ?? previousWorkKey ?? WorkKeySlug.WorkKeyFor(identity.Name, identity.Year);
        var episode = ReleaseEpisodeParser.Parse(releaseName);
        var target = await db.AcquisitionTargets.AsNoTracking().FirstOrDefaultAsync(t => t.UserId == LocalUser.Id && t.InfoHash == hash, ct);
        EpisodeCursor? cursor = target?.Episode is { } e && target.Season is { } s ? new(s, e) : null;
        cursor ??= EpisodeCursor.FromQueueKey(row.QueueKey);
        cursor ??= episode.Episode is { } parsedEpisode ? new(episode.Season ?? 1, parsedEpisode) : null;
        if (episode.IsMultiSeason == true || episode.IsBatch && !episode.IsSeasonPack)
            throw new InvalidOperationException("This release has an ambiguous scope. Choose a single episode from its title page.");
        if (cursor is null && !episode.IsSeasonPack && (row.Work?.IsSeries() ?? identity.IsSeries))
            throw new InvalidOperationException("Could not identify the exact episode to replace.");
        var scope = cursor?.QueueKey ?? (episode.IsSeasonPack && episode.Season is { } season ? $"season:{season}" : "movie");
        if (episode.IsSeasonPack && episode.Season is null) throw new InvalidOperationException("Could not identify the release's season.");
        // Releases already tried here stay hidden, unless blocked: those come back so they can be listed last.
        var tried = (await db.ReleaseAttempts.Where(r => r.UserId == LocalUser.Id && r.WorkKey == workKey && r.Scope == scope)
            .Select(r => r.Hash).ToListAsync(ct)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        tried.ExceptWith((await ReleaseBlocks.GetAsync(db, LocalUser.Id, tried, ct)).Keys);
        tried.UnionWith(await db.EngineTorrents.Where(r => r.UserId == LocalUser.Id).Select(r => r.Hash).ToListAsync(ct));
        var floor = target?.PreferredResolution ?? ReleaseSelection.Resolution(releaseName);
        var mediaType = row.Work?.MediaType ?? (identity.IsSeries ? "tv" : "movie");
        IReadOnlyList<string> aliases = row.Work?.ReadNames().Others(row.Work.CanonicalTitle) ?? [];
        if (cursor != null && searchIdentity != null)
            (mediaType, aliases) = await searchIdentity.ResolveAsync(title, row.Work?.Year, mediaType, aliases, ct,
                row.Work?.Provider, row.Work?.ProviderId);
        TorrentFlow.Core.Contracts.Library.AnimeEpisodeMapping? mapping = null;
        if (cursor is { } mappedCursor && anime != null)
            mapping = await (episodeMappings ?? new AnimeEpisodeMappings(anime)).ForAsync(workKey, title, row.Work?.Year, mediaType,
                row.Work?.Provider, row.Work?.ProviderId, mappedCursor, ct);
        var query = cursor?.Query(title) ?? (scope.StartsWith("season:", StringComparison.Ordinal) ? $"{title} S{episode.Season:00}" : title);
        var rungs = cursor is { } targetEpisode ? EpisodeLadder.BuildEpisodeRungs(title, targetEpisode, mediaType, aliases, floor, mapping, preferRequestedQuality: true)
            : [new LadderRung("exact", query, EpisodeLadder.SearchCategory(mediaType) ?? "all",
                new() { HasMagnet = true, MinSeeders = 1, Season = episode.Season })];
        // The registry's enabled torrent sources for this category are what the search fan-out would query anyway.
        var searchable = registry?.Active("torrent", rungs[0].Category).Select(e => e.Id).ToList();
        if (source is not null && searchable is not null && !searchable.Contains(source, StringComparer.OrdinalIgnoreCase))
            throw new InvalidOperationException("That site is turned off or can't search this kind of title. Choose another site.");
        var open = new List<TorrentResult>();
        var held = new List<TorrentResult>();
        var blocks = new Dictionary<string, TorrentFlow.Data.Entities.ReleaseBlock>(StringComparer.OrdinalIgnoreCase);
        var sources = new List<SourceStatus>();
        // The current release is judged with its site category like every candidate: kept with its engine row since the
        // English check, else read from the search when the same release turns up again.
        var currentCategory = EngineLanguageState.Read(row.LanguageCheckJson)?.SourceCategory;
        foreach (var rung in rungs)
        {
            var response = await search.SearchAsync(new SearchOptions { Query = rung.Query, Category = rung.Category,
                Limit = EpisodeLadder.SearchLimit, PageSize = EpisodeLadder.SearchLimit, Enrich = false, SkipCache = true,
                TargetResolution = floor, Filters = rung.Filters, Sources = source is null ? null : [source] }, ct);
            sources.AddRange(response.Sources);
            currentCategory ??= response.Results.FirstOrDefault(r =>
                string.Equals(LibraryJson.Hash(r.InfoHash) ?? LibraryJson.Hash(r.Magnet), hash, StringComparison.OrdinalIgnoreCase))?.Category;
            var selected = Select(response.Results,
                workKey, title, cursor, episode.IsSeasonPack ? episode.Season : null, floor, tried, aliases, mapping);
            foreach (var (blockedHash, block) in await ReleaseBlocks.GetAsync(db, LocalUser.Id, selected.Select(CandidateHash), ct))
                blocks[blockedHash] = block;
            // A rung that finds only blocked releases keeps them for the end of the list and goes on to the next rung.
            var blocked = selected.Where(r => blocks.ContainsKey(CandidateHash(r))).ToList();
            held.AddRange(blocked);
            tried.UnionWith(blocked.Select(CandidateHash));
            open = selected.Where(r => !blocks.ContainsKey(CandidateHash(r))).ToList();
            if (open.Count > 0) break;
        }
        if (open.Count == 0 && held.Count == 0 && FilmSelection.SourceOutageMessage(sources) is { } outage) throw new InvalidOperationException(outage);
        var alternatives = new List<ReleaseAlternative>();
        var currentSize = row.SizeBytes > 0 ? row.SizeBytes : (long?)null;
        var currentQuality = ReleaseSelection.Resolution(releaseName) ?? floor;
        var settings = await db.ClientSettings.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == LocalUser.Id, ct);
        var want = grabs != null
            ? await grabs.LanguageWantAsync(settings?.AudioLanguage, mediaType, row.Work?.Provider, row.Work?.ProviderId, ct, row.Work?.OriginalLanguage, row.Work?.IsAnime())
            : LanguageWant.For(settings?.AudioLanguage, row.Work?.IsAnime() == true ? "anime" : mediaType, row.Work?.OriginalLanguage);
        var header = await MediaProbeTracks.ForAsync(db, open.Concat(held).Select(CandidateHash).Append(hash), ct);

        var current = new ReleaseSwapCurrent(releaseName, grabbed?.Source, currentSize, ReleaseSelection.Resolution(releaseName), false,
            ReleaseLanguageInfo.From(KnownLanguage.Judge(want, releaseName, currentCategory, info.Files, header.GetValueOrDefault(hash))));
        // The English rule orders the list like the picker and the automatic picks (Pass, then unknown, then fail), then the
        // score. Blocked releases go last whatever their score: listed for "Use it anyway", never recommended or picked as best.
        var verdicts = open.Concat(held).DistinctBy(CandidateHash)
            .ToDictionary(CandidateHash, r => KnownLanguage.Judge(want, r.Title, r.Category, null, header.GetValueOrDefault(CandidateHash(r)),
                r.LanguageHint), StringComparer.OrdinalIgnoreCase);
        int English(TorrentResult r) => ReleaseLanguage.Order(verdicts[CandidateHash(r)]);
        var listed = Rank(open, currentQuality, currentSize, English).Take(20)
            .Concat(Rank(held, currentQuality, currentSize, English).Select(r => r with { Why = Describe(r.Result) }));
        foreach (var ranked in listed)
        {
            var result = ranked.Result;
            var candidateHash = CandidateHash(result);
            var token = Guid.NewGuid().ToString("N");
            cache.Set($"release-swap:{token}", new Choice(hash, new(workKey, scope, candidateHash, result.Title, result.Magnet, result.SizeBytes, result.Source)),
                TimeSpan.FromMinutes(10));
            alternatives.Add(new(token, candidateHash, result.Title, result.Seeders, result.Leechers, result.SizeBytes,
                ReleaseSelection.Resolution(result.Title), result.Source, ranked.Why,
                blocks.TryGetValue(candidateHash, out var block) ? ReleaseBlocks.Info(block) : null,
                ReleaseLanguageInfo.From(verdicts[candidateHash])));
        }
        var found = open.Concat(held).GroupBy(r => r.Source, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.Count(), StringComparer.OrdinalIgnoreCase);
        // A single-source search can't count the others, so reuse the last all-source counts for this download.
        var countsKey = $"release-swap-counts:{hash}";
        var counts = source is null ? new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
            : new Dictionary<string, int>(cache.Get<Dictionary<string, int>>(countsKey) ?? [], StringComparer.OrdinalIgnoreCase);
        var ids = searchable ?? sources.Select(s => s.Id).Concat(found.Keys).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        // Duplicate listings collapse onto one source, so an all-source 0 is unproven: only a one-source search reports 0.
        foreach (var id in ids)
            if (source is null ? found.ContainsKey(id) : id.Equals(source, StringComparison.OrdinalIgnoreCase)) counts[id] = found.GetValueOrDefault(id);
        cache.Set(countsKey, counts, TimeSpan.FromMinutes(10));
        var sourceList = ids.Select(id => new ReleaseSwapSource(id, id, counts.TryGetValue(id, out var n) ? n : null)).ToList();
        // Never recommends a release without English: with none left there is no best match.
        return new(info.Health ?? new(null, info.Peers, info.Dlspeed, 0, info.State), alternatives, sourceList,
            alternatives.FirstOrDefault(Recommendable)?.Token, current);
    }

    /// <summary>What "Best match" and "Find the best one for me" may land on: not blocked, and not a release without English.</summary>
    private static bool Recommendable(ReleaseAlternative a) => a.Blocked is null && a.Languages?.English != "fail";

    /// <summary>Searches, then swaps to the recommended release when it has more seeders than the current swarm offers.</summary>
    public async Task<EngineAddResult> SwapBest(string hash, string? source, CancellationToken ct)
    {
        var found = await Alternatives(hash, source, ct);
        var where = string.IsNullOrWhiteSpace(source) || source.Equals("all", StringComparison.OrdinalIgnoreCase) ? "on any source" : $"on {source.Trim()}";
        var best = found.RecommendedToken is { } token ? found.Alternatives.FirstOrDefault(a => a.Token == token) : null;
        if (best is null || best.Seeders <= (found.Health.ConnectedSeeders ?? 0))
            return new(false, $"No better release was found {where}. Your current download was kept.");
        return await Swap(hash, best.Token, false, ct, byHand: false);
    }

    /// <summary>
    /// One deterministic score, best first: quality match to the current release, seeders (diminishing),
    /// size sanity against the current release, then the search health score. Ties break on seeders, size, hash.
    /// </summary>
    /// <param name="first">Orders before the score, lowest first: the English rule (<see cref="ReleaseLanguage.Order"/>).</param>
    public static IReadOnlyList<RankedRelease> Rank(IReadOnlyList<TorrentResult> candidates, int? currentQuality, long? currentSize,
        Func<TorrentResult, int>? first = null)
    {
        var sizes = candidates.Select(r => r.SizeBytes).OfType<long>().Where(s => s > 0).Order().ToList();
        long? reference = currentSize ?? (sizes.Count > 0 ? sizes[sizes.Count / 2] : null);
        double Score(TorrentResult r)
        {
            var quality = ReleaseSelection.Resolution(r.Title);
            double score = currentQuality is null || quality is null ? 0 : quality == currentQuality ? 30 : quality > currentQuality ? 15 : 0;
            score += Math.Min(60, 10 * Math.Log2(1 + Math.Max(0, r.Seeders)));
            if (reference is > 0 && r.SizeBytes is > 0 and var size)
                score += size / (double)reference.Value is >= .4 and <= 2.5 ? 10 : -20;
            return score + Math.Clamp(r.Health ?? 0, 0, 100) / 10.0;
        }
        var ordered = candidates.Select(r => (Result: r, Score: Math.Round(Score(r), 6)))
            .OrderBy(x => first?.Invoke(x.Result) ?? 0).ThenByDescending(x => x.Score).ThenByDescending(x => x.Result.Seeders)

            .ThenBy(x => x.Result.SizeBytes ?? long.MaxValue)
            .ThenBy(x => LibraryJson.Hash(x.Result.InfoHash) ?? x.Result.Id, StringComparer.Ordinal).ToList();
        var maxSeeders = ordered.Count == 0 ? 0 : ordered.Max(x => x.Result.Seeders);
        var topSeeded = ordered.Count(x => x.Result.Seeders == maxSeeders);
        var byQuality = ordered.GroupBy(x => ReleaseSelection.Resolution(x.Result.Title) ?? 0).ToDictionary(g => g.Key, g => g.Count());
        return ordered.Select((x, i) =>
        {
            var r = x.Result;
            var quality = ReleaseSelection.Resolution(r.Title);
            var label = quality is { } q ? $"{q}p" : null;
            var ratio = reference is > 0 && r.SizeBytes is > 0 ? r.SizeBytes.Value / (double)reference.Value : (double?)null;
            string why;
            if (ordered.Count == 1)
                why = label is null ? $"The only other release found ({Seeders(r.Seeders)})" : $"The only other {label} release found ({Seeders(r.Seeders)})";
            else if (r.Seeders == maxSeeders && topSeeded == 1) why = $"Most seeders ({r.Seeders})";
            else if (quality is { } only && byQuality[only] == 1)
                why = only == currentQuality ? $"Only other {label} release" : $"Only {label} release";
            else if (quality is not null && quality == currentQuality && currentSize is > 0 && ratio is < .9)
                why = $"Same quality, {Math.Round((1 - ratio!.Value) * 100)}% smaller file";
            else if (quality is not null && currentQuality is not null && quality > currentQuality)
                why = $"Higher quality ({label}), {Seeders(r.Seeders)}{Size(r.SizeBytes)}";
            else if (ratio is < .4 or > 2.5) why = $"Unusual size for {label ?? "this release"}, {Seeders(r.Seeders)}";
            else if (i == 0) why = $"Best balance of quality and seeders ({(label is null ? "" : label + ", ")}{Seeders(r.Seeders)})";
            else if (quality is not null && quality == currentQuality) why = $"Same quality, {Seeders(r.Seeders)}{Size(r.SizeBytes)}";
            else why = Describe(r);
            return new RankedRelease(r, x.Score, why);
        }).ToList();
    }

    /// <summary>A plain description of a release: seeders, quality and size.</summary>
    private static string Describe(TorrentResult r) => (ReleaseSelection.Resolution(r.Title) is { } quality
        ? $"{Seeders(r.Seeders)} at {quality}p" : Seeders(r.Seeders)) + Size(r.SizeBytes);

    private static string CandidateHash(TorrentResult r) => LibraryJson.Hash(r.InfoHash) ?? LibraryJson.Hash(r.Magnet)!;

    private static string Seeders(int count) => count == 1 ? "1 seeder" : $"{count} seeders";

    private static string Size(long? bytes) => bytes is not > 0 ? "" : bytes >= 1L << 30
        ? FormattableString.Invariant($", {bytes.Value / (double)(1L << 30):0.#} GB") : $", {Math.Max(1, bytes.Value >> 20)} MB";

    public Task<EngineAddResult> Swap(string hash, string token, CancellationToken ct) => Swap(hash, token, false, ct);

    /// <summary>
    /// Swaps to a listed release. One this user blocked needs <paramref name="useBlocked"/> ("Use it anyway"), and the
    /// swap then lifts its block; without it the swap is refused with <see cref="ReleaseBlocks.UseAnywayMessage"/>.
    /// <paramref name="byHand"/>: the owner picked this release in the list (provenance hand); Find the best one is automatic.
    /// </summary>
    public async Task<EngineAddResult> Swap(string hash, string token, bool useBlocked, CancellationToken ct, bool byHand = true)
    {
        if (!cache.TryGetValue<Choice>($"release-swap:{token}", out var choice) || choice is null
            || !choice.CurrentHash.Equals(hash, StringComparison.OrdinalIgnoreCase))
            return new(false, "This selection expired. Find releases again.");
        bool blocked;
        await using (var db = await factory.CreateDbContextAsync(ct))
            blocked = (await ReleaseBlocks.GetAsync(db, LocalUser.Id, [choice.Swap.Hash], ct)).Count > 0;
        if (blocked && !useBlocked) return new(false, ReleaseBlocks.UseAnywayMessage);
        return await engine.SwapAsync(choice.CurrentHash, choice.Swap with { UseBlocked = blocked, ByHand = byHand }, ct);
    }

    public static IReadOnlyList<TorrentResult> Select(IEnumerable<TorrentResult> ranked, string workKey, string title,
        EpisodeCursor? cursor, int? seasonPack, int? floor, ISet<string> excluded, IReadOnlyList<string>? aliases = null,
        TorrentFlow.Core.Contracts.Library.AnimeEpisodeMapping? mapping = null)
    {
        var seen = new HashSet<string>(excluded, StringComparer.OrdinalIgnoreCase);
        var titles = (aliases ?? []).Prepend(title).SelectMany(EpisodeLadder.AliasTitleForms).ToList();
        return ranked.Where(r =>
        {
            var hash = LibraryJson.Hash(r.InfoHash) ?? LibraryJson.Hash(r.Magnet);
            if (hash is null || LibraryJson.Hash(r.Magnet) != hash || !seen.Add(hash) || !ReleaseSelection.MeetsFloor(r.Title, floor)) return false;
            if (cursor is { } ep) return EpisodeLadder.ReleaseMatchesWork(r, titles) && EpisodeLadder.MatchesTargetEpisode(r, ep, mapping);
            if (seasonPack is { } season)
            {
                var parsed = r.Episode ?? ReleaseEpisodeParser.Parse(r.Title);
                return EpisodeLadder.ReleaseMatchesWork(r, titles) && parsed.IsSeasonPack && parsed.IsMultiSeason != true && parsed.Season == season;
            }
            return FilmSelection.Select([r], workKey, floor) is not null;
        }).ToList();
    }
}
