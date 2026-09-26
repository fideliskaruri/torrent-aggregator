using static TorrentFlow.Engine.Tests.LayoutFinalizerTests;
using TorrentFlow.Engine.Layout;

namespace TorrentFlow.Engine.Tests;

/// <summary>
/// The owner's report: episodes ended up in <c>Season 01/&lt;release&gt;/&lt;video&gt;</c>. Realistic releases, each
/// carrying the sample, nfo and Subs every scene/P2P episode ships with, flattened into one season folder.
/// </summary>
public class SeasonLayoutReproTests
{
    private static string Dest(EngineHarness h, params string[] parts) => Path.Combine([h.Root, "downloads", .. parts]);

    private static (string, int)[] Episode(int e, int size = 100) =>
    [
        ($"The.Show.S01E0{e}.1080p.WEB.h264-GRP.mkv", size + e),
        ("Sample/sample.mkv", 7),
        ("The.Show.1080p.WEB.h264-GRP.nfo", 3),
        ("Subs/English.srt", 5 + e),
        ("Screens/screen01.jpg", 4),
    ];

    private static List<string> Tree(string root) =>
        Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(root, f).Replace('\\', '/')).Order(StringComparer.Ordinal).ToList();

    [Fact]
    public async Task ThreeEpisodeReleasesAllLandDirectlyInTheSeasonFolder()
    {
        await using var h = await EngineHarness.CreateAsync();
        var log = new ListLogger<CompletedLayoutFinalizer>();
        var f = NewFinalizer(log);
        var dest = Dest(h, "TV", "The Show", "Season 01");
        for (var e = 1; e <= 3; e++)
            await SeedCompletedAsync(h, e, dest, $"The.Show.S01E0{e}.1080p.WEB.h264-GRP", Episode(e));

        for (var e = 1; e <= 3; e++) Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, f, e));

        var tree = Tree(dest);
        for (var e = 1; e <= 3; e++)
        {
            Assert.Contains($"The.Show.S01E0{e}.1080p.WEB.h264-GRP.mkv", tree);
            // A per-episode release's Subs belong to its one video: named after it, next to it.
            Assert.Contains($"The.Show.S01E0{e}.1080p.WEB.h264-GRP.English.srt", tree);
            Assert.False(Directory.Exists(Path.Combine(dest, $"The.Show.S01E0{e}.1080p.WEB.h264-GRP")), $"E0{e} release folder remains");
        }
        // Extras every release carries are kept, per release, never over each other.
        Assert.Contains("Sample/sample.mkv", tree);
        Assert.Contains("Sample/The.Show.S01E02.1080p.WEB.h264-GRP/sample.mkv", tree);
        Assert.Contains("Sample/The.Show.S01E03.1080p.WEB.h264-GRP/sample.mkv", tree);
        Assert.Contains("The.Show.1080p.WEB.h264-GRP.nfo", tree);
        Assert.Contains("The.Show.S01E02.1080p.WEB.h264-GRP.The.Show.1080p.WEB.h264-GRP.nfo", tree);
        Assert.Contains("The.Show.S01E03.1080p.WEB.h264-GRP.The.Show.1080p.WEB.h264-GRP.nfo", tree);
        Assert.Contains("Screens/The.Show.S01E03.1080p.WEB.h264-GRP/screen01.jpg", tree);
        Assert.Equal(15, tree.Count);
        for (var e = 1; e <= 3; e++)
            Assert.All(await ManifestAsync(h, e), m => Assert.True(File.Exists(m.FullPath), m.FullPath));
        Assert.Equal(Path.Combine(dest, "The.Show.S01E02.1080p.WEB.h264-GRP.mkv"), (await ManifestAsync(h, 2))[0].FullPath);
    }

    [Fact]
    public async Task ASeasonPackWithEpisodeFoldersIsFlattened()
    {
        await using var h = await EngineHarness.CreateAsync();
        var dest = Dest(h, "TV", "The Show", "Season 01");
        var files = new List<(string, int)>();
        for (var e = 1; e <= 3; e++)
        {
            var ep = $"The.Show.S01E0{e}.1080p.BluRay.x264-GRP";
            files.Add(($"{ep}/{ep}.mkv", 100 + e));
            files.Add(($"{ep}/Sample/sample.mkv", 7));
            files.Add(($"{ep}/{ep}.nfo", 2));
            files.Add(($"{ep}/Subs/English.srt", 5));
        }
        await SeedCompletedAsync(h, 1, dest, "The.Show.S01.1080p.BluRay.x264-GRP", [.. files]);

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, NewFinalizer(new()), 1));

        var tree = Tree(dest);
        for (var e = 1; e <= 3; e++)
        {
            var ep = $"The.Show.S01E0{e}.1080p.BluRay.x264-GRP";
            Assert.Contains($"{ep}.mkv", tree);
            Assert.Contains($"{ep}.nfo", tree);
            Assert.Contains($"{ep}.English.srt", tree);
            Assert.False(Directory.Exists(Path.Combine(dest, ep)));
        }
        Assert.Equal(12, tree.Count);
    }

    [Fact]
    public async Task AMultiSeasonPackInTheShowFolderGetsFlatSeasonFolders()
    {
        await using var h = await EngineHarness.CreateAsync();
        var dest = Dest(h, "TV", "The Show");
        const string pack = "The.Show.S01-S02.1080p.WEB-DL.x265-GRP";
        await SeedCompletedAsync(h, 1, dest, pack,
            ("The.Show.S01.1080p.WEB-DL.x265-GRP/The.Show.S01E01.1080p.WEB-DL.x265-GRP/The.Show.S01E01.mkv", 10),
            ("The.Show.S01.1080p.WEB-DL.x265-GRP/The.Show.S01E02.1080p.WEB-DL.x265-GRP/The.Show.S01E02.mkv", 11),
            ("The.Show.S02.1080p.WEB-DL.x265-GRP/The.Show.S02E01.1080p.WEB-DL.x265-GRP/The.Show.S02E01.mkv", 12),
            ("The.Show.S02.1080p.WEB-DL.x265-GRP/The.Show.S02E01.1080p.WEB-DL.x265-GRP/Sample/sample.mkv", 3));

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, NewFinalizer(new()), 1));

        var tree = Tree(dest);
        Assert.Contains("Season 01/The.Show.S01E01.mkv", tree);
        Assert.Contains("Season 01/The.Show.S01E02.mkv", tree);
        Assert.Contains("Season 02/The.Show.S02E01.mkv", tree);
        Assert.Contains("Season 02/Sample/sample.mkv", tree);
        Assert.Equal(4, tree.Count);
    }

    [Fact]
    public async Task ASingleFileTorrentIsAlreadyFlat()
    {
        await using var h = await EngineHarness.CreateAsync();
        var dest = Dest(h, "TV", "The Show", "Season 01");
        await SeedCompletedAsync(h, 1, dest, null, ("The.Show.S01E04.1080p.WEB.h264-GRP.mkv", 10));
        Assert.Equal(LayoutOutcome.Unchanged, await FinalizeAsync(h, NewFinalizer(new()), 1));
        Assert.Equal(["The.Show.S01E04.1080p.WEB.h264-GRP.mkv"], Tree(dest));
    }

    [Fact]
    public async Task AFolderHoldingOneVideoIsFlattened()
    {
        await using var h = await EngineHarness.CreateAsync();
        var dest = Dest(h, "TV", "The Show", "Season 01");
        await SeedCompletedAsync(h, 1, dest, "The.Show.S01E05.1080p.WEB.h264-GRP", ("The.Show.S01E05.1080p.WEB.h264-GRP.mkv", 10));
        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, NewFinalizer(new()), 1));
        Assert.Equal(["The.Show.S01E05.1080p.WEB.h264-GRP.mkv"], Tree(dest));
    }

    [Fact]
    public async Task OnlyAConflictingVideoKeepsItsReleaseFolder()
    {
        await using var h = await EngineHarness.CreateAsync();
        var log = new ListLogger<CompletedLayoutFinalizer>();
        var f = NewFinalizer(log);
        var dest = Dest(h, "TV", "The Show", "Season 01");
        await SeedCompletedAsync(h, 1, dest, "The.Show.S01E01.720p.WEB.h264-AAA", ("The.Show.S01E01.mkv", 10), ("Sample/sample.mkv", 2));
        // A different release of the same episode with the same file name: never merged onto the first.
        await SeedCompletedAsync(h, 2, dest, "The.Show.S01E01.1080p.WEB.h264-BBB", ("The.Show.S01E01.mkv", 20), ("Sample/sample.mkv", 2));

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, f, 1));
        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, f, 2));

        Assert.Equal(10, new FileInfo(Path.Combine(dest, "The.Show.S01E01.mkv")).Length);
        Assert.Equal(20, new FileInfo(Path.Combine(dest, "The.Show.S01E01.1080p.WEB.h264-BBB", "The.Show.S01E01.mkv")).Length);
        Assert.True(File.Exists(Path.Combine(dest, "Sample", "The.Show.S01E01.1080p.WEB.h264-BBB", "sample.mkv")));
        Assert.True(log.Has($"[content-layout] keeping \"The.Show.S01E01.mkv\" in its release folder — it belongs to torrent {EngineHarness.Hash(1)[..8]}"));
    }

    [Fact]
    public async Task TidyingAgainAfterTheConflictIsGoneFinishesTheJob()
    {
        await using var h = await EngineHarness.CreateAsync();
        var f = NewFinalizer(new());
        var dest = Dest(h, "TV", "The Show", "Season 01");
        Directory.CreateDirectory(dest);
        await File.WriteAllBytesAsync(Path.Combine(dest, "The.Show.S01E01.mkv"), new byte[3]);
        await SeedCompletedAsync(h, 1, dest, "The.Show.S01E01.1080p.WEB.h264-BBB", ("The.Show.S01E01.mkv", 20), ("x.nfo", 2));

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, f, 1));
        Assert.True(File.Exists(Path.Combine(dest, "The.Show.S01E01.1080p.WEB.h264-BBB", "The.Show.S01E01.mkv")));
        Assert.True(File.Exists(Path.Combine(dest, "x.nfo")));

        File.Delete(Path.Combine(dest, "The.Show.S01E01.mkv"));
        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, f, 1));
        Assert.Equal(20, new FileInfo(Path.Combine(dest, "The.Show.S01E01.mkv")).Length);
        Assert.False(Directory.Exists(Path.Combine(dest, "The.Show.S01E01.1080p.WEB.h264-BBB")));
        Assert.Equal(LayoutOutcome.Unchanged, await FinalizeAsync(h, f, 1));
    }
}
