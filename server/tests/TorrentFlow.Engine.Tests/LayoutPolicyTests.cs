using Microsoft.Extensions.Logging;
using TorrentFlow.Engine.Layout;

namespace TorrentFlow.Engine.Tests;

/// <summary>Records formatted log lines so the exact TypeScript log messages can be asserted.</summary>
internal sealed class ListLogger<T> : ILogger<T>
{
    public readonly List<(LogLevel Level, string Message)> Lines = [];
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => true;
    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        lock (Lines) Lines.Add((logLevel, formatter(state, exception)));
    }
    public bool Has(string text) { lock (Lines) return Lines.Any(l => l.Message.Contains(text, StringComparison.Ordinal)); }
}

/// <summary>Port of src/lib/clients/content-layout.test.ts: the same inputs, the same decisions.</summary>
public class LayoutPolicyTests
{
    private static List<LayoutFile> Files(params string[] paths) => paths.Select(p => new LayoutFile(p, 100)).ToList();

    private static LayoutPlan? Plan(string[] paths, string? dest = null) => ContentLayoutPlanner.Plan(Files(paths), dest);

    private static Func<string, ExistingFile?> Probe(Dictionary<string, ExistingFile> map) => rel => map.GetValueOrDefault(rel);

    [Fact]
    public void ADoubleWrapIsFlattened()
    {
        const string outer = "Solo Leveling 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
        const string inner = "Solo Leveling S01 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
        var p = Plan([$"{outer}/{inner}/S01E01.mkv", $"{outer}/{inner}/S01E02.mkv", $"{outer}/{inner}/Subs/S01E01.eng.srt"],
            "D:/downloads/Anime/Solo Leveling/Season 01");
        Assert.NotNull(p);
        Assert.Equal([outer, inner], p.Roots);
        Assert.Equal(["S01E01.mkv", "S01E02.mkv", "Subs/S01E01.eng.srt"], p.Paths);
        Assert.Equal("removed 2 wrapper folders", p.Describe());
    }

    [Fact]
    public void ASingleReleaseFolderIsDropped()
    {
        var p = Plan(["Dune Part Two (2024) [2160p] [4K] [WEB] [5.1] [YTS.MX]/Dune.mp4", "Dune Part Two (2024) [2160p] [4K] [WEB] [5.1] [YTS.MX]/subs/en.srt"],
            "D:/downloads/Movies/Dune Part Two");
        Assert.NotNull(p);
        Assert.Equal(["Dune.mp4", "subs/en.srt"], p.Paths);
        Assert.Equal("removed 1 wrapper folder", p.Describe());
    }

    [Fact]
    public void FlatSingleFileAndSplitRootsAreUntouched()
    {
        Assert.Null(Plan(["movie.mkv", "poster.jpg"]));
        Assert.Null(Plan(["Some.Movie.2024.mkv"]));
        Assert.Null(Plan(["A/one.mkv", "B/two.mkv"]));
        Assert.Equal(["Release.Name"], Plan(["Release.Name/movie.mkv", "Release.Name/info.nfo"])!.Roots);
    }

    [Fact]
    public void StructuresSurvive()
    {
        var dvd = Plan(["Some Film 1998 DVD/VIDEO_TS/VIDEO_TS.IFO", "Some Film 1998 DVD/VIDEO_TS/VTS_01_1.VOB"]);
        Assert.NotNull(dvd);
        Assert.Equal(["Some Film 1998 DVD"], dvd.Roots);
        Assert.Equal(["VIDEO_TS/VIDEO_TS.IFO", "VIDEO_TS/VTS_01_1.VOB"], dvd.Paths);

        Assert.Null(Plan(["BDMV/index.bdmv", "BDMV/STREAM/00001.m2ts"]));
        Assert.Null(Plan(["PS3_GAME/USRDIR/EBOOT.BIN", "PS3_GAME/ICON0.PNG"]));
        Assert.Null(Plan(["Disc 1/track01.flac", "Disc 1/track02.flac"]));

        var concert = Plan(["Live Concert 2019 FLAC/Disc 1/track01.flac", "Live Concert 2019 FLAC/Disc 2/track01.flac"]);
        Assert.NotNull(concert);
        Assert.Equal(["Live Concert 2019 FLAC"], concert.Roots);
        Assert.Equal(["Disc 1/track01.flac", "Disc 2/track01.flac"], concert.Paths);

        Assert.Equal(["a"], Plan(["a/b/c/d/e/file.mkv", "a/b/c/d/e/other.mkv"])!.Roots);
        Assert.Equal(["Author Collection"], Plan(["Author Collection/Series/Book One/book.epub", "Author Collection/Series/Book Two/book.epub"])!.Roots);
    }

    [Fact]
    public void SeasonFolderIsDroppedOnlyWhenTheDestinationNamesIt()
    {
        Assert.Null(Plan(["Season 01/ep.mkv", "Season 01/ep2.mkv"], "D:/downloads/TV/Show"));
        var p = Plan(["Season 01/ep.mkv", "Season 01/ep2.mkv"], "D:/downloads/TV/Show/Season 1");
        Assert.NotNull(p);
        Assert.Equal(["ep.mkv", "ep2.mkv"], p.Paths);
    }

    [Fact]
    public void SimilarityFalsePositivesDoNotStrip()
    {
        Assert.Equal(["Artist Album 2024 FLAC 24bit"], Plan([
            "Artist Album 2024 FLAC 24bit/Artist Album 2024 Disc 1 FLAC 24bit/01.flac",
            "Artist Album 2024 FLAC 24bit/Artist Album 2024 Disc 1 FLAC 24bit/02.flac"])!.Roots);
        Assert.Single(Plan([
            "Show S01 1080p WEB DL Dual Audio/Show S01 1080p WEB DL English Audio/e01.mkv",
            "Show S01 1080p WEB DL Dual Audio/Show S01 1080p WEB DL English Audio/e02.mkv"])!.Roots);
        Assert.Single(Plan([
            "Movie 2024 1080p BluRay x264/Movie 2024 1080p BluRay x265/movie.mkv",
            "Movie 2024 1080p BluRay x264/Movie 2024 1080p BluRay x265/sample.mkv"])!.Roots);
        Assert.Single(Plan([
            "Frieren Complete 1080p Batch/Frieren S01 1080p Batch/e01.mkv",
            "Frieren Complete 1080p Batch/Frieren S01 1080p Batch/e02.mkv"], "D:/downloads/Anime/Frieren")!.Roots);
    }

    [Fact]
    public void IsSameReleaseMatchesTheTypeScriptDecisions()
    {
        var soloDest = new HashSet<string> { "season 1" };
        Assert.True(ContentLayoutPolicy.IsSameRelease("Solo Leveling 1080p Dual Audio BDRip x265-EMBER", "Solo Leveling S01 1080p Dual Audio BDRip x265-EMBER", soloDest));
        Assert.False(ContentLayoutPolicy.IsSameRelease("Solo Leveling 1080p Dual Audio BDRip x265-EMBER", "Solo Leveling S01 1080p Dual Audio BDRip x265-EMBER", new HashSet<string>()));
        Assert.False(ContentLayoutPolicy.IsSameRelease("Movie 1080p x264", "Movie 1080p x265"));
        Assert.False(ContentLayoutPolicy.IsSameRelease("VIDEO_TS", "Some Film 1998 DVD"));
        Assert.False(ContentLayoutPolicy.IsSameRelease("Album FLAC", "Album Disc 1 FLAC"));
        Assert.False(ContentLayoutPolicy.IsSameRelease("Frieren Complete 1080p Batch", "Frieren S01 1080p Pack", new HashSet<string>()));
        Assert.False(ContentLayoutPolicy.IsSameRelease("Show 1080p WEB Complete", "Show S01 1080p WEB", new HashSet<string>()));
        Assert.False(ContentLayoutPolicy.IsSameRelease("Show S01 1080p Pack", "Show S01 E01 1080p", new HashSet<string>()));
        Assert.False(ContentLayoutPolicy.IsSameRelease("1080p x265 WEB", "1080p x265 WEB DD"));
    }

    [Fact]
    public void TraversalAndCollapsingPathsAreRefused()
    {
        Assert.Null(Plan(["Release/../../etc/passwd", "Release/ok.mkv"]));
        Assert.Null(Plan(["Release/./a.mkv", "Release/b.mkv"]));
        Assert.Null(Plan(["R/Ep 01: Arrival.mkv", "R/Ep 01 Arrival.mkv"]));
        Assert.Null(ContentLayoutPlanner.Plan(Files("R/Cover.jpg", "R/cover.jpg"), null, windows: true));
        Assert.NotNull(ContentLayoutPlanner.Plan(Files("R/Cover.jpg", "R/cover.jpg"), null, windows: false));
        Assert.Equal(ContentLayoutPolicy.PhysicalKey("Dir/Ep 01: Arrival.mkv"), ContentLayoutPolicy.PhysicalKey("Dir/Ep 01 Arrival.mkv"));
        Assert.NotEqual(ContentLayoutPolicy.PhysicalKey("Dir/a.mkv"), ContentLayoutPolicy.PhysicalKey("Dir/b.mkv"));
    }

    [Fact]
    public void AnotherTorrentsFileCancelsTheRewrite()
    {
        var log = new ListLogger<LayoutPolicyTests>();
        var plan = ContentLayoutPlanner.Apply(Files("Release/episode.mkv", "Release/Screens/s1.png"), "D:/downloads/TV/Show/Season 03", "aaaa",
            Probe(new() { ["Screens/s1.png"] = new ExistingFile(100, "bbbb") }), null, log);
        Assert.Null(plan);
        Assert.True(log.Has("[content-layout] keeping the release folder — \"Screens/s1.png\" would collide: it belongs to torrent bbbb"));
    }

    [Fact]
    public void OwnClaimIsResumeDataWhateverTheSize()
    {
        var plan = ContentLayoutPlanner.Apply(Files("Release/episode.mkv"), "D:/downloads/TV/Show/Season 03", "AAAA",
            Probe(new() { ["episode.mkv"] = new ExistingFile(7, "aaaa") }), null, new ListLogger<LayoutPolicyTests>());
        Assert.Equal(["Release"], plan!.Roots);
        Assert.Equal(["episode.mkv"], plan.Paths);
    }

    [Fact]
    public void UnclaimedFilesBlockOnlyWhenTheSizeDiffers()
    {
        var log = new ListLogger<LayoutPolicyTests>();
        Assert.Null(ContentLayoutPlanner.Apply(Files("Release/movie.mkv"), "D:/downloads/Movies/X", "aaaa",
            Probe(new() { ["movie.mkv"] = new ExistingFile(999, null) }), null, log));
        Assert.True(log.Has("\"movie.mkv\" would collide: a file of a different size is already there"));
        Assert.Equal(["Release"], ContentLayoutPlanner.Apply(Files("Release/movie.mkv"), "D:/downloads/Movies/X", "aaaa",
            Probe(new() { ["movie.mkv"] = new ExistingFile(100, null) }), null, log)!.Roots);
    }

    [Fact]
    public void ADirectoryInTheWayBlocks()
    {
        var log = new ListLogger<LayoutPolicyTests>();
        Assert.Null(ContentLayoutPlanner.Apply(Files("Release/Subs"), "D:/downloads/Movies/X", "aaaa",
            Probe(new() { ["Subs"] = new ExistingFile(100, null, IsDirectory: true) }), null, log));
        Assert.True(log.Has("would collide: a directory is in the way"));
    }

    [Fact]
    public void AFailedClaimKeepsTheReleaseFolder()
    {
        var log = new ListLogger<LayoutPolicyTests>();
        Assert.Null(ContentLayoutPlanner.Apply(Files("Release/movie.mkv"), "D:/downloads/Movies/X", "aaaa", _ => null, _ => false, log));
        Assert.True(log.Has("[content-layout] keeping the release folder — ownership could not be recorded"));
    }

    [Fact]
    public void SoloLevelingShapes()
    {
        const string s01 = "Solo Leveling S01 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
        const string s02 = "Solo Leveling S02 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
        const string root = "Solo Leveling 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
        const string season01 = "D:/Torrents/Anime/Solo Leveling/Season 01";

        Assert.Equal([root, s01], Plan([$"{root}/{s01}/Solo Leveling - S01E01.mkv", $"{root}/{s01}/Solo Leveling - S01E02.mkv"], season01)!.Roots);
        Assert.Equal([s01], Plan([$"{s01}/Solo Leveling - S01E01.mkv"], season01)!.Roots);
        Assert.Equal([s02], Plan([$"{s02}/Solo Leveling - S02E01.mkv"], "D:/Torrents/Anime/Solo Leveling/Season 02")!.Roots);
        Assert.Equal([root], Plan([$"{root}/{s02}/Solo Leveling - S02E01.mkv"], season01)!.Roots);

        var batch = Plan([$"{root}/{s01}/S01E01-I'm Used to It [28559867].mkv", $"{root}/{s02}/S02E02-I Suppose You Aren't Aware [15146868].mkv"],
            "D:/Torrents/Anime/Solo Leveling");
        Assert.Equal([root], batch!.Roots);
        Assert.Equal(["Season 01/S01E01-I'm Used to It [28559867].mkv", "Season 02/S02E02-I Suppose You Aren't Aware [15146868].mkv"], batch.Paths);

        var rename = Plan([$"{s01}/ep.mkv", $"{s02}/ep.mkv"], "D:/Torrents/Anime/Solo Leveling");
        Assert.Empty(rename!.Roots);
        Assert.Equal(["Season 01/ep.mkv", "Season 02/ep.mkv"], rename.Paths);
        Assert.StartsWith("renamed ", rename.Describe());
    }

    [Theory]
    [InlineData("Season 01")]
    [InlineData("S01")]
    [InlineData("Specials")]
    [InlineData("BDMV")]
    [InlineData("Show S01-S02 1080p x265")]
    [InlineData("Show S01 S03 1080p x265")]
    [InlineData("The Show S2")]
    [InlineData("Behind The Scenes")]
    [InlineData("Some Film 1998 1080p x265")]
    public void SeasonRenameLeavesAmbiguousFolders(string folder) => Assert.Null(ContentLayoutPolicy.SeasonFolderRename(folder));

    [Theory]
    [InlineData("Some Show S03 1080p WEB-DL x265-GRP", "Season 03")]
    [InlineData("Solo Leveling S01 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER", "Season 01")]
    [InlineData("Show Season 4 1080p BluRay", "Season 04")]
    public void SeasonRenameNamesTheSeason(string folder, string expected) => Assert.Equal(expected, ContentLayoutPolicy.SeasonFolderRename(folder));

    [Theory]
    [InlineData("CON", false)]
    [InlineData("nul.txt", false)]
    [InlineData("Show/COM1/ep.mkv", false)]
    [InlineData("lpt9.mkv", false)]
    [InlineData("Release./ep.mkv", false)]
    [InlineData("Release /ep.mkv", false)]
    [InlineData("ep?.mkv", false)]
    [InlineData("Season 01/Show S01E01.mkv", true)]
    [InlineData("CONSOLE/ep.mkv", true)]
    [InlineData("..hidden/ep.mkv", true)]
    public void WindowsPathValidity(string path, bool valid) => Assert.Equal(valid, CompletedLayoutFinalizer.IsValidWindowsPath(path));

    [Theory]
    [InlineData("Torrent Downloaded From ExtraTorrent.cc.txt", true)]
    [InlineData("Release/Torrent_Downloaded_From_1337x.txt", true)]
    [InlineData("RARBG.txt", true)]
    [InlineData("rarbg.com.txt", true)]
    [InlineData("readme.txt", false)]
    [InlineData("Torrent Downloaded From X.mkv", false)]
    public void TrackerSpamIsJunk(string path, bool junk) => Assert.Equal(junk, CompletedLayoutFinalizer.IsJunk(path));
}
