using static TorrentFlow.Engine.Tests.LayoutFinalizerTests;
using TorrentFlow.Engine.Layout;

namespace TorrentFlow.Engine.Tests;

/// <summary>
/// Owner repro from prod: <c>C:\Torrents\TV\Rick and Morty\Season 01\</c> held seven site-prefixed wrapper folders
/// (<c>www.UIndex.org    -    Rick and Morty S01E01 ...</c>), one single-episode torrent each.
/// </summary>
public class SitePrefixedWrapperTests
{
    private static readonly string[] Titles = ["Pilot", "Lawnmower Dog", "Anatomy Park", "M Night Shaym-Aliens", "Meeseeks and Destroy", "Rick Potion 9", "Raising Gazorpazorp"];

    private static string Wrapper(int e) => $"www.UIndex.org    -    Rick and Morty S01E0{e} {Titles[e - 1]} 1080p BluRay x265 HEVC 10bit AAC 5.1";
    private static string Video(int e) => $"Rick and Morty S01E0{e} {Titles[e - 1]} 1080p BluRay x265 HEVC 10bit AAC 5.1.mkv";

    private static async Task<string> SeedAsync(EngineHarness h, bool siteNote = true)
    {
        var dest = Path.Combine(h.Root, "Torrents", "TV", "Rick and Morty", "Season 01");
        for (var e = 1; e <= 7; e++)
            if (siteNote) await SeedCompletedAsync(h, e, dest, Wrapper(e), (Video(e), 1000 + e), ("www.UIndex.org.txt", 12));
            else await SeedCompletedAsync(h, e, dest, Wrapper(e), (Video(e), 1000 + e));
        return dest;
    }

    private static void AssertFlat(string dest)
    {
        Assert.DoesNotContain(Directory.EnumerateDirectories(dest), d => Path.GetFileName(d).StartsWith("www.UIndex.org"));
        for (var e = 1; e <= 7; e++)
            Assert.Equal(1000 + e, new FileInfo(Path.Combine(dest, Video(e))).Length);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task EachEpisodeLandsDirectlyInTheSeasonFolderAtCompletion(bool siteNote)
    {
        await using var h = await EngineHarness.CreateAsync();
        var f = NewFinalizer(new ListLogger<CompletedLayoutFinalizer>());
        var dest = await SeedAsync(h, siteNote);

        for (var e = 1; e <= 7; e++) Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, f, e));

        AssertFlat(dest);
        for (var e = 1; e <= 7; e++) Assert.Equal(Path.Combine(dest, Video(e)), (await ManifestAsync(h, e))[0].FullPath);
    }

    [Fact]
    public async Task TidyFlattensExistingWrapperFolders()
    {
        await using var h = await EngineHarness.CreateAsync(layout: NewFinalizer(new ListLogger<CompletedLayoutFinalizer>()));
        var dest = await SeedAsync(h);

        var result = await h.Engine.TidyAsync(CancellationToken.None);

        Assert.Equal(7, result.Tidied);
        Assert.Equal(0, result.StillNested);
        AssertFlat(dest);
        for (var e = 1; e <= 7; e++)
        {
            await using var stream = await h.Engine.OpenFileStreamAsync(EngineHarness.Hash(e), "0");
            Assert.Equal(1000 + e, stream.Length);
        }
    }

    [Fact]
    public async Task TidyLeavesASeedingTorrentWhereItIs()
    {
        await using var h = await EngineHarness.CreateAsync(layout: NewFinalizer(new ListLogger<CompletedLayoutFinalizer>()));
        var dest = await SeedAsync(h);
        await using (var db = await h.Db.CreateDbContextAsync())
        {
            var row = db.EngineTorrents.Single(r => r.Hash == EngineHarness.Hash(1));
            row.Status = "seeding";
            await db.SaveChangesAsync();
        }

        var result = await h.Engine.TidyAsync(CancellationToken.None);

        Assert.Equal(6, result.Tidied);
        Assert.True(File.Exists(Path.Combine(dest, Wrapper(1), Video(1))));
        Assert.Equal(Path.Combine(dest, Wrapper(1), Video(1)), (await ManifestAsync(h, 1))[0].FullPath);
    }
}