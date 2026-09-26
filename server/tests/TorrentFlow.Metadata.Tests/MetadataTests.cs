using System.Net;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Metadata.Artwork;
using TorrentFlow.Metadata.Browse;
using TorrentFlow.Metadata.Caching;
using TorrentFlow.Metadata.Catalog;
using TorrentFlow.Metadata.Providers;
using TorrentFlow.Metadata.Recommend;
using TorrentFlow.Metadata.Search;
using TorrentFlow.Metadata.Text;
using TorrentFlow.Metadata.Title;
using Microsoft.Extensions.Logging.Abstractions;

namespace TorrentFlow.Metadata.Tests;

public class SlopAndMediaTypeTests
{
    [Theory]
    [InlineData("Untitled Marvel Project", true)]
    [InlineData("Untitled Star Wars Film", true)]
    [InlineData("untitled", true)]
    [InlineData("Unknown title", true)]
    [InlineData("TBA", true)]
    [InlineData("TBD", true)]
    [InlineData("N/A", true)]
    [InlineData("Coming Soon", true)]
    [InlineData("null", true)]
    [InlineData("undefined", true)]
    [InlineData("Episode 5", true)]
    [InlineData("Episode #12", true)]
    [InlineData("Season 3", true)]
    [InlineData("Movie 4", true)]
    [InlineData("S01E05", true)]
    [InlineData("1x05", true)]
    [InlineData("", true)]
    [InlineData("   ", true)]
    [InlineData("88", false)]
    [InlineData("---", true)]
    [InlineData("x", true)]
    [InlineData("Unknown", false)]
    [InlineData("Us", false)]
    [InlineData("It", false)]
    [InlineData("1917", false)]
    [InlineData("300", false)]
    [InlineData("Se7en", false)]
    [InlineData("Toy Story 5", false)]
    [InlineData("Avengers: Doomsday", false)]
    [InlineData("The Untitled", false)]
    [InlineData("Everything Everywhere All at Once", false)]
    public void IsSlopTitle_matches_ts_table(string title, bool slop) => Assert.Equal(slop, CatalogText.IsSlopTitle(title));

    [Theory]
    [InlineData("Movie", "movie")]
    [InlineData(" movies ", "movie")]
    [InlineData("film", "movie")]
    [InlineData("series", "tv")]
    [InlineData("show", "tv")]
    [InlineData("TVShow", "tv")]
    [InlineData("anime", "anime")]
    [InlineData("music", null)]
    [InlineData("", null)]
    public void NormalizeMediaType(string raw, string? expected) => Assert.Equal(expected, MediaTypes.Normalize(raw));
}

public class RecommendationTests
{
    private static RecommendationService Service(FakeHandler handler, string? key = null) =>
        new(new FakeHttpFactory(handler), new TmdbClient(new FakeHttpFactory(handler), Fixtures.Options(key), new ManualTime()), null!, new ManualTime(),
            NullLogger<RecommendationService>.Instance);

    [Fact]
    public void Library_keys_normalize_stored_media_aliases()
    {
        Assert.Equal("tv:1396", RecommendationService.LibraryKey("series", "1396"));
        Assert.Equal("movie:438631", RecommendationService.LibraryKey("Movie", "438631"));
    }

    [Fact]
    public async Task AniList_recommendations_preserve_provider_identity_and_route_shape()
    {
        var handler = FakeHandler.Always(Fixtures.Read("anilist-recommendations.json"));
        var rail = await Service(handler).RecommendationsForProviderAsync("anilist", "That Time I Got Reincarnated as a Slime", "anime", "101280", new HashSet<string>());
        Assert.NotNull(rail);
        Assert.Single(rail.Items);
        Assert.Equal(new Recommendation("anilist", "anime", "anime", "movie", "139498",
            "That Time I Got Reincarnated as a Slime the Movie: Scarlet Bond", "https://img.test/slime-movie.jpg", 2022, 7.6, "MOVIE", false), rail.Items[0]);
        Assert.Contains("operation=recommendations", handler.Requests[0].RequestUri!.ToString());
        Assert.Contains("\"id\":101280", handler.Bodies[0]);
    }

    [Fact]
    public async Task TMDB_recommendations_use_recommendations_endpoint_and_preserve_id()
    {
        var handler = FakeHandler.Always(Fixtures.Read("tmdb-recommendations.json"));
        var rail = await Service(handler, $"  \"{Fixtures.TmdbKey}\"  ").RecommendationsForProviderAsync("tmdb", "Seed", "series", "123", new HashSet<string>());
        var uri = handler.Requests[0].RequestUri!;
        Assert.Contains("/tv/123/recommendations", uri.AbsolutePath);
        Assert.Contains($"api_key={Fixtures.TmdbKey}", uri.Query);
        Assert.NotNull(rail);
        Assert.Equal("82684", rail.Items[0].ExternalId);
        Assert.Equal("tmdb", rail.Items[0].Provider);
        Assert.Equal("tv", rail.Items[0].TitleMediaType);
        Assert.Equal(8.5, rail.Items[0].Rating);
        Assert.Null(rail.Items[1].Rating); // vote_count < 20
        Assert.Equal(2, rail.Items.Count); // poster-less card dropped
    }

    [Fact]
    public async Task TMDB_http_failures_are_not_cached_but_successes_are()
    {
        var requests = 0;
        var handler = new FakeHandler(_ => Task.FromResult(++requests == 1
            ? FakeHandler.Json("unauthorized", HttpStatusCode.Unauthorized)
            : FakeHandler.Json(Fixtures.Read("tmdb-recommendations.json"))));
        var service = Service(handler, Fixtures.TmdbKey);
        Assert.Null(await service.RecommendationsForProviderAsync("tmdb", "Seed", "tv", "456", new HashSet<string>()));
        Assert.NotNull(await service.RecommendationsForProviderAsync("tmdb", "Seed", "tv", "456", new HashSet<string>()));
        Assert.NotNull(await service.RecommendationsForProviderAsync("tmdb", "Seed", "tv", "456", new HashSet<string>()));
        Assert.Equal(2, requests);
    }

    [Fact]
    public async Task Placeholder_ids_and_exclusions()
    {
        var handler = FakeHandler.Always(Fixtures.Read("tmdb-recommendations.json"));
        var service = Service(handler, Fixtures.TmdbKey);
        Assert.Null(await service.RecommendationsForAsync("Demo", "tv", "demo-1", new HashSet<string>()));
        Assert.Empty(handler.Requests);
        var rail = await service.RecommendationsForAsync("Seed", "tv", "1", new HashSet<string> { "tv:82684" });
        Assert.DoesNotContain(rail!.Items, i => i.ExternalId == "82684");
    }

    [Fact]
    public async Task No_TMDB_key_means_no_request()
    {
        var handler = FakeHandler.Always("{}");
        Assert.Null(await Service(handler).RecommendationsForAsync("Seed", "movie", "1", new HashSet<string>()));
        Assert.Empty(handler.Requests);
    }
}

public class TmdbAndAniListTests
{
    [Theory]
    [InlineData(Fixtures.TmdbKey, true)]
    [InlineData("  \"1234567890abcdef1234567890abcdef\" ", true)]
    [InlineData("your_tmdb_api_key", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Usable_key_detection(string? key, bool usable) => Assert.Equal(usable, TmdbClient.IsUsableKey(key));

    [Fact]
    public void V3_key_goes_in_query_v4_token_in_bearer_header()
    {
        using var v3 = TmdbClient.BuildRequest(Fixtures.TmdbKey, "https://api.themoviedb.org/3/search/movie", [("query", "dune")]);
        Assert.Contains($"api_key={Fixtures.TmdbKey}", v3.RequestUri!.Query);
        Assert.Null(v3.Headers.Authorization);
        var v4Token = "eyJhbGciOiJIUzI1NiJ9." + new string('a', 60) + ".sig";
        using var v4 = TmdbClient.BuildRequest(v4Token, "https://api.themoviedb.org/3/search/movie", [("query", "dune")]);
        Assert.DoesNotContain("api_key", v4.RequestUri!.Query);
        Assert.Equal("Bearer", v4.Headers.Authorization?.Scheme);
    }

    [Fact]
    public void Image_urls()
    {
        Assert.Null(TmdbClient.PosterUrl(null));
        Assert.Null(TmdbClient.BackdropUrl(null));
        Assert.Equal("https://image.tmdb.org/t/p/w500/x.jpg", TmdbClient.PosterUrl("/x.jpg"));
    }

    [Fact]
    public async Task Search_without_key_makes_no_request()
    {
        var handler = FakeHandler.Always("{}");
        var tmdb = new TmdbClient(new FakeHttpFactory(handler), Fixtures.Options(), new ManualTime());
        Assert.Empty(await tmdb.SearchCandidatesAsync("movie", "Dune", 2021));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Candidate_search_sends_year_param_per_scope()
    {
        var handler = FakeHandler.Always("""{"results":[{"id":438631,"title":"Dune","release_date":"2021-09-15","popularity":34.12,"poster_path":"/d.jpg"}]}""");
        var tmdb = new TmdbClient(new FakeHttpFactory(handler), Fixtures.Options(Fixtures.TmdbKey), new ManualTime());
        var movies = await tmdb.SearchCandidatesAsync("movie", "Dune", 2021);
        Assert.Contains("/search/movie", handler.Requests[0].RequestUri!.AbsolutePath);
        Assert.Contains("year=2021", handler.Requests[0].RequestUri!.Query);
        Assert.Equal(2021, movies[0].Year);
        Assert.Equal(34.12, movies[0].Popularity);
        await tmdb.SearchCandidatesAsync("tv", "Severance", 2022);
        Assert.Contains("first_air_date_year=2022", handler.Requests[1].RequestUri!.Query);
        Assert.DoesNotContain("&year=", handler.Requests[1].RequestUri!.Query);
    }

    [Fact]
    public async Task AniList_work_by_id_keeps_episode_count_and_aliases()
    {
        var handler = FakeHandler.Always(Fixtures.Read("anilist-killing-slimes.json"));
        var anilist = new AniListClient(new FakeHttpFactory(handler), new ManualTime());
        var work = await anilist.GetWorkByIdAsync("112608");
        Assert.NotNull(work);
        Assert.Equal("112608", work.Metadata.ExternalId);
        Assert.Equal("anilist", work.Metadata.Source);
        Assert.Equal("anime", work.Metadata.MediaType);
        Assert.True(work.IsSeries);
        Assert.Equal("TV", work.Format);
        Assert.Equal(12, work.EpisodeCount);
        Assert.Equal(2021, work.Metadata.Year);
        Assert.Equal(7.1, work.Metadata.Rating);
        Assert.Equal(new[]
        {
            "I've Been Killing Slimes for 300 Years and Maxed Out My Level",
            "Slime Taoshite 300-nen, Shiranai Uchi ni Level Max ni Nattemashita",
            "スライム倒して300年、知らないうちにレベルMAXになってました",
        }, work.Metadata.Aliases);
    }

    [Fact]
    public async Task AniList_identical_searches_coalesce_and_memoize()
    {
        var gate = new TaskCompletionSource();
        var calls = 0;
        var handler = new FakeHandler(async _ =>
        {
            Interlocked.Increment(ref calls);
            await gate.Task;
            return FakeHandler.Json("""{"data":{"Page":{"media":[]}}}""");
        });
        var time = new ManualTime();
        var anilist = new AniListClient(new FakeHttpFactory(handler), time);
        var a = anilist.SearchAsync("dune");
        var b = anilist.SearchAsync("dune");
        gate.SetResult();
        await Task.WhenAll(a, b);
        Assert.Equal(1, calls);
        await anilist.SearchAsync("dune");
        Assert.Equal(1, calls);
        time.Advance(TimeSpan.FromSeconds(61));
        await anilist.SearchAsync("dune");
        Assert.Equal(2, calls);
    }
}

public class CacheTests
{
    [Fact]
    public void Bounded_ttl_cache_expires_and_evicts_oldest()
    {
        var time = new ManualTime();
        var cache = new BoundedTtlCache<int>(2, time);
        cache.Set("a", 1, TimeSpan.FromMinutes(1));
        cache.Set("b", 2, TimeSpan.FromMinutes(1));
        cache.Set("c", 3, TimeSpan.FromMinutes(1));
        Assert.False(cache.TryGet("a", out _));
        Assert.True(cache.TryGet("c", out var c) && c == 3);
        time.Advance(TimeSpan.FromMinutes(2));
        Assert.False(cache.TryGet("c", out _));
        Assert.True(cache.Count <= 2);
    }

    [Fact]
    public async Task Single_flight_shares_one_run_per_key()
    {
        var flight = new SingleFlight<int>();
        var gate = new TaskCompletionSource<int>();
        var runs = 0;
        var a = flight.RunAsync("k", () => { runs++; return gate.Task; });
        var b = flight.RunAsync("k", () => { runs++; return gate.Task; });
        gate.SetResult(7);
        var both = await Task.WhenAll(a, b);
        Assert.Equal(new[] { 7, 7 }, both);
        Assert.Equal(1, runs);
        Assert.Equal(0, flight.InFlightCount);
    }
}

public class TextTests
{
    [Theory]
    [InlineData("  Breaking   Bad ", "breaking bad")]
    [InlineData("ＤＵＮＥ", "dune")]
    public void Canonicalize(string raw, string expected) => Assert.Equal(expected, QueryVariants.Canonicalize(raw));

    [Fact]
    public void Work_keys_and_title_paths()
    {
        Assert.Equal("breaking-bad", WorkKeys.WorkKeyFor("Breaking Bad", null));
        Assert.Equal("dune-2021", WorkKeys.WorkKeyFor("Dune", 2021));
        Assert.Equal("amelie-2001", WorkKeys.WorkKeyFor("Amélie", 2001));
        Assert.Equal("/title/breaking-bad?t=Breaking+Bad&y=2008&type=tv",
            WorkKeys.TitlePath("breaking-bad", new WorkKeys.TitleLink("Breaking Bad", 2008, "tv")));
    }

    [Fact]
    public void Relevance_prefers_exact_titles()
    {
        Assert.True(Relevance.QueryRelevanceTier("breaking bad", "Breaking Bad") < Relevance.QueryRelevanceTier("breaking bad", "The Bad News Bears In Breaking Training"));
        Assert.True(Relevance.HasRelevantTitle("dune", ["Dune"]));
        Assert.False(Relevance.HasRelevantTitle("dune", ["Completely Unrelated"]));
    }

    [Fact]
    public void Damerau_levenshtein_is_bounded()
    {
        Assert.Equal(1, Relevance.BoundedDamerauLevenshtein("dnue", "dune", 2));
        Assert.Null(Relevance.BoundedDamerauLevenshtein("abcdef", "uvwxyz", 2));
    }
}

public class ArtworkTests
{
    [Fact]
    public void Match_tiers()
    {
        Assert.Equal(ArtworkMatching.TierExact, ArtworkMatching.MatchTier("Dune", "Dune"));
        Assert.True(ArtworkMatching.MatchTier("Office", "The Office") >= ArtworkMatching.MinAccept);
        Assert.True(ArtworkMatching.MatchTier("Dune", "Children of Dune") < ArtworkMatching.TierExact);
    }

    [Fact]
    public void Choose_best_prefers_year_and_art()
    {
        var q = ArtworkMatching.Normalize(new ArtworkQuery("Dune", 2021, "movie"))!;
        var best = ArtworkMatching.ChooseBest(q,
        [
            new ArtCandidate("Dune", 1984, "/old.jpg", null, "movie", 50, "tmdb"),
            new ArtCandidate("Dune", 2021, "/new.jpg", null, "movie", 10, "tmdb"),
            new ArtCandidate("Dune", 2021, null, null, "movie", 99, "tmdb"),
        ]);
        Assert.Equal("/new.jpg", best?.PosterUrl);
    }

    [Fact]
    public async Task Resolver_without_key_falls_back_keyless_and_never_throws()
    {
        var handler = new FakeHandler(_ => Task.FromResult(FakeHandler.Json("boom", HttpStatusCode.InternalServerError)));
        var f = new FakeHttpFactory(handler);
        var time = new ManualTime();
        var resolver = new ArtworkResolver(new TmdbClient(f, Fixtures.Options(), time), new AniListClient(f, time), new KeylessClients(f), Fixtures.Options(), time);
        var result = await resolver.ResolveAsync(new ArtworkQuery("Dune", 2021, "movie"));
        Assert.Null(result.PosterUrl);
    }
}

public class WorkSearchTests
{
    private static WorkSearchHit Hit(string title, string provider = "tmdb") =>
        WorkSearchService.HitFromKeyless(1, title, 2020, null, "movies", provider)!;

    [Fact]
    public async Task Fanout_reports_failed_providers_and_keeps_partial_results()
    {
        var providers = new Dictionary<string, WorkSearchProvider>
        {
            ["movies"] = (_, _, _) => Task.FromResult(new List<WorkSearchHit> { Hit("Dune") }),
            ["series"] = (_, _, _) => Task.FromException<List<WorkSearchHit>>(new HttpRequestException("down")),
            ["anime"] = (_, _, _) => Task.FromResult(new List<WorkSearchHit>()),
        };
        var service = new WorkSearchService(providers, new ManualTime());
        var outcome = await service.SearchAsync("all", "dune", 10);
        Assert.Single(outcome.Results);
        Assert.Equal("Dune", outcome.Results[0].Title);
    }

    [Fact]
    public async Task All_providers_failing_throws()
    {
        var providers = WorkSearchService.Categories.ToDictionary(c => c,
            c => (WorkSearchProvider)((_, _, _) => Task.FromException<List<WorkSearchHit>>(new HttpRequestException("down"))));
        var service = new WorkSearchService(providers, new ManualTime());
        await Assert.ThrowsAsync<AllProvidersFailedException>(() => service.SearchAsync("all", "dune", 10));
    }

    [Fact]
    public void Scope_parsing() 
    {
        Assert.Equal("movies", WorkSearchService.ParseScope("movies"));
        Assert.Equal("all", WorkSearchService.ParseScope("bogus"));
    }

    [Fact]
    public async Task Suggest_caps_per_provider_and_total()
    {
        static Task<List<Suggestion>> Many(string source) => Task.FromResult(Enumerable.Range(0, 10)
            .Select(i => new Suggestion { Title = $"Dune {i} {source}", MediaType = "movie", Source = source, ExternalId = $"{source}{i}" }).ToList());
        var suggest = new SuggestService(new Dictionary<string, SuggestProvider>
        {
            ["anilist"] = (_, n, _) => Many("anilist").ContinueWith(t => t.Result.Take(n).ToList()),
            ["tmdb"] = (_, n, _) => Many("tmdb").ContinueWith(t => t.Result.Take(n).ToList()),
        });
        var outcome = await suggest.CollectAsync("dune");
        Assert.True(outcome.Suggestions.Count <= 8);
        Assert.False(outcome.Partial);
    }
}

public class CatalogTests
{
    [Fact]
    public void Parse_tmdb_list_drops_people_duplicates_and_untitled_rows()
    {
        var rows = CatalogText.ParseTmdbList(Fixtures.Json("tmdb-trending.json"), "movie");
        Assert.Equal(2, rows.Count);
        var dune = rows[0];
        Assert.Equal(693134, dune.TmdbId);
        Assert.Equal("Dune: Part Two", dune.Title);
        Assert.Equal(2024, dune.Year);
        Assert.Equal("https://image.tmdb.org/t/p/w500/p.jpg", dune.PosterUrl);
        Assert.Equal("https://image.tmdb.org/t/p/w1280/b.jpg", dune.BackdropUrl);
        Assert.Equal(8.2, dune.Rating);
        Assert.Equal("2024-02-27", dune.ReleaseDate);
        Assert.Equal("movie", rows[1].MediaType); // unlabelled row takes the requested kind
        Assert.Null(rows[1].Rating);
        Assert.Null(rows[1].PosterUrl);
    }

    [Theory]
    [InlineData("2026", "2026-01-01")]
    [InlineData("2024-03-01", "2024-03-01")]
    [InlineData("2024-02-30", null)]
    [InlineData("soon", null)]
    public void Release_dates(string raw, string? expected) => Assert.Equal(expected, CatalogText.ParseReleaseDate(raw));

    [Fact]
    public void Parse_feed_body_skips_placeholders_and_coerces_numbers()
    {
        var releases = CatalogText.ParseFeedBody(Fixtures.Json("apibay-top100.json"));
        Assert.Equal(2, releases.Count);
        Assert.Equal(5000, releases[0].Seeders);
        Assert.Equal("abcdef", releases[0].InfoHash);
        Assert.Equal(2_000_000_000, releases[0].SizeBytes);
        Assert.Null(releases[1].InfoHash);
        Assert.Null(releases[1].SizeBytes);
    }

    [Fact]
    public void Catalog_work_keys_series_carry_no_year()
    {
        Assert.Equal("series:breaking bad", CatalogText.CatalogWorkKey("Breaking Bad", 2008, "tv"));
        Assert.Equal("film:dune part two:2024", CatalogText.CatalogWorkKey("Dune: Part Two", 2024, "movie"));
        Assert.Equal("", CatalogText.CatalogWorkKey("  ", 2024, "movie"));
    }

    [Fact]
    public void Catalog_entry_id_is_sha1_of_partition_and_key()
    {
        var id = CatalogText.CatalogEntryId("trending", null, "film:dune:2021");
        Assert.Equal(40, id.Length);
        Assert.NotEqual(id, CatalogText.CatalogEntryId("related", "Dune", "film:dune:2021"));
    }

    [Fact]
    public void Collapse_merges_releases_of_one_work()
    {
        var releases = CatalogText.ParseFeedBody(Fixtures.Json("apibay-top100.json"));
        var works = CatalogText.CollapseToWorks(releases.Select(r => (r, "movie")));
        Assert.Single(works);
        Assert.Equal(9000, works[0].PeakSeeders);
        Assert.Equal("Dune Part Two", works[0].Title);
        Assert.Equal(2024, works[0].Year);
    }

    [Fact]
    public async Task Replace_source_upserts_ranks_and_lookup_finds_work()
    {
        using var db = new TestDb();
        var f = new FakeHttpFactory(FakeHandler.Always("[]"));
        var time = new ManualTime();
        var catalog = new CatalogService(db, new TmdbClient(f, Fixtures.Options(), time), f, Fixtures.Options(), time, NullLogger<CatalogService>.Instance);
        var titles = CatalogText.ParseTmdbList(Fixtures.Json("tmdb-trending.json"), "movie");
        var drafts = titles.Select(t => CatalogText.DraftFromTmdb(t, CatalogText.CatalogWorkKey(t.Title, t.Year, t.MediaType))).ToList();
        Assert.Equal(2, await catalog.ReplaceSourceAsync("trending", null, drafts, default));
        Assert.Equal(1, await catalog.ReplaceSourceAsync("trending", null, drafts.Take(1).ToList(), default));
        var rows = await catalog.ReadRowsAsync("trending", null, 24);
        Assert.Single(rows);
        ICatalogLookup lookup = catalog;
        var work = await lookup.FindByWorkKeyAsync("film:dune part two:2024");
        Assert.Equal("Dune: Part Two", work?.Title);
        Assert.Equal("2024-02-27", work?.ReleaseDate);
        var item = BrowseService.ToRailItem(rows[0]);
        Assert.Equal($"catalog-{rows[0].Id}", item.Id);
        Assert.Equal("2024", item.Subtitle);
        Assert.Null(item.Availability);
    }

    [Fact]
    public async Task Refresh_offline_leaves_catalog_untouched()
    {
        using var db = new TestDb();
        var f = new FakeHttpFactory(new FakeHandler(_ => Task.FromResult(FakeHandler.Json("x", HttpStatusCode.ServiceUnavailable))));
        var time = new ManualTime();
        var catalog = new CatalogService(db, new TmdbClient(f, Fixtures.Options(), time), f, Fixtures.Options(), time, NullLogger<CatalogService>.Instance);
        var result = await catalog.RefreshAsync();
        Assert.True(result.Offline);
        Assert.Contains(result.Errors, e => e.Contains("apibay HTTP 503"));
        Assert.DoesNotContain(result.Errors, e => e.Contains("TMDB_API_KEY is not set"));
    }

    [Fact]
    public async Task Refresh_falls_back_to_charts_without_tmdb()
    {
        using var db = new TestDb();
        var f = new FakeHttpFactory(FakeHandler.Always(Fixtures.Read("apibay-top100.json")));
        var time = new ManualTime();
        var catalog = new CatalogService(db, new TmdbClient(f, Fixtures.Options(), time), f, Fixtures.Options(), time, NullLogger<CatalogService>.Instance);
        var result = await catalog.RefreshAsync();
        Assert.False(result.Offline);
        Assert.Equal("charts", result.Origin["trending"]);
        Assert.Single(await catalog.ReadRowsAsync("trending", null, 24));
    }
}

public class BrowseTests
{
    private static RailItem Item(string title, string? mediaType) => new() { Id = title, Title = title, MediaType = mediaType };

    [Theory]
    [InlineData("tv", "series")]
    [InlineData("anime", "series")]
    [InlineData("Movie", "movie")]
    [InlineData("film", "movie")]
    [InlineData(null, "unknown")]
    [InlineData("music", "unknown")]
    public void Media_groups(string? mediaType, string group) => Assert.Equal(group, BrowseService.MediaGroupOf(mediaType));

    [Fact]
    public void Split_only_genuine_mixes()
    {
        var mixed = new Rail("ready-to-play", "Ready to Play", [Item("A", "movie"), Item("B", "tv"), Item("C", null)]);
        var split = BrowseService.SplitRailByMediaType(mixed);
        Assert.Equal(["ready-to-play-movies", "ready-to-play-series", "ready-to-play"], split.Select(r => r.Id));
        Assert.Equal("Ready to Play · Movies", split[0].Title);
        var homogeneous = new Rail("ready-to-play", "Ready to Play", [Item("A", "movie"), Item("C", null)]);
        Assert.Single(BrowseService.SplitRailByMediaType(homogeneous));
    }

    [Fact]
    public void Dedupe_keeps_work_in_highest_priority_rail()
    {
        var rails = new List<Rail>
        {
            new("ready-to-play", "Ready", [Item("Dune", "movie"), Item("Alien", "movie")]),
            new("continue-watching", "Continue", [Item("Dune", "movie")]),
            new("my-library", "Library", [Item("Dune", "movie")]),
        };
        var deduped = BrowseService.DedupeAcrossRails(rails, ["continue-watching", "ready-to-play"]);
        Assert.Equal(["ready-to-play", "continue-watching", "my-library"], deduped.Select(r => r.Id));
        Assert.Equal(["Alien"], deduped[0].Cards.Select(i => i.Title));
        Assert.Single(deduped[2].Items);
    }

    [Theory]
    [InlineData(2, 7, "S02E07")]
    [InlineData(3, null, "Season 3")]
    [InlineData(null, 4, "Episode 4")]
    [InlineData(null, null, null)]
    public void Episode_subtitles(int? s, int? e, string? expected) => Assert.Equal(expected, BrowseService.FormatEpisodeSubtitle(s, e));

    [Fact]
    public async Task Browse_payload_has_library_and_discovery_rails()
    {
        using var db = new TestDb();
        await using (var ctx = db.CreateDbContext())
        {
            ctx.Users.Add(new TorrentFlow.Data.Entities.User { Id = TorrentFlow.Data.LocalUser.Id });
            ctx.WatchListItems.Add(new TorrentFlow.Data.Entities.WatchListItem
            {
                Id = "w1", UserId = TorrentFlow.Data.LocalUser.Id, MediaType = "tv", ExternalId = "1396", Title = "Breaking Bad", Status = "watching",
                MonitorMode = "all", Monitored = true, CursorSeason = 1, CursorEpisode = 2, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow, LastChecked = DateTime.UtcNow,
            });
            await ctx.SaveChangesAsync();
        }
        var f = new FakeHttpFactory(FakeHandler.Always(Fixtures.Read("apibay-top100.json")));
        var time = new ManualTime();
        var catalog = new CatalogService(db, new TmdbClient(f, Fixtures.Options(), time), f, Fixtures.Options(), time, NullLogger<CatalogService>.Instance);
        var browse = BrowseFixture.Create(db, f, time, catalog);
        var payload = await browse.BuildAsync(TorrentFlow.Data.LocalUser.Id);
        Assert.Equal(["next-up", "my-library", "because-you-are-watching", "trending-now", "popular-series"], payload.Rails.Select(r => r.Id));
        Assert.Equal("Because you're watching Breaking Bad", payload.Rails[2].Title);
        Assert.Equal("S01E02", payload.Rails[0].Cards.First().Subtitle);
        Assert.Equal("next-w1", payload.Rails[0].Cards.First().Id);
        Assert.Equal("watching", payload.Rails[1].Cards.First().Subtitle);
        Assert.Equal("2026-05-01T12:00:00.000Z", payload.GeneratedAt);
    }
}

public class ExtrasTests
{
    [Fact]
    public void Similar_links_carry_identity_hints()
    {
        var link = TitleExtrasService.ToSimilarLink(new Recommendation("tmdb", "tv", "tv", "tv", "1396", "Breaking Bad", "p.jpg", 2008, 8.9, null, true));
        Assert.Equal("breaking-bad", link.WorkKey);
        Assert.StartsWith("/title/breaking-bad?t=Breaking+Bad&y=2008&type=tv", link.Href);
        Assert.Contains("provider=tmdb", link.Href);
        Assert.Equal("tv", link.MediaType);
    }

    [Fact]
    public async Task Missing_title_answers_empty_payload()
    {
        var f = new FakeHttpFactory(FakeHandler.Always("{}"));
        var time = new ManualTime();
        var tmdb = new TmdbClient(f, Fixtures.Options(), time);
        var anilist = new AniListClient(f, time);
        var keyless = new KeylessClients(f);
        var service = new TitleExtrasService(tmdb, anilist, keyless, new ArtworkResolver(tmdb, anilist, keyless, Fixtures.Options(), time),
            new RecommendationService(f, tmdb, null!, time, NullLogger<RecommendationService>.Instance), time, NullLogger<TitleExtrasService>.Instance);
        var payload = await service.GetAsync(new TitleExtrasQuery("dune-2021", "", 2021, "movie", null, null, null, null, false));
        Assert.False(payload.Resolved);
        Assert.Equal("dune-2021", payload.WorkKey);
        Assert.Empty(payload.Episodes);
        Assert.False(payload.InTheatricalWindow);
    }

    [Fact]
    public async Task Keyless_series_extras_carry_plain_text_tvmaze_detail()
    {
        const string search = """
            [{"score":0.9,"show":{"id":169,"name":"Breaking Bad","premiered":"2008-01-20","summary":"<p><b>Breaking Bad</b> follows Walter &amp; Jesse.</p><p>Second&#8212;para.</p>",
              "genres":["Drama"," drama ","Crime"],"rating":{"average":9.26},"runtime":60,"image":{"original":"https://static.tvmaze.com/p.jpg"}}}]
            """;
        const string episodes = """[{"season":1,"number":1,"name":"Pilot","airdate":"2008-01-20","runtime":60}]""";
        var f = new FakeHttpFactory(new FakeHandler(r => Task.FromResult(FakeHandler.Json(
            r.RequestUri!.AbsoluteUri.StartsWith(KeylessClients.TvmazeSearch, StringComparison.Ordinal) ? search :
            r.RequestUri.AbsoluteUri.EndsWith("/shows/169/episodes", StringComparison.Ordinal) ? episodes : "[]"))));
        var time = new ManualTime();
        var tmdb = new TmdbClient(f, Fixtures.Options(), time);
        var anilist = new AniListClient(f, time);
        var keyless = new KeylessClients(f);
        var service = new TitleExtrasService(tmdb, anilist, keyless, new ArtworkResolver(tmdb, anilist, keyless, Fixtures.Options(), time),
            new RecommendationService(f, tmdb, null!, time, NullLogger<RecommendationService>.Instance), time, NullLogger<TitleExtrasService>.Instance);
        var payload = await service.GetAsync(new TitleExtrasQuery("breaking-bad", "Breaking Bad", 2008, "tv", null, null, null, null, false));
        Assert.Equal("Breaking Bad follows Walter & Jesse.\nSecond—para.", payload.Overview);
        Assert.Equal(9.3, payload.Rating);
        Assert.Equal("tvmaze", payload.RatingSource);
        Assert.Equal(new[] { "Drama", "Crime" }, payload.Genres);
        Assert.Equal("2008-01-20", payload.ReleaseDate);
        Assert.Single(payload.Episodes);
        Assert.True(payload.Resolved);
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("  <p> </p> ", null)]
    [InlineData("a<br/>b<li>c</li>", "a\nb\nc")]
    [InlineData("&lt;p&gt; stays text &nbsp;&foo;", "<p> stays text &foo;")]
    [InlineData("x&#xD83D;y&#128512;", "xy\U0001F600")]
    public void Html_summary_becomes_plain_text(string? html, string? expected) => Assert.Equal(expected, HtmlText.StripToText(html));

    [Fact]
    public void Home_release_evidence_uses_types_4_to_6()
    {
        var json = System.Text.Json.JsonDocument.Parse("""
            {"release_dates":{"results":[{"iso_3166_1":"US","release_dates":[
              {"type":3,"release_date":"2026-03-01T00:00:00.000Z","certification":"PG-13"},
              {"type":4,"release_date":"2026-06-01T00:00:00.000Z","certification":""}]}]}}
            """).RootElement;
        var (released, next, checkedDates) = TitleExtrasService.HomeRelease(json, new DateTime(2026, 5, 1, 0, 0, 0, DateTimeKind.Utc));
        Assert.False(released);
        Assert.True(checkedDates);
        Assert.Equal("2026-06-01T00:00:00.000Z", next);
        Assert.Equal("PG-13", TitleExtrasService.Certification(json, series: false));
    }
}
