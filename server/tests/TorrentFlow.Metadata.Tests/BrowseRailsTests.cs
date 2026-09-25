using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data.Entities;
using TorrentFlow.Metadata.Artwork;
using TorrentFlow.Metadata.Browse;

namespace TorrentFlow.Metadata.Tests;

/// <summary>Port of src/lib/browse/browse.test.ts (availability rules and personal-rail builders).</summary>
public class BrowseRailsTests
{
    private static EngineTorrent Torrent(string name, string? hash = null, double progress = 0, string status = "downloading") => new()
    {
        Hash = hash ?? name[..Math.Min(16, name.Length)], Name = name, Progress = progress, Status = status,
        VerifiedBitfield = progress >= 0.9999 ? "AQ==" : null,
        VerifiedFilesJson = progress >= 0.9999 ? $$"""[{"path":"{{name}}.mkv"}]""" : null,
    };

    private static Func<string, TorrentPresence> Engine(params (string Hash, TorrentPresence State)[] states) =>
        h => states.FirstOrDefault(s => s.Hash == h.ToLowerInvariant()).State;

    private static TorrentPresence EngineHoldsEverything(string _) => TorrentPresence.Present;

    private static CachedSearchHit Hit(string title, int seeders = 50, EpisodeFacts? episode = null) => new(title, seeders, episode);

    [Theory]
    [InlineData("Breaking Bad S05E16 1080p WEB-DL", "Breaking Bad", 5, 16, true)]
    [InlineData("The Simpsons S35E10 720p HDTV", "The Simpsons", 35, 10, true)]
    [InlineData("[SubsPlease] One Piece - 1170 (1080p) [ABC123]", "One Piece", null, null, true)]
    [InlineData("Family Guy S22E05 1080p WEB-DL", "Family Guy", 22, 7, false)]
    [InlineData("The Bear S03E01 1080p", "Breaking Bad", 3, 1, false)]
    [InlineData("Frieren S01 Complete 1080p WEB-DL", "Frieren", 1, 5, true)]
    [InlineData("The Bear S02 Complete 1080p", "The Bear", 3, 1, false)]
    [InlineData("Dune Part Two 2024 2160p REMUX", "Dune Part Two", null, null, true)]
    [InlineData("Solo Leveling Seasons 1+2 1080p WEB-DL", "Solo Leveling", 2, 3, true)]
    public void Torrent_matching(string name, string title, int? season, int? episode, bool expected) =>
        Assert.Equal(expected, AvailabilityResolver.TorrentMatchesQuery(name, new AvailabilityQuery(title, season, episode)));

    public static TheoryData<string, CachedSearchHit[], AvailabilityQuery, bool> ViableCases => new()
    {
        { "viable", [Hit("Breaking Bad S05E16 1080p WEB-DL", 50, new(5, 16, false))], new("Breaking Bad", 5, 16), true },
        { "0 seeders", [Hit("Obscure Show S01E01 720p", 0, new(1, 1, false))], new("Obscure Show", 1, 1), false },
        { "2 seeders", [Hit("Niche Anime S01E05 1080p", 2, new(1, 5, false))], new("Niche Anime", 1, 5), false },
        { "3 seeders", [Hit("Borderline Show S02E01 720p", 3, new(2, 1, false))], new("Borderline Show", 2, 1), true },
        { "season pack", [Hit("The Bear S03 Complete 1080p WEB-DL", 100, new(3, null, true))], new("The Bear", 3, 5), true },
        { "no results", [], new("Non Existent Show", 1, 1), false },
        { "wrong title", [Hit("Different Show S01E01 1080p", 500, new(1, 1, false))], new("Breaking Bad", 1, 1), false },
        { "no metadata", [Hit("Some Random Movie 2024 1080p", 20)], new("Some Random Movie"), true },
        { "mixed", [Hit("Frieren S01E12 480p", 0), Hit("Frieren S01E12 1080p WEB-DL", 80, new(1, 12, false))], new("Frieren", 1, 12), true },
        { "1 seeder", [Hit("Niche Show S01E01 720p", 1)], new("Niche Show", 1, 1), false },
    };

    [Theory]
    [MemberData(nameof(ViableCases))]
    public void Viable_match_scanning(string name, CachedSearchHit[] results, AvailabilityQuery query, bool expected) =>
        Assert.True(expected == AvailabilityResolver.HasViableMatch(results, query), name);

    public static TheoryData<string, EngineTorrent[], AvailabilityQuery, (string, TorrentPresence)[]?, string?, bool, string?, double?> LocalCases => new()
    {
        { "downloaded → ready", [Torrent("The Bear S03E01 1080p WEB-DL", "bear301hash", 1, "seeding")], new("The Bear", 3, 1), [("bear301hash", TorrentPresence.Present)], "ready", true, "bear301hash", null },
        { "completed absent → not checked", [Torrent("Silo S02E10 1080p WEB-DL", "silo210", 1, "seeding")], new("Silo", 2, 10), [("silo210", TorrentPresence.Absent)], null, true, null, null },
        { "completed unknown → not checked", [Torrent("Foundation S03E01 1080p WEB-DL", "foundation301", 1, "seeding")], new("Foundation", 3, 1), [("foundation301", TorrentPresence.Unknown)], null, true, null, null },
        { "partial live → warm", [Torrent("Frieren S01E12 1080p", "frieren12hash", 0.45)], new("Frieren", 1, 12), [("frieren12hash", TorrentPresence.Present)], "warm", true, "frieren12hash", 0.45 },
        { "stale partial → unknown", [Torrent("Silo S02E10 1080p WEB-DL", "stale-silo", 0.63)], new("Silo", 2, 10), [("stale-silo", TorrentPresence.Absent)], null, true, null, null },
        { "rehydrating partial → unknown", [Torrent("Guardians of the Galaxy 2014 1080p", "guardians-cold", 0.21)], new("Guardians of the Galaxy"), [("guardians-cold", TorrentPresence.Unknown)], null, true, null, null },
        { "0% → null", [Torrent("New Show S01E01 1080p")], new("New Show", 1, 1), null, null, false, null, null },
        { "removed → null", [Torrent("Old Movie 2020 1080p", progress: 1, status: "removed")], new("Old Movie"), null, null, false, null, null },
        { "errored → null", [Torrent("Broken Show S02E05 720p", progress: 0.3, status: "error")], new("Broken Show", 2, 5), null, null, false, null, null },
        { "no match → null", [Torrent("Totally Different Show S01E01", progress: 1, status: "seeding")], new("Breaking Bad", 1, 1), null, null, false, null, null },
        { "ready beats warm", [Torrent("One Piece - 1170 480p", progress: 0.6), Torrent("[SubsPlease] One Piece - 1170 (1080p)", "op1170-1080p", 1, "seeding")], new("One Piece"), [("op1170-1080p", TorrentPresence.Present)], "ready", true, "op1170-1080p", null },
    };

    [Theory]
    [MemberData(nameof(LocalCases))]
    public void Local_availability_derivation(string name, EngineTorrent[] torrents, AvailabilityQuery query, (string, TorrentPresence)[]? engine,
        string? state, bool found, string? infoHash, double? progress)
    {
        var result = AvailabilityResolver.ResolveLocalOnly(query, torrents, engine is null ? EngineHoldsEverything : Engine(engine));
        if (!found) { Assert.True(result is null, name); return; }
        Assert.NotNull(result);
        Assert.Equal(state, result.State);
        if (infoHash is not null) Assert.Equal(infoHash, result.InfoHash);
        if (progress is not null) Assert.Equal(progress, result.Progress);
    }

    [Fact]
    public void Batch_local_states_are_mixed()
    {
        EngineTorrent[] torrents = [Torrent("Breaking Bad S05E16 1080p", "bb5e16", 1, "seeding"), Torrent("The Bear S03E01 1080p", "bear301", 0.6)];
        Assert.Equal("ready", AvailabilityResolver.ResolveLocalOnly(new("Breaking Bad", 5, 16), torrents, EngineHoldsEverything)?.State);
        Assert.Equal("warm", AvailabilityResolver.ResolveLocalOnly(new("The Bear", 3, 1), torrents, EngineHoldsEverything)?.State);
        Assert.Null(AvailabilityResolver.ResolveLocalOnly(new("Non Existent Show", 1, 1), torrents, EngineHoldsEverything));
    }

    [Theory]
    [InlineData("Breaking Bad")]
    [InlineData("One Piece")]
    [InlineData("Dune Part Two")]
    [InlineData("Niche OVA")]
    public void Local_only_never_returns_unavailable(string title) =>
        Assert.Null(AvailabilityResolver.ResolveLocalOnly(new(title), [], EngineHoldsEverything));

    [Fact]
    public void Unknown_vs_unavailable()
    {
        Assert.Null(AvailabilityResolver.ResolveFromSearchCache(new("Some Show", 1, 1), null).State);
        Assert.Equal("unavailable", AvailabilityResolver.ResolveFromSearchCache(new("Some Show", 1, 1), [Hit("Some Show S01E01 720p", 0), Hit("Some Show S01E01 480p", 1)]).State);
        Assert.Equal("fetchable", AvailabilityResolver.ResolveFromSearchCache(new("Some Show", 1, 1), [Hit("Some Show S01E01 1080p WEB-DL", 100, new(1, 1, false))]).State);
        Assert.Equal("unavailable", AvailabilityResolver.ResolveFromSearchCache(new("Nonexistent Thing"), []).State);
        Assert.Null(AvailabilityResolver.ResolveFromSearchCache(new("One Piece", 23, 1170), null).State);
        Assert.Equal("unavailable", AvailabilityResolver.ResolveFromSearchCache(new("Niche OVA", 1, 1), [Hit("Niche OVA S01E01 720p", 0)]).State);
        Assert.Equal("fetchable", AvailabilityResolver.ResolveFromSearchCache(new("Interstellar"), [Hit("Interstellar 2014 1080p BluRay", 5000)]).State);
        Assert.Equal("unavailable", AvailabilityResolver.ResolveFromSearchCache(new("Obscure British Drama", 2, 3), [Hit("Obscure British Drama S02E03 720p", 2, new(2, 3, false))]).State);
    }

    [Fact]
    public void Stale_partial_local_evidence_cannot_fall_through_to_unavailable() =>
        Assert.Null(AvailabilityResolver.ResolveWithSearchCache(new("Silo"), Availability.Unknown, []).State);

    [Fact]
    public void Search_cache_payload_parses_results()
    {
        var hits = AvailabilityResolver.ParsePayload("""{"results":[{"title":"A S01E01","seeders":9,"episode":{"season":1,"episode":1,"isSeasonPack":false}},{"title":"B"}]}""");
        Assert.Equal([new CachedSearchHit("A S01E01", 9, new(1, 1, false)), new CachedSearchHit("B", 0, null)], hits);
        Assert.Null(AvailabilityResolver.ParsePayload("{not json"));
    }

    [Fact]
    public void Release_backed_rails_use_the_shared_work_collapse()
    {
        string[] names = ["The Bear S03E01 1080p WEB-DL x265", "The Bear S03E02 720p HDTV x264", "www.UIndex.org - Rick and Morty S01E02 1080p WEB-DL x264",
            "Rick.and.Morty.S01E01.1080p.WEB-DL.x264-GROUP", "Breaking Bad S05E16 1080p"];
        var collapsed = WorkCollapse.CollapseReleasesByWork(names.Select((n, i) => new CollapsibleRelease<string>(n, new DateTime(2024, 1, 1).AddMinutes(i), n)));
        Assert.Equal(["The Bear", "Rick and Morty", "Breaking Bad"], collapsed.Select(w => w.Title));
        Assert.Equal([2, 2, 1], collapsed.Select(w => w.ReleaseCount));
    }

    private static PlaybackProgress Progress(string id, string infoHash, string filePath, double pos, double dur, string title, int? season, int? episode,
        string? watchListItemId, DateTime updatedAt, string? workId = null) => new()
    {
        Id = id, InfoHash = infoHash, FilePath = filePath, PositionSec = pos, DurationSec = dur, Title = title, Season = season, Episode = episode,
        WatchListItemId = watchListItemId, UpdatedAt = updatedAt, WorkId = workId, UserId = "user-1",
    };

    [Fact]
    public void Continue_watching_resolves_episode_only_progress_through_the_linked_library_work()
    {
        var works = BrowseService.ContinueWatchingWorksFromRows(
            [(Progress("progress-silo-e2", "ABCDEF1234", "Silo/S01E02.mkv", 600, 3000, "S01E02", 1, 2, "watch-silo", new DateTime(2024, 1, 2)), null)],
            [], [new WatchListItem { Id = "watch-silo", Title = "Silo", PosterUrl = "https://images.example.test/silo.jpg", MediaType = "tv" }]);
        var rail = BrowseService.ContinueWatchingRailFromWorks(works, [], _ => TorrentPresence.Unknown);
        Assert.NotNull(rail);
        var item = Assert.Single(rail.Cards);
        Assert.Equal(("Silo", "S01E02", "https://images.example.test/silo.jpg", "tv", 0.2),
            (item.Title, item.Subtitle, item.PosterUrl, item.MediaType, item.ProgressFraction));
    }

    [Fact]
    public void Continue_watching_collapses_different_torrent_names_under_canonical_work()
    {
        var canonical = new BrowseService.ProgressWork("work-slime", "that-time-i-got-reincarnated-as-a-slime", "That Time I Got Reincarnated as a Slime",
            "anime", "https://images.example.test/slime.jpg");
        var works = BrowseService.ContinueWatchingWorksFromRows(
        [
            (Progress("progress-slime-e2", "slimehash2", "Slime/S01E02.mkv", 300, 1500, "Tensei Shitara Slime Datta Ken", 1, 2, null, new DateTime(2024, 1, 3), "work-slime"), canonical),
            (Progress("progress-slime-e1", "slimehash1", "Slime/S01E01.mkv", 200, 1500, "[HorribleSubs] Tensei Shitara Slime Datta Ken - 01", 1, 1, null, new DateTime(2024, 1, 2), "work-slime"), canonical),
            (Progress("progress-slime-legacy", "slimehashlegacy", "Slime/S01E03.mkv", 100, 1500, "[HorribleSubs] Tensei Shitara Slime Datta Ken - 03", 1, 3, null, new DateTime(2024, 1, 1)), null),
        ],
        [
            Torrent("That Time I Got Reincarnated as a Slime S01E02", "slimehash2", 1, "uploading"),
            Torrent("[HorribleSubs] Tensei Shitara Slime Datta Ken - 01", "slimehash1", 1, "uploading"),
            Torrent("[HorribleSubs] Tensei Shitara Slime Datta Ken - 03", "slimehashlegacy", 1, "uploading"),
        ], []);
        var work = Assert.Single(works);
        Assert.Equal("work-slime", work.Value.Progress.WorkId);
        Assert.Equal(canonical.WorkKey, work.WorkKey);
        Assert.Equal(canonical.CanonicalTitle, work.Title);
        Assert.Equal(3, work.ReleaseCount);
    }

    [Fact]
    public void Continue_watching_resolves_episode_only_progress_through_the_torrent_release_and_artwork()
    {
        var works = BrowseService.ContinueWatchingWorksFromRows(
            [(Progress("progress-dark-e2", "darkhash", "Dark/S01E02.mkv", 300, 1500, "S01E02", 1, 2, null, new DateTime(2024, 1, 2)), null)],
            [Torrent("Dark.S01E02.1080p.WEBRip.x264-GROUP", "darkhash", 0.5)], []);
        var rail = BrowseService.ContinueWatchingRailFromWorks(works,
            [new ArtworkResult("https://images.example.test/dark.jpg", "https://images.example.test/dark-backdrop.jpg")], EngineHoldsEverything);
        var item = Assert.Single(rail!.Cards);
        Assert.Equal(("Dark", "S01E02", "https://images.example.test/dark.jpg", "https://images.example.test/dark-backdrop.jpg", "warm"),
            (item.Title, item.Subtitle, item.PosterUrl, item.BackdropUrl, item.Availability));
        Assert.Equal("Dark.S01E02.1080p.WEBRip.x264-GROUP", Assert.Single(works).ArtworkName);
    }

    [Fact]
    public void Continue_watching_excludes_unresolved_episode_only_rows()
    {
        var works = BrowseService.ContinueWatchingWorksFromRows(
            [(Progress("progress-unknown-e6", "1234ABCDEF", "S01E06.mkv", 120, 1200, "S01E06", 1, 6, null, new DateTime(2024, 1, 3)), null)], [], []);
        Assert.Empty(works);
        Assert.Null(BrowseService.ContinueWatchingRailFromWorks(works, [], EngineHoldsEverything));
    }

    [Theory]
    [InlineData(1, "seeding", TorrentPresence.Present, "ready")]
    [InlineData(1, "seeding", TorrentPresence.Absent, null)]
    [InlineData(0.52, "downloading", TorrentPresence.Present, "warm")]
    [InlineData(0.52, "downloading", TorrentPresence.Absent, null)]
    [InlineData(0.52, "downloading", TorrentPresence.Unknown, null)]
    public void Continue_watching_live_engine_reconciliation(double progress, string status, TorrentPresence live, string? expected)
    {
        var result = BrowseService.EngineAvailability(new EngineTorrent { Hash = "h", Progress = progress, Status = status }, _ => live);
        Assert.Equal(expected, result);
        Assert.NotEqual("unavailable", result);
    }

    [Fact]
    public void Completed_disk_media_stays_ready_after_its_engine_handle_is_detached() =>
        Assert.Equal("ready", BrowseService.EngineAvailability(
            new EngineTorrent { Hash = "moon-knight", Progress = 1, Status = "downloaded", SavePath = "D:\\Media", VerifiedFilesJson = """[{"path":"Moon Knight S01E01.mkv"}]""" },
            _ => TorrentPresence.Absent, _ => LocalFilePresence.Present));

    private static RailItem Card(string id, string title, string? availability) => new() { Id = id, Title = title, Availability = availability };

    [Fact]
    public void Ready_to_play_rail_is_truthful()
    {
        Assert.Null(BrowseService.ReadyToPlayRailFromItems([Card("dune", "Dune Part Two", null), Card("bear", "The Bear", null)]));
        var rail = BrowseService.ReadyToPlayRailFromItems([Card("ready", "Severance", "ready"), Card("absent", "Silo", "fetchable")]);
        Assert.Equal(["Severance"], rail!.Cards.Select(c => c.Title));
        Assert.Equal(["ready"], rail.Cards.Select(c => c.Availability));
        Assert.Null(BrowseService.ReadyToPlayRailFromItems([Card("partial", "Frieren", "warm")]));
        Assert.Null(BrowseService.ReadyToPlayRailFromItems([Card("silo", "Silo", "fetchable"), Card("foundation", "Foundation", "fetchable")]));
    }

    [Fact]
    public void Ready_collapse_keeps_a_season_pack_ahead_of_a_newer_single()
    {
        var collapsed = WorkCollapse.CollapseReleasesByWork([
            new CollapsibleRelease<string>("Harness Show S01E04 1080p WEB", new DateTime(2024, 1, 2), "single") { Prefer = BrowseService.ReadyRepresentativePreference("Harness Show S01E04 1080p WEB") },
            new CollapsibleRelease<string>("Harness Show S01 COMPLETE 1080p WEB", new DateTime(2024, 1, 1), "pack") { Prefer = BrowseService.ReadyRepresentativePreference("Harness Show S01 COMPLETE 1080p WEB") },
        ]);
        Assert.Equal("pack", collapsed[0].Value);
    }
}
