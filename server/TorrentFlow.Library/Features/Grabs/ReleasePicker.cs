using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>One release the owner can choose. <c>Fits</c> is true when it names this title and the wanted episode or season.</summary>
public sealed record ReleasePickOption(string Token, string Hash, string Title, int Seeders, int Peers, long? SizeBytes,
    int? Quality, string Source, bool Fits, string Why);
public sealed record ReleasePickList(string Query, IReadOnlyList<ReleasePickOption> Releases);

/// <summary>
/// "Pick a release yourself": the owner's manual search for one title, episode or season, prefilled with the query the
/// automatic grab used. Results that fit rank first (the same identity and scope atoms as the automatic path); the rest
/// stay visible, as in a manual search. A pick is sent through <see cref="GrabService.SendPicked"/>, so the title page,
/// requests and the library log all start a hand-picked release the same way.
/// </summary>
public sealed class ReleasePicker(IDbContextFactory<TorrentFlowDbContext> factory, ITorrentSearchService search,
    GrabService grabs, IMemoryCache cache)
{
    private sealed record Choice(string WorkKey, int? Season, int? Episode, string Query, TorrentResult Release);

    public static string DefaultQuery(string title, int? season, int? episode, string? mediaType) =>
        season is { } s && episode is { } e ? new EpisodeCursor(s, e).Query(title)
        : season is { } packSeason ? EpisodeLadder.SeasonPackRung(title, packSeason, mediaType).Query
        : title.Trim();

    public async Task<ReleasePickList> Search(string workKey, int? season, int? episode, string? query, CancellationToken ct)
    {
        if (episode != null && season == null) throw new LibraryRequestException(400, "Choose a season for that episode.");
        await using var db = await factory.CreateDbContextAsync(ct);
        var work = await db.Works.AsNoTracking().FirstOrDefaultAsync(w => w.WorkKey == workKey, ct)
            ?? throw new LibraryRequestException(404, "Open this title once, then pick a release.");
        IReadOnlyList<string> aliases = [];
        try { aliases = JsonSerializer.Deserialize<string[]>(work.AliasesJson ?? "[]") ?? []; }
        catch (JsonException) { }
        var text = string.IsNullOrWhiteSpace(query) ? DefaultQuery(work.CanonicalTitle, season, episode, work.MediaType) : query.Trim();
        if (text.Length > 200) text = text[..200];
        var cursor = season is { } s && episode is { } e ? new EpisodeCursor(s, e) : (EpisodeCursor?)null;
        var none = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var usable = await Find(text, work.MediaType, ct);
        // A season wants its pack; an episode fits on its own or inside its season's pack; a film is matched as a film.
        List<TorrentResult> Fitting()
        {
            var fits = new List<TorrentResult>();
            if (cursor != null || season == null)
                fits.AddRange(ReleaseSwapService.Select(usable, workKey, work.CanonicalTitle, cursor, null, null, none, aliases));
            if (season is { } wantedSeason)
                fits.AddRange(ReleaseSwapService.Select(usable, workKey, work.CanonicalTitle, null, wantedSeason, null,
                    new HashSet<string>(StringComparer.OrdinalIgnoreCase), aliases).Where(r => !fits.Contains(r)));
            return fits;
        }
        var fits = Fitting();
        // Our own episode search found nothing that fits: the episode may only exist inside a season pack, so look
        // for the pack too, the same next rung the automatic grab takes.
        if (fits.Count == 0 && cursor is { } c && text.Equals(DefaultQuery(work.CanonicalTitle, c.Season, c.Episode, work.MediaType),
                StringComparison.OrdinalIgnoreCase))
        {
            var packs = await Find(DefaultQuery(work.CanonicalTitle, c.Season, null, work.MediaType), work.MediaType, ct);
            usable = [.. usable, .. packs.Where(p => !usable.Contains(p))];
            fits = Fitting();
        }
        var others = usable.Where(r => !fits.Contains(r)).ToList();
        var releases = new List<ReleasePickOption>();
        foreach (var (group, fit) in new[] { (fits, true), (others, false) })
        {
            foreach (var ranked in ReleaseSwapService.Rank(group, null, null))
            {
                if (releases.Count >= 30) break;
                var r = ranked.Result;
                var hash = LibraryJson.Hash(r.InfoHash) ?? LibraryJson.Hash(r.Magnet)!;
                if (releases.Any(x => x.Hash == hash)) continue;
                var token = Guid.NewGuid().ToString("N");
                cache.Set($"release-pick:{token}", new Choice(workKey, season, episode, text, r), TimeSpan.FromMinutes(15));
                releases.Add(new(token, hash, r.Title, r.Seeders, r.Leechers, r.SizeBytes, ReleaseSelection.Resolution(r.Title),
                    r.Source, fit, Describe(r, fit, season)));
            }
        }
        return new(text, releases);
    }

    private async Task<List<TorrentResult>> Find(string text, string? mediaType, CancellationToken ct)
    {
        var response = await search.SearchAsync(new SearchOptions { Query = text, Category = EpisodeLadder.SearchCategory(mediaType) ?? "all",
            Limit = EpisodeLadder.SearchLimit, PageSize = EpisodeLadder.SearchLimit, Enrich = false, SkipCache = true,
            Filters = new() { HasMagnet = true } }, ct);
        return response.Results.Where(r => (LibraryJson.Hash(r.InfoHash) ?? LibraryJson.Hash(r.Magnet)) is not null).ToList();
    }

    /// <summary>Sends the chosen release for this title. A season pack is filed under the season; anything else under its episode.</summary>
    public async Task<GrabResult> Pick(string workKey, string token, string? lane, CancellationToken ct)
    {
        if (!cache.TryGetValue<Choice>($"release-pick:{token}", out var choice) || choice is null ||
            !choice.WorkKey.Equals(workKey, StringComparison.OrdinalIgnoreCase))
            return new(false, "This list is out of date. Search again, then pick a release.");
        await using var db = await factory.CreateDbContextAsync(ct);
        var work = await db.Works.AsNoTracking().FirstOrDefaultAsync(w => w.WorkKey == workKey, ct);
        if (work == null) return new(false, "Open this title once, then pick a release.");
        var pack = choice.Season is { } season && EpisodeLadder.IsSeasonPackFor(choice.Release.Title, season);
        EpisodeCursor? cursor = choice.Season is { } s ? new EpisodeCursor(s, pack ? 1 : choice.Episode ?? 1) : null;
        if (cursor != null && !pack && choice.Episode == null)
            cursor = ReleaseNames.ParseEpisode(choice.Release.Title) is { Episode: { } parsed } ? new EpisodeCursor(cursor.Value.Season, parsed) : cursor;
        var input = new GrabInput(work.CanonicalTitle, work.MediaType, cursor, WorkId: work.Id, Year: work.Year, WorkKey: workKey,
            Provider: work.Provider, ProviderId: work.ProviderId, Lane: lane, SeasonPack: pack);
        var result = await grabs.SendPicked(input, choice.Release, choice.Query, ct);
        if (result.Ok) cache.Remove($"release-pick:{token}");
        return result;
    }

    private static string Describe(TorrentResult r, bool fit, int? season)
    {
        var parts = new List<string>();
        if (season is { } s && EpisodeLadder.IsSeasonPackFor(r.Title, s)) parts.Add($"Whole season {s}");
        if (ReleaseSelection.Resolution(r.Title) is { } q) parts.Add($"{q}p");
        parts.Add(r.Seeders == 1 ? "1 seeder" : $"{r.Seeders} seeders");
        if (r.SizeBytes is > 0 and var size)
            parts.Add(size >= 1L << 30 ? FormattableString.Invariant($"{size / (double)(1L << 30):0.#} GB") : $"{Math.Max(1, size >> 20)} MB");
        if (!fit) parts.Add("name doesn't match this exactly, check it first");
        return string.Join(", ", parts);
    }
}
