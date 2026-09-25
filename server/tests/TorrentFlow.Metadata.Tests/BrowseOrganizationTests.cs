using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data.Entities;
using TorrentFlow.Metadata.Browse;

namespace TorrentFlow.Metadata.Tests;

/// <summary>Port of src/lib/browse/rails-organization.test.ts.</summary>
public class RailsOrganizationTests
{
    private static RailItem Item(string title, string? mediaType = null, string? id = null) => new() { Id = id ?? title, Title = title, MediaType = mediaType };

    private static Rail MakeRail(string id, string title, params RailItem[] items) => new(id, title, items.Cast<object>().ToList());

    private static readonly string[] Order = ["continue-watching", "ready-to-play", "recently-added"];

    [Theory]
    [InlineData(1, "seeding", true)]
    [InlineData(1, "uploading", true)]
    [InlineData(0.5, "downloading", false)]
    [InlineData(0.16, "downloading", false)]
    [InlineData(0.99, "downloading", false)]
    [InlineData(0, "metaDL", false)]
    [InlineData(1, "removed", false)]
    [InlineData(1, "error", false)]
    public void Ready_to_play_membership_excludes_mid_download(double progress, string status, bool expected) =>
        Assert.Equal(expected, BrowseService.ReadyToPlayTorrentCanSurface(new EngineTorrent { Progress = progress, Status = status }));

    [Theory]
    [InlineData("movie", "movie")]
    [InlineData("film", "movie")]
    [InlineData("Movie", "movie")]
    [InlineData("tv", "series")]
    [InlineData("anime", "series")]
    [InlineData("series", "series")]
    [InlineData("show", "series")]
    [InlineData(null, "unknown")]
    [InlineData("", "unknown")]
    [InlineData("software", "unknown")]
    public void Media_group_classification(string? mediaType, string group) => Assert.Equal(group, BrowseService.MediaGroupOf(mediaType));

    [Fact]
    public void Mixed_rail_splits_into_two_homogeneous_rails()
    {
        var output = BrowseService.SplitRailByMediaType(MakeRail("recently-added", "Recently Added",
            Item("Dune Part Two", "movie"), Item("The Bear", "tv"), Item("Oppenheimer", "movie"), Item("Severance", "anime")));
        Assert.Equal(2, output.Count);
        var movies = output.Single(r => r.Id == "recently-added-movies");
        var series = output.Single(r => r.Id == "recently-added-series");
        Assert.All(movies.Cards, i => Assert.Equal("movie", BrowseService.MediaGroupOf(i.MediaType)));
        Assert.All(series.Cards, i => Assert.Equal("series", BrowseService.MediaGroupOf(i.MediaType)));
        Assert.Equal(2, movies.Items.Count);
        Assert.Equal(2, series.Items.Count);
        Assert.Equal("Recently Added · Movies", movies.Title);
    }

    [Fact]
    public void All_movies_rail_is_not_split()
    {
        var output = BrowseService.SplitRailByMediaType(MakeRail("ready-to-play", "Ready to Play", Item("Dune", "movie"), Item("Tenet", "film")));
        Assert.Equal("Ready to Play", Assert.Single(output).Title);
    }

    [Fact]
    public void All_unknown_rail_stays_single() =>
        Assert.Equal(2, Assert.Single(BrowseService.SplitRailByMediaType(MakeRail("recently-added", "Recently Added", Item("Mystery A"), Item("Mystery B")))).Items.Count);

    [Fact]
    public void Unknowns_keep_a_plain_rail()
    {
        var output = BrowseService.SplitRailByMediaType(MakeRail("recently-added", "Recently Added",
            Item("Dune", "movie"), Item("The Bear", "tv"), Item("Some Toolkit", "software")));
        Assert.Equal(3, output.Count);
        Assert.Equal("Some Toolkit", Assert.Single(output.Single(r => r.Id == "recently-added").Cards).Title);
    }

    [Fact]
    public void A_title_in_every_rail_survives_only_in_the_highest_priority()
    {
        var output = BrowseService.DedupeAcrossRails([
            MakeRail("continue-watching", "Continue Watching", Item("The Bear")),
            MakeRail("ready-to-play", "Ready to Play", Item("The Bear")),
            MakeRail("recently-added", "Recently Added", Item("The Bear")),
        ], Order);
        Assert.Equal([1, 0, 0], output.Select(r => r.Items.Count));
    }

    [Fact]
    public void Release_spellings_collapse_across_rails()
    {
        var output = BrowseService.DedupeAcrossRails([
            MakeRail("ready-to-play", "Ready to Play", Item("Rick and Morty")),
            MakeRail("recently-added", "Recently Added", Item("Rick.and.Morty")),
        ], Order);
        Assert.Equal([1, 0], output.Select(r => r.Items.Count));
    }

    [Fact]
    public void Distinct_works_are_kept()
    {
        var output = BrowseService.DedupeAcrossRails([
            MakeRail("ready-to-play", "Ready to Play", Item("Dune", "movie")),
            MakeRail("recently-added", "Recently Added", Item("Dune Part Two", "movie"), Item("Oppenheimer", "movie")),
        ], Order);
        Assert.Equal([1, 2], output.Select(r => r.Items.Count));
    }

    [Fact]
    public void Rail_order_is_preserved_and_out_of_scope_rails_pass_through()
    {
        var output = BrowseService.DedupeAcrossRails([
            MakeRail("continue-watching", "Continue Watching", Item("The Bear")),
            MakeRail("my-library", "My Library", Item("The Bear")),
            MakeRail("recently-added", "Recently Added", Item("The Bear")),
        ], Order);
        Assert.Equal(["continue-watching", "my-library", "recently-added"], output.Select(r => r.Id));
        Assert.Equal([1, 1, 0], output.Select(r => r.Items.Count));
    }

    [Fact]
    public void Duplicates_within_one_rail_collapse() =>
        Assert.Single(BrowseService.DedupeAcrossRails([MakeRail("recently-added", "Recently Added", Item("The Bear", id: "a"), Item("The Bear", id: "b"))], Order)[0].Items);

    [Fact]
    public void Work_key_is_stable_across_spellings()
    {
        Assert.Equal(BrowseService.RailItemWorkKey(Item("Rick and Morty")), BrowseService.RailItemWorkKey(Item("Rick.and.Morty")));
        Assert.NotEqual(BrowseService.RailItemWorkKey(Item("Dune")), BrowseService.RailItemWorkKey(Item("Dune Part Two")));
    }
}

/// <summary>Port of src/lib/browse/availability-local.test.ts.</summary>
public class AvailabilityLocalTests
{
    private static readonly AvailabilityQuery Query = new("Moon Knight", 1, 1);

    private static EngineTorrent Downloaded() => new()
    {
        Hash = "abc", Name = "Moon Knight S01E01 1080p", Progress = 1, Status = "downloaded", SavePath = "D:\\Media",
        VerifiedBitfield = "AQ==", VerifiedFilesJson = """[{"path":"Moon Knight S01E01.mkv"}]""",
    };

    [Fact]
    public void A_verified_local_file_is_ready_without_a_live_session() =>
        Assert.Equal(new Availability("ready", "abc"),
            AvailabilityResolver.ResolveLocalOnly(Query, [Downloaded()], _ => TorrentPresence.Absent, _ => LocalFilePresence.Present));

    [Fact]
    public void A_confirmed_missing_file_cannot_advertise_ready() =>
        Assert.Null(AvailabilityResolver.ResolveLocalOnly(Query, [Downloaded()], _ => TorrentPresence.Absent, _ => LocalFilePresence.Absent));

    [Fact]
    public void Partial_content_still_requires_a_live_engine()
    {
        var partial = Downloaded();
        partial.Progress = 0.4;
        partial.Status = "downloading";
        Assert.Equal(Availability.Unknown,
            AvailabilityResolver.ResolveLocalOnly(Query, [partial], _ => TorrentPresence.Absent, _ => LocalFilePresence.Present));
    }

    [Fact]
    public void A_live_partial_is_warm_with_progress()
    {
        var partial = Downloaded();
        partial.Progress = 0.4;
        partial.Status = "downloading";
        Assert.Equal(new Availability("warm", "abc", 0.4),
            AvailabilityResolver.ResolveLocalOnly(Query, [partial], _ => TorrentPresence.Present, _ => LocalFilePresence.Unknown));
    }

    [Fact]
    public void Newly_local_content_overrides_cached_search_state()
    {
        var local = new Availability("ready", "abc");
        Assert.Equal(local, AvailabilityResolver.ResolveWithSearchCache(Query, local, [new CachedSearchHit("Moon Knight S01E01", 1, new EpisodeFacts(1, 1, false))]));
        Assert.Equal("fetchable", AvailabilityResolver.ResolveWithSearchCache(Query, null, [new CachedSearchHit("Moon Knight S01E01", 50, new EpisodeFacts(1, 1, false))]).State);
        Assert.Equal("unavailable", AvailabilityResolver.ResolveWithSearchCache(Query, null, [new CachedSearchHit("Moon Knight S01E01", 2, new EpisodeFacts(1, 1, false))]).State);
    }
}

public class LocalFilePresenceCacheTests
{
    [Fact]
    public void Probes_disk_once_per_window_and_classifies_evidence()
    {
        var time = new ManualTime();
        var verdict = StatVerdict.Exists;
        var calls = 0;
        var cache = new LocalFilePresenceCache(time) { Stat = _ => { calls++; return verdict; } };
        const string files = """[{"path":"D:\\Media\\a.mkv"}]""";
        Assert.Equal(LocalFilePresence.Present, cache.Presence("h", "D:\\Media", files));
        verdict = StatVerdict.Missing;
        Assert.Equal(LocalFilePresence.Present, cache.Presence("h", "D:\\Media", files));
        Assert.Equal(2, calls);
        time.Advance(LocalFilePresenceCache.PresenceTtl);
        Assert.Equal(LocalFilePresence.Absent, cache.Presence("h", "D:\\Media", files));
        Assert.Equal(LocalFilePresence.Unknown, cache.Lookup([])("H"));
    }

    [Fact]
    public void Evidence_classification()
    {
        Assert.Equal(LocalFilePresence.Present, LocalFiles.Classify(new(2, 1, 1, StatVerdict.Missing)));
        Assert.Equal(LocalFilePresence.Absent, LocalFiles.Classify(new(2, 0, 2, StatVerdict.Exists)));
        Assert.Equal(LocalFilePresence.Absent, LocalFiles.Classify(new(0, 0, 0, StatVerdict.Missing)));
        Assert.Equal(LocalFilePresence.Unknown, LocalFiles.Classify(new(2, 0, 1, StatVerdict.Unknown)));
    }

    [Fact]
    public void Engine_manifest_is_located_by_fullPath_and_skips_discarded_junk()
    {
        // .NET engine shape: torrent-relative path + absolute fullPath (nulled for junk the layout discarded).
        const string files = """
            [{"path":"Sintel.mp4","size":1,"fullPath":"D:\\Media\\Movies\\Sintel\\Sintel.mp4"},
             {"path":"poster.jpg","size":1,"fullPath":null},
             {"path":"D:\\Legacy\\Episode.mkv","size":1}]
            """;
        Assert.Equal(["D:\\Media\\Movies\\Sintel\\Sintel.mp4", "D:\\Legacy\\Episode.mkv"], LocalFiles.RecordedFilePaths(files));

        var onDisk = new HashSet<string> { "D:\\Media\\Movies\\Sintel\\Sintel.mp4" };
        var evidence = LocalFiles.Collect("D:\\Media\\Movies", files, p => onDisk.Contains(p) ? StatVerdict.Exists : StatVerdict.Missing);
        Assert.Equal(LocalFilePresence.Present, LocalFiles.Classify(evidence));
        Assert.True(LocalFiles.PersistedTorrentIsDownloaded(1, "/w==", files));
    }
}

/// <summary>Port of src/lib/browse/release-status.test.ts.</summary>
public class ReleaseStatusTests
{
    private static readonly DateTimeOffset Now = new(2026, 7, 28, 0, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not-a-date")]
    public void Unknown_dates_are_released(string? input)
    {
        var s = ReleaseGates.Of(input, Now);
        Assert.False(s.Unreleased);
        Assert.True(s.Released);
        Assert.Null(s.ComingLabel);
    }

    [Fact]
    public void A_past_date_is_released()
    {
        var s = ReleaseGates.Of("2021-11-05", Now);
        Assert.False(s.Unreleased);
        Assert.True(s.Released);
        Assert.Null(s.ComingLabel);
    }

    [Fact]
    public void Today_is_released() => Assert.False(ReleaseGates.Of("2026-07-28T00:00:00.000Z", Now).Unreleased);

    [Fact]
    public void A_future_day_gets_a_month_year_label()
    {
        var s = ReleaseGates.Of("2026-12-25", Now);
        Assert.True(s.Unreleased);
        Assert.False(s.Released);
        Assert.Equal("Coming Dec 2026", s.ComingLabel);
    }

    [Fact]
    public void A_future_year_placeholder_gets_a_year_label()
    {
        var s = ReleaseGates.Of("2027-01-01", Now);
        Assert.True(s.Unreleased);
        Assert.Equal("Coming 2027", s.ComingLabel);
    }

    [Fact]
    public void Accepts_date_inputs()
    {
        Assert.True(ReleaseGates.Of(new DateTimeOffset(2030, 1, 1, 0, 0, 0, TimeSpan.Zero), Now).Unreleased);
        Assert.False(ReleaseGates.Of(new DateTimeOffset(2000, 1, 1, 0, 0, 0, TimeSpan.Zero), Now).Unreleased);
        Assert.True(ReleaseGates.IsUnreleased("2030-06-01", Now));
    }

    [Theory]
    [InlineData("2026-07-27", false)]
    [InlineData("2026-07-29", true)]
    [InlineData("2025-01-01", false)]
    [InlineData("2028-03-15", true)]
    public void Holds_across_many_dates(string date, bool expected) => Assert.Equal(expected, ReleaseGates.IsUnreleased(date, Now));
}
