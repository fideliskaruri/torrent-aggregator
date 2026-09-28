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
    long? SizeBytes, int? Quality, string Source, string Why);
public sealed record ReleaseSwapSource(string Id, string Name, int? Count);
public sealed record ReleaseAlternatives(TransferHealth Health, IReadOnlyList<ReleaseAlternative> Alternatives,
    IReadOnlyList<ReleaseSwapSource> Sources, string? RecommendedToken);
public sealed record RankedRelease(TorrentResult Result, double Score, string Why);

/// <summary>Manual selection today; a future recovery policy can consume the same alternatives and swap command.</summary>
public sealed class ReleaseSwapService(IDbContextFactory<TorrentFlowDbContext> factory, ITorrentSearchService search,
    ITorrentEngine engine, IMemoryCache cache, TorrentFlow.Core.Sources.SourceRegistry? registry = null)
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
        if (info.Imported || info.Progress >= .9999 || row.Origin != TorrentOrigin.User)
            throw new InvalidOperationException("Only incomplete kept downloads can be replaced.");
        // Torrent metadata can rename a release to an opaque payload filename. Keep the acquisition identity.
        var releaseName = await db.GrabJobs.AsNoTracking().Where(j => j.UserId == LocalUser.Id && j.InfoHash == hash)
            .OrderByDescending(j => j.CreatedAt).Select(j => j.Title).FirstOrDefaultAsync(ct)
            ?? await db.DownloadHistories.AsNoTracking().Where(j => j.UserId == LocalUser.Id && j.InfoHash == hash)
                .OrderByDescending(j => j.CreatedAt).Select(j => j.Title).FirstOrDefaultAsync(ct) ?? row.Name;
        var identity = ReleaseNames.IdentityFor(releaseName);
        var title = row.Work?.CanonicalTitle ?? identity.Name;
        var previousWorkKey = await db.ReleaseAttempts.AsNoTracking().Where(a => a.UserId == LocalUser.Id && a.Hash == hash)
            .OrderByDescending(a => a.TriedAt).Select(a => a.WorkKey).FirstOrDefaultAsync(ct);
        var workKey = row.Work?.WorkKey ?? previousWorkKey ?? ReleaseNames.WorkKeyFor(identity.Name, identity.Year);
        var episode = ReleaseNames.ParseEpisode(releaseName);
        var target = await db.AcquisitionTargets.AsNoTracking().FirstOrDefaultAsync(t => t.UserId == LocalUser.Id && t.InfoHash == hash, ct);
        EpisodeCursor? cursor = target?.Episode is { } e && target.Season is { } s ? new(s, e)
            : episode.Episode is { } parsedEpisode ? new(episode.Season ?? 1, parsedEpisode) : null;
        if (cursor is null && row.QueueKey is { Length: 12 } key && key[0] == 's' && key[6] == 'e'
            && int.TryParse(key.AsSpan(1, 5), out var qs) && int.TryParse(key.AsSpan(7, 5), out var qe)) cursor = new(qs, qe);
        if (episode.IsMultiSeason == true || episode.IsBatch && !episode.IsSeasonPack)
            throw new InvalidOperationException("This release has an ambiguous scope. Choose a single episode from its title page.");
        if (cursor is null && !episode.IsSeasonPack && (identity.IsSeries || row.Work?.MediaType is "tv" or "anime"))
            throw new InvalidOperationException("Could not identify the exact episode to replace.");
        var scope = cursor?.QueueKey ?? (episode.IsSeasonPack && episode.Season is { } season ? $"season:{season}" : "movie");
        if (episode.IsSeasonPack && episode.Season is null) throw new InvalidOperationException("Could not identify the release's season.");
        var tried = (await db.ReleaseAttempts.Where(r => r.UserId == LocalUser.Id && r.WorkKey == workKey && r.Scope == scope)
            .Select(r => r.Hash).ToListAsync(ct)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        tried.UnionWith(await db.EngineTorrents.Where(r => r.UserId == LocalUser.Id).Select(r => r.Hash).ToListAsync(ct));
        var floor = target?.PreferredResolution ?? ReleaseSelection.Resolution(releaseName);
        var mediaType = row.Work?.MediaType ?? (identity.IsSeries ? "tv" : "movie");
        IReadOnlyList<string> aliases = [];
        try { aliases = JsonSerializer.Deserialize<string[]>(row.Work?.AliasesJson ?? "[]") ?? []; }
        catch (JsonException) { }
        var query = cursor?.Query(title) ?? (scope.StartsWith("season:", StringComparison.Ordinal) ? $"{title} S{episode.Season:00}" : title);
        var rungs = cursor is { } targetEpisode ? EpisodeLadder.BuildEpisodeRungs(title, targetEpisode, mediaType, aliases, floor)
            : [new LadderRung("exact", query, EpisodeLadder.SearchCategory(mediaType) ?? "all",
                new() { HasMagnet = true, MinSeeders = 1, Season = episode.Season })];
        // The registry's enabled torrent sources for this category are what the search fan-out would query anyway.
        var searchable = registry?.Active("torrent", rungs[0].Category).Select(e => e.Id).ToList();
        if (source is not null && searchable is not null && !searchable.Contains(source, StringComparer.OrdinalIgnoreCase))
            throw new InvalidOperationException("That source is turned off or can't search this kind of title. Choose another source.");
        IReadOnlyList<TorrentResult> selected = [];
        var sources = new List<SourceStatus>();
        foreach (var rung in rungs)
        {
            var response = await search.SearchAsync(new SearchOptions { Query = rung.Query, Category = rung.Category,
                Limit = EpisodeLadder.SearchLimit, PageSize = EpisodeLadder.SearchLimit, Enrich = false, SkipCache = true,
                TargetResolution = floor, Filters = rung.Filters, Sources = source is null ? null : [source] }, ct);
            sources.AddRange(response.Sources);
            selected = Select(response.Results, workKey, title, cursor, episode.IsSeasonPack ? episode.Season : null, floor, tried, aliases);
            if (selected.Count > 0) break;
        }
        if (selected.Count == 0 && FilmSelection.SourceOutageMessage(sources) is { } outage) throw new InvalidOperationException(outage);
        var alternatives = new List<ReleaseAlternative>();
        var currentSize = row.SizeBytes > 0 ? row.SizeBytes : (long?)null;
        foreach (var ranked in Rank(selected, ReleaseSelection.Resolution(releaseName) ?? floor, currentSize).Take(20))
        {
            var result = ranked.Result;
            var candidateHash = LibraryJson.Hash(result.InfoHash) ?? LibraryJson.Hash(result.Magnet)!;
            var token = Guid.NewGuid().ToString("N");
            cache.Set($"release-swap:{token}", new Choice(hash, new(workKey, scope, candidateHash, result.Title, result.Magnet, result.SizeBytes, result.Source)),
                TimeSpan.FromMinutes(10));
            alternatives.Add(new(token, candidateHash, result.Title, result.Seeders, result.Leechers, result.SizeBytes,
                ReleaseSelection.Resolution(result.Title), result.Source, ranked.Why));
        }
        var found = selected.GroupBy(r => r.Source, StringComparer.OrdinalIgnoreCase)
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
        return new(info.Health ?? new(null, info.Peers, info.Dlspeed, 0, info.State), alternatives, sourceList,
            alternatives.FirstOrDefault()?.Token);
    }

    /// <summary>Searches, then swaps to the recommended release when it has more seeders than the current swarm offers.</summary>
    public async Task<EngineAddResult> SwapBest(string hash, string? source, CancellationToken ct)
    {
        var found = await Alternatives(hash, source, ct);
        var where = string.IsNullOrWhiteSpace(source) || source.Equals("all", StringComparison.OrdinalIgnoreCase) ? "on any source" : $"on {source.Trim()}";
        var best = found.Alternatives.FirstOrDefault();
        if (best is null || best.Seeders <= (found.Health.ConnectedSeeders ?? 0))
            return new(false, $"No better release was found {where}. Your current download was kept.");
        return await Swap(hash, best.Token, ct);
    }

    /// <summary>
    /// One deterministic score, best first: quality match to the current release, seeders (diminishing),
    /// size sanity against the current release, then the search health score. Ties break on seeders, size, hash.
    /// </summary>
    public static IReadOnlyList<RankedRelease> Rank(IReadOnlyList<TorrentResult> candidates, int? currentQuality, long? currentSize)
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
            .OrderByDescending(x => x.Score).ThenByDescending(x => x.Result.Seeders)
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
                why = label is null ? $"The only other release found ({r.Seeders} seeders)" : $"The only other {label} release found ({r.Seeders} seeders)";
            else if (r.Seeders == maxSeeders && topSeeded == 1) why = $"Most seeders ({r.Seeders})";
            else if (quality is { } only && byQuality[only] == 1)
                why = only == currentQuality ? $"Only other {label} release" : $"Only {label} release";
            else if (quality is not null && quality == currentQuality && currentSize is > 0 && ratio is < .9)
                why = $"Same quality, {Math.Round((1 - ratio!.Value) * 100)}% smaller file";
            else if (quality is not null && currentQuality is not null && quality > currentQuality)
                why = $"Higher quality ({label}), {r.Seeders} seeders{Size(r.SizeBytes)}";
            else if (ratio is < .4 or > 2.5) why = $"Unusual size for {label ?? "this release"}, {r.Seeders} seeders";
            else if (i == 0) why = $"Best balance of quality and seeders ({(label is null ? "" : label + ", ")}{r.Seeders} seeders)";
            else if (quality is not null && quality == currentQuality) why = $"Same quality, {r.Seeders} seeders{Size(r.SizeBytes)}";
            else why = (label is null ? $"{r.Seeders} seeders" : $"{r.Seeders} seeders at {label}") + Size(r.SizeBytes);
            return new RankedRelease(r, x.Score, why);
        }).ToList();
    }

    private static string Size(long? bytes) => bytes is not > 0 ? "" : bytes >= 1L << 30
        ? FormattableString.Invariant($", {bytes.Value / (double)(1L << 30):0.#} GB") : $", {Math.Max(1, bytes.Value >> 20)} MB";

    public Task<EngineAddResult> Swap(string hash, string token, CancellationToken ct)
    {
        if (!cache.TryGetValue<Choice>($"release-swap:{token}", out var choice) || choice is null
            || !choice.CurrentHash.Equals(hash, StringComparison.OrdinalIgnoreCase))
            return Task.FromResult(new EngineAddResult(false, "This selection expired. Find releases again."));
        return engine.SwapAsync(choice.CurrentHash, choice.Swap, ct);
    }

    public static IReadOnlyList<TorrentResult> Select(IEnumerable<TorrentResult> ranked, string workKey, string title,
        EpisodeCursor? cursor, int? seasonPack, int? floor, ISet<string> excluded, IReadOnlyList<string>? aliases = null)
    {
        var seen = new HashSet<string>(excluded, StringComparer.OrdinalIgnoreCase);
        var titles = (aliases ?? []).Prepend(title).SelectMany(EpisodeLadder.AliasTitleForms).ToList();
        return ranked.Where(r =>
        {
            var hash = LibraryJson.Hash(r.InfoHash) ?? LibraryJson.Hash(r.Magnet);
            if (hash is null || LibraryJson.Hash(r.Magnet) != hash || !seen.Add(hash) || !ReleaseSelection.MeetsFloor(r.Title, floor)) return false;
            if (cursor is { } ep) return EpisodeLadder.ReleaseMatchesWork(r, titles) && EpisodeLadder.MatchesTargetEpisode(r, ep);
            if (seasonPack is { } season)
            {
                var parsed = r.Episode ?? ReleaseNames.ParseEpisode(r.Title);
                return EpisodeLadder.ReleaseMatchesWork(r, titles) && parsed.IsSeasonPack && parsed.IsMultiSeason != true && parsed.Season == season;
            }
            return FilmSelection.Select([r], workKey, floor) is not null;
        }).ToList();
    }
}
