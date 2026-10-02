using TorrentFlow.Core;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Core.Text;
using TorrentFlow.Data;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>One release the owner can choose. <c>Fits</c> is true when it names this title and the wanted episode (or an episode of the wanted season).</summary>
/// <param name="Language">What its name and site category say about audio and subtitles, in plain words ("French audio").</param>
/// <param name="LanguageFit">preferred | neutral | backup | clash under the owner's audio language setting (docs/release-language.md).</param>
/// <param name="Languages">The same language facts and English verdict the swap dialog shows. A hand pick goes whatever it says.</param>
/// <param name="Blocked">Why automatic picks skip it, when they do. Listed last in its group and never the best match.</param>
public sealed record ReleasePickOption(string Token, string Hash, string Title, int Seeders, int Peers, long? SizeBytes,
    int? Quality, string Source, bool Fits, string Why, string? Language = null, string? LanguageFit = null,
    ReleaseLanguageInfo? Languages = null, ReleaseBlockInfo? Blocked = null);

public sealed record ReleasePickList(string Query, IReadOnlyList<ReleasePickOption> Releases);

/// <summary>
/// "Pick a release yourself": the owner's manual search for one title, episode or season, prefilled with the query the
/// automatic grab used. Results that fit rank first (the same identity and scope atoms as the automatic path); the rest
/// stay visible, as in a manual search. Season packs are never listed, the same rule as the automatic episode path.
/// A pick is sent through <see cref="GrabService.SendPicked"/>, so the title page, requests and the library log all
/// start a hand-picked release the same way.
/// </summary>
public sealed class ReleasePicker(IDbContextFactory<TorrentFlowDbContext> factory, ITorrentSearchService search,
    GrabService grabs, IMemoryCache cache)
{
    private sealed record Choice(string WorkKey, int? Season, int? Episode, string Query, TorrentResult Release);

    public static string DefaultQuery(string title, int? season, int? episode)
    {
        title = Apostrophes.Normalize(title).Trim();
        return season is { } s && episode is { } e ? new EpisodeCursor(s, e).Query(title)
            : season is { } only ? $"{title} S{only:00}"
            : title;
    }

    public async Task<ReleasePickList> Search(string workKey, int? season, int? episode, string? query, CancellationToken ct)
    {
        if (episode != null && season == null) throw new LibraryRequestException(400, "Choose a season for that episode.");
        await using var db = await factory.CreateDbContextAsync(ct);
        var work = await db.Works.AsNoTracking().FirstOrDefaultAsync(w => w.WorkKey == workKey, ct)
            ?? throw new LibraryRequestException(404, "Open this title once, then pick a release.");
        var aliases = work.ReadNames().Others(work.CanonicalTitle);
        var text = string.IsNullOrWhiteSpace(query) ? DefaultQuery(work.CanonicalTitle, season, episode) : Apostrophes.Normalize(query).Trim();
        if (text.Length > 200) text = text[..200];
        var none = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var usable = (await Find(text, work.MediaType, ct)).Where(r => !EpisodeRejections.IsPack(r)).ToList();
        // An episode fits when it names this work and episode; a season-level pick takes any single episode of that season.
        var fits = usable.Where(r => EpisodeOf(r, season, episode) is var target && (season == null || target != null) &&
            ReleaseSwapService.Select([r], workKey, work.CanonicalTitle, target, null, null, none, aliases).Count > 0).ToList();
        var others = usable.Where(r => !fits.Contains(r)).ToList();
        var releases = new List<ReleasePickOption>();
        var settings = await db.ClientSettings.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == LocalUser.Id, ct);
        var want = await grabs.LanguageWantAsync(settings?.AudioLanguage, work.MediaType, work.Provider, work.ProviderId, ct, work.OriginalLanguage);
        static string HashOf(TorrentResult r) => LibraryJson.Hash(r.InfoHash) ?? LibraryJson.Hash(r.Magnet)!;
        var blocks = await ReleaseBlocks.GetAsync(db, LocalUser.Id, usable.Select(HashOf), ct);

        foreach (var (group, fit) in new[] { (fits, true), (others, false) })
        {
            // The English rule orders the list like the automatic picks (Pass, then unknown, then fail; within each, the
            // owner's audio preference) and labels each row; it never hides one. A hand pick always goes.
            var verdicts = group.Distinct().ToDictionary(r => r, r => ReleaseLanguage.Verdict(want, r.Title, r.Category));
            // Blocked releases go last, like the swap dialog: listed for a hand pick, never first.
            foreach (var (ranked, language) in ReleaseSwapService.Rank(group, null, null,
                    r => (blocks.ContainsKey(HashOf(r)) ? 1000 : 0) + ReleaseLanguage.Order(verdicts[r]))
                .Select(x => (x, verdicts[x.Result])))
            {
                if (releases.Count >= 30) break;
                var r = ranked.Result;
                var hash = HashOf(r);
                if (releases.Any(x => x.Hash == hash)) continue;
                var token = Guid.NewGuid().ToString("N");
                cache.Set($"release-pick:{token}", new Choice(workKey, season, episode, text, r), TimeSpan.FromMinutes(15));
                releases.Add(new(token, hash, r.Title, r.Seeders, r.Leechers, r.SizeBytes, ReleaseSelection.Resolution(r.Title),
                    r.Source, fit, fit ? "" : "The name doesn't match this exactly, so check it first", language.Label,
                    language.Fit.ToString().ToLowerInvariant(), ReleaseLanguageInfo.From(language),
                    blocks.TryGetValue(hash, out var block) ? ReleaseBlocks.Info(block) : null));

            }
        }
        return new(text, releases);
    }

    private async Task<List<TorrentResult>> Find(string text, string? mediaType, CancellationToken ct)
    {
        SearchResponse response;
        try
        {
            response = await search.SearchAsync(new SearchOptions { Query = text, Category = EpisodeLadder.SearchCategory(mediaType) ?? "all",
                Limit = EpisodeLadder.SearchLimit, PageSize = EpisodeLadder.SearchLimit, Enrich = false, SkipCache = true,
                Filters = new() { HasMagnet = true } }, ct);
        }
        catch (Exception) when (!ct.IsCancellationRequested)
        {
            throw new LibraryRequestException(503, "The search sites are busy or can't be reached right now. Try again in a minute.");
        }
        return response.Results.Where(r => (LibraryJson.Hash(r.InfoHash) ?? LibraryJson.Hash(r.Magnet)) is not null).ToList();
    }

    /// <summary>The episode a release is for: the wanted one, or for a season-level pick the one its name gives.</summary>
    private static EpisodeCursor? EpisodeOf(TorrentResult r, int? season, int? episode)
    {
        if (season is not { } s) return null;
        if (episode is { } e) return new(s, e);
        var parsed = r.Episode ?? ReleaseEpisodeParser.Parse(r.Title);
        return parsed.Episode is { } n && (parsed.Season ?? s) == s ? new(s, n) : null;
    }

    /// <summary>Sends the chosen release for this title, filed under its episode (or as a film).</summary>
    public async Task<GrabResult> Pick(string workKey, string token, string? lane, CancellationToken ct)
    {
        if (!cache.TryGetValue<Choice>($"release-pick:{token}", out var choice) || choice is null ||
            !choice.WorkKey.Equals(workKey, StringComparison.OrdinalIgnoreCase))
            return new(false, "This list is out of date. Search again, then pick a release.");
        await using var db = await factory.CreateDbContextAsync(ct);
        var work = await db.Works.AsNoTracking().FirstOrDefaultAsync(w => w.WorkKey == workKey, ct);
        if (work == null) return new(false, "Open this title once, then pick a release.");
        var cursor = EpisodeOf(choice.Release, choice.Season, choice.Episode);
        if (choice.Season != null && cursor == null) return new(false, "That release doesn't name an episode. Pick one that does.");
        var input = new GrabInput(work.CanonicalTitle, work.MediaType, cursor, WorkId: work.Id, Year: work.Year, WorkKey: workKey,
            Provider: work.Provider, ProviderId: work.ProviderId, Lane: lane);
        var result = await grabs.SendPicked(input, choice.Release, choice.Query, ct);
        if (result.Ok) cache.Remove($"release-pick:{token}");
        return result;
    }
}
