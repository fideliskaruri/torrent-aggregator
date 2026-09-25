using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine.Tests;

/// <summary>Parity with src/lib/clients/release-file-removal.test.ts, plus the on-disk delete the Downloads page runs.</summary>
public sealed class ReleaseFileRemovalTests : IDisposable
{
    private readonly string _root = EngineHarness.NewRoot();
    private string Base => Path.Combine(_root, "downloads");
    private string P(params string[] parts) => Path.Combine([Base, .. parts]);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch (IOException) { }
    }

    [Fact]
    public void AReleasesOwnFolderIsRemovable()
    {
        var plan = ReleaseFileRemoval.Plan([P("Movies", "Sintel", "Sintel.mp4"), P("Movies", "Sintel", "Subs", "en.srt")],
            P("Movies", "Sintel"), Base, []);
        Assert.Equal(P("Movies", "Sintel"), plan.Folder);
        Assert.Equal(2, plan.Files.Count);
    }

    [Fact]
    public void ASharedShowFolderKeepsItsSiblings()
    {
        var plan = ReleaseFileRemoval.Plan([P("TV", "Show", "Season 01", "e1.mkv")], P("TV", "Show", "Season 01"), Base,
            [P("TV", "Show", "Season 01", "e2.mkv")]);
        Assert.Null(plan.Folder);
        Assert.Equal("folder is shared with another download", plan.FolderReason);
    }

    [Fact]
    public void TheRootAndCategoryFoldersAreNeverTaken()
    {
        Assert.Null(ReleaseFileRemoval.Plan([P("a.mkv")], Base, Base, []).Folder);
        Assert.Equal("folder is a category folder", ReleaseFileRemoval.Plan([P("Other", "a.mkv")], P("Other"), Base, []).FolderReason);
        // A multi-file release's own container under a category save path is its own.
        Assert.Equal(P("Other", "Pack"), ReleaseFileRemoval.Plan([P("Other", "Pack", "a.mkv"), P("Other", "Pack", "b.mkv")], P("Other"), Base, []).Folder);
    }

    [Fact]
    public void FilesOutsideTheSavePathAndRootAreRefused()
    {
        var outside = Path.Combine(_root, "elsewhere", "x.mkv");
        var plan = ReleaseFileRemoval.Plan([outside], P("Movies", "X"), Base, []);
        Assert.Empty(plan.Files);
        Assert.Null(plan.Folder);
    }

    [Fact]
    public void DeleteTakesTheReleaseFolderJunkAndEmptyParentsButNotTheRoot()
    {
        var media = P("Movies", "Sintel", "Sintel.mp4");
        var srt = P("Movies", "Sintel", "Subs", "rum.srt");
        var junk = P("Movies", "Sintel", "www.YTS.MX.jpg");
        foreach (var f in new[] { media, srt, junk })
        {
            Directory.CreateDirectory(Path.GetDirectoryName(f)!);
            File.WriteAllBytes(f, [1]);
        }
        File.WriteAllBytes(media + ".part", [1]);

        TorrentEngineService.DeleteReleaseFiles([media, srt], P("Movies", "Sintel"), Base, []);

        Assert.False(Directory.Exists(P("Movies", "Sintel")));
        Assert.False(Directory.Exists(P("Movies")));
        Assert.True(Directory.Exists(Base));
    }

    [Fact]
    public void DeleteInACategoryFolderLeavesUnrelatedFiles()
    {
        var media = P("Other", "a.mkv");
        var mine = P("Other", "notes.txt");
        Directory.CreateDirectory(P("Other"));
        File.WriteAllBytes(media, [1]);
        File.WriteAllBytes(mine, [1]);

        TorrentEngineService.DeleteReleaseFiles([media], P("Other"), Base, []);

        Assert.False(File.Exists(media));
        Assert.True(File.Exists(mine));
    }

    [Fact]
    public void DeleteNeverRemovesASiblingReleasesFiles()
    {
        var mine = P("TV", "Show", "Season 01", "e1.mkv");
        var theirs = P("TV", "Show", "Season 01", "e2.mkv");
        Directory.CreateDirectory(Path.GetDirectoryName(mine)!);
        File.WriteAllBytes(mine, [1]);
        File.WriteAllBytes(theirs, [1]);

        TorrentEngineService.DeleteReleaseFiles([mine], P("TV", "Show", "Season 01"), Base, [theirs]);

        Assert.False(File.Exists(mine));
        Assert.True(File.Exists(theirs));
    }
}
