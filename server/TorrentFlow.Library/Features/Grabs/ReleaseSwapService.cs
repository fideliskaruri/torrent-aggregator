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
public sealed record ReleaseAlternatives(TransferHealth Health, IReadOnlyList<ReleaseAlternative> Alternatives);

/// <summary>Manual selection today; a future recovery policy can consume the same alternatives and swap command.</summary>
public sealed class ReleaseSwapService(IDbContextFactory<TorrentFlowDbContext> factory, ITorrentSearchService search,
    ITorrentEngine engine, IMemoryCache cache)
{
    private sealed record Choice(string CurrentHash, EngineReleaseSwap Swap);

    public async Task<ReleaseAlternatives> Alternatives(string hash, CancellationToken ct)
    {
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
        IReadOnlyList<TorrentResult> selected = [];
        var sources = new List<SourceStatus>();
        foreach (var rung in rungs)
        {
            var response = await search.SearchAsync(new SearchOptions { Query = rung.Query, Category = rung.Category,
                Limit = EpisodeLadder.SearchLimit, PageSize = EpisodeLadder.SearchLimit, Enrich = false, SkipCache = true,
                TargetResolution = floor, Filters = rung.Filters }, ct);
            sources.AddRange(response.Sources);
            selected = Select(response.Results, workKey, title, cursor, episode.IsSeasonPack ? episode.Season : null, floor, tried, aliases);
            if (selected.Count > 0) break;
        }
        if (selected.Count == 0 && FilmSelection.SourceOutageMessage(sources) is { } outage) throw new InvalidOperationException(outage);
        var alternatives = new List<ReleaseAlternative>();
        foreach (var result in selected.Take(20))
        {
            var candidateHash = LibraryJson.Hash(result.InfoHash) ?? LibraryJson.Hash(result.Magnet)!;
            var token = Guid.NewGuid().ToString("N");
            cache.Set($"release-swap:{token}", new Choice(hash, new(workKey, scope, candidateHash, result.Title, result.Magnet, result.SizeBytes, result.Source)),
                TimeSpan.FromMinutes(10));
            alternatives.Add(new(token, candidateHash, result.Title, result.Seeders, result.Leechers, result.SizeBytes,
                ReleaseSelection.Resolution(result.Title), result.Source, result.Seeders > (info.Seeders ?? info.Peers ?? 0)
                    ? "More advertised seeders than current connected peers" : "Another ranked release for the same scope"));
        }
        return new(info.Health ?? new(null, info.Peers, info.Dlspeed, 0, info.State), alternatives);
    }

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
