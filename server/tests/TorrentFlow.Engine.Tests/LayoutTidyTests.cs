using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Layout;
using static TorrentFlow.Engine.Tests.LayoutFinalizerTests;

namespace TorrentFlow.Engine.Tests;

/// <summary>The owner's "Tidy folders" action over downloads that finished before per-file layout existed.</summary>
public sealed class LayoutTidyTests
{
    private static string Season(EngineHarness h) => Path.Combine(h.Root, "downloads", "TV", "The Show", "Season 01");

    private static async Task SeedNestedEpisodeAsync(EngineHarness h, int n, string dest)
    {
        var release = $"The.Show.S01E0{n}.1080p.WEB.x264-GRP";
        await SeedCompletedAsync(h, n, dest, release,
            ($"The.Show.S01E0{n}.1080p.WEB.x264-GRP.mkv", 100 + n), ("Sample/sample.mkv", 7), ($"{release}.nfo", 3), ("Subs/English.srt", 5));
    }

    [Fact]
    public async Task NestedEpisodesFromOldDownloadsMoveIntoTheSeasonFolderAndStayStreamable()
    {
        var log = new ListLogger<CompletedLayoutFinalizer>();
        await using var h = await EngineHarness.CreateAsync(layout: NewFinalizer(log));
        var dest = Season(h);
        for (var n = 1; n <= 3; n++) await SeedNestedEpisodeAsync(h, n, dest);

        var result = await h.Engine.TidyAsync(CancellationToken.None);

        Assert.Equal(new LayoutTidyResult(3, 3, 12, 0, 0), result);
        for (var n = 1; n <= 3; n++)
        {
            var video = Path.Combine(dest, $"The.Show.S01E0{n}.1080p.WEB.x264-GRP.mkv");
            Assert.True(File.Exists(video));
            Assert.True(File.Exists(Path.Combine(dest, $"The.Show.S01E0{n}.1080p.WEB.x264-GRP.English.srt")));
            Assert.False(Directory.Exists(Path.Combine(dest, $"The.Show.S01E0{n}.1080p.WEB.x264-GRP")));
            Assert.Equal(video, (await ManifestAsync(h, n))[0].FullPath);
            await using var stream = await h.Engine.OpenFileStreamAsync(EngineHarness.Hash(n), "0");
            Assert.Equal(100 + n, stream.Length);
        }
        Assert.True(File.Exists(Path.Combine(dest, "Sample", "sample.mkv")));
        Assert.True(File.Exists(Path.Combine(dest, "Sample", "The.Show.S01E02.1080p.WEB.x264-GRP", "sample.mkv")));
        Assert.True(File.Exists(Path.Combine(dest, "Sample", "The.Show.S01E03.1080p.WEB.x264-GRP", "sample.mkv")));

        Assert.Equal(new LayoutTidyResult(3, 0, 0, 0, 0), await h.Engine.TidyAsync(CancellationToken.None));
    }

    [Fact]
    public async Task ReleasesAnEarlierLayoutAlreadyUnwrappedAreFinished()
    {
        var log = new ListLogger<CompletedLayoutFinalizer>();
        await using var h = await EngineHarness.CreateAsync(layout: NewFinalizer(log));
        var s1 = Season(h);
        var s2 = Path.Combine(h.Root, "downloads", "TV", "The Show", "Season 02");
        // What the old layout left behind: the wrapper dropped, a season pack's episode folders and a Subs folder kept.
        await SeedCompletedAsync(h, 1, s1, null, ("The.Show.S01E01.WEB.mkv", 10), ("Subs/English.srt", 2));
        await SeedCompletedAsync(h, 2, s2, null,
            ("The.Show.S02E01.WEB/The.Show.S02E01.WEB.mkv", 11), ("The.Show.S02E01.WEB/Subs/English.srt", 3),
            ("The.Show.S02E02.WEB/The.Show.S02E02.WEB.mkv", 12), ("The.Show.S02E02.WEB/Subs/English.srt", 4));

        var result = await h.Engine.TidyAsync(CancellationToken.None);

        Assert.Equal(new LayoutTidyResult(2, 2, 5, 0, 0), result);
        Assert.True(File.Exists(Path.Combine(s1, "The.Show.S01E01.WEB.mkv")));
        Assert.True(File.Exists(Path.Combine(s1, "The.Show.S01E01.WEB.English.srt")));
        Assert.False(Directory.Exists(Path.Combine(s1, "Subs")));
        Assert.Equal(["The.Show.S02E01.WEB.English.srt", "The.Show.S02E01.WEB.mkv", "The.Show.S02E02.WEB.English.srt", "The.Show.S02E02.WEB.mkv"],
            Directory.EnumerateFileSystemEntries(s2).Select(p => Path.GetFileName(p)!).Order(StringComparer.Ordinal).ToArray());
        Assert.Equal(new LayoutTidyResult(2, 0, 0, 0, 0), await h.Engine.TidyAsync(CancellationToken.None));
    }

    [Fact]
    public async Task ATransferTheClientHoldsOrAReaderHasOpenIsLeftAlone()
    {
        var log = new ListLogger<CompletedLayoutFinalizer>();
        await using var h = await EngineHarness.CreateAsync(layout: NewFinalizer(log));
        var dest = Season(h);
        for (var n = 1; n <= 3; n++) await SeedNestedEpisodeAsync(h, n, dest);
        h.Backend.Live[EngineHarness.Hash(1)] = new BackendSnapshot(EngineHarness.Hash(1), "x", 1, 0, 0, 0, 0, "complete", true, dest, [], null);
        await using var reader = await h.Engine.OpenFileStreamAsync(EngineHarness.Hash(2), "0");

        var result = await h.Engine.TidyAsync(CancellationToken.None);

        Assert.Equal(3, result.Checked);
        Assert.Equal(1, result.Tidied);
        Assert.Equal(2, result.Skipped);
        Assert.True(File.Exists(Path.Combine(dest, "The.Show.S01E01.1080p.WEB.x264-GRP", "The.Show.S01E01.1080p.WEB.x264-GRP.mkv")));
        Assert.True(File.Exists(Path.Combine(dest, "The.Show.S01E02.1080p.WEB.x264-GRP", "The.Show.S01E02.1080p.WEB.x264-GRP.mkv")));
        Assert.True(File.Exists(Path.Combine(dest, "The.Show.S01E03.1080p.WEB.x264-GRP.mkv")));
    }

    [Fact]
    public async Task AVideoAnotherDownloadOwnsIsCountedAsStillNested()
    {
        var log = new ListLogger<CompletedLayoutFinalizer>();
        await using var h = await EngineHarness.CreateAsync(layout: NewFinalizer(log));
        var dest = Season(h);
        await SeedCompletedAsync(h, 1, dest, null, ("The.Show.S01E01.mkv", 10));
        await SeedCompletedAsync(h, 2, dest, "The.Show.S01E01.PROPER.WEB", ("The.Show.S01E01.mkv", 12), ("proper.nfo", 1));

        var result = await h.Engine.TidyAsync(CancellationToken.None);

        Assert.Equal(new LayoutTidyResult(2, 1, 1, 1, 0), result);
        Assert.Equal(10, new FileInfo(Path.Combine(dest, "The.Show.S01E01.mkv")).Length);
        Assert.Equal(12, new FileInfo(Path.Combine(dest, "The.Show.S01E01.PROPER.WEB", "The.Show.S01E01.mkv")).Length);
        Assert.True(log.Has($"keeping \"The.Show.S01E01.mkv\" in its release folder — it belongs to torrent {EngineHarness.Hash(1)[..8]}"));
    }

    [FfprobeFact]
    public async Task TidyDoesNotReprobeAnAcceptedDownload()
    {
        var log = new ListLogger<CompletedLayoutFinalizer>();
        await using var h = await EngineHarness.CreateAsync(layout: NewFinalizer(log, FfprobeFactAttribute.Ffprobe));
        var dest = Season(h);
        await SeedCompletedAsync(h, 1, dest, "Show.S01E01.1080p.WEB", ("Show.S01E01.mkv", 4096), ("Show.S01E01.nfo", 1));

        Assert.Equal(new LayoutTidyResult(1, 1, 2, 0, 0), await h.Engine.TidyAsync(CancellationToken.None));

        var row = await h.RowAsync(1);
        Assert.Equal("parked", row.Status);
        Assert.NotNull(row.VerifiedAt);
        Assert.True(File.Exists(Path.Combine(dest, "Show.S01E01.mkv")));
    }
}
