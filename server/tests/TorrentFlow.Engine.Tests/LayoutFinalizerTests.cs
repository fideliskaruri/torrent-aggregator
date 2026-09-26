using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Layout;
using ManifestFile = TorrentFlow.Engine.TorrentEngineService.ManifestFile;

namespace TorrentFlow.Engine.Tests;

/// <summary>
/// The completed-download finalizer on real temp directories and a real SQLite database: the scenarios of
/// scripts/e2e-content-layout.mts, plus collisions, junk, idempotency and Windows path edge cases.
/// </summary>
public class LayoutFinalizerTests
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    internal static CompletedLayoutFinalizer NewFinalizer(ListLogger<CompletedLayoutFinalizer> log, string? ffprobe = null) =>
        new(new CompletedMediaValidator(new FfprobeLocator(ffprobe), NullLogger<CompletedMediaValidator>.Instance), TimeProvider.System, log);

    /// <summary>Writes a completed download where MonoTorrent leaves it (<c>dest/container/path</c>) and its parked row.</summary>
    internal static async Task SeedCompletedAsync(EngineHarness h, int n, string dest, string? container, params (string Path, int Size)[] files)
    {
        var manifest = new List<ManifestFile>();
        foreach (var (path, size) in files)
        {
            var full = Path.Combine(container is null ? [dest, .. path.Split('/')] : [dest, container, .. path.Split('/')]);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            await File.WriteAllBytesAsync(full, new byte[size]);
            manifest.Add(new ManifestFile(path, size, 0, full));
        }
        await using var db = await h.Db.CreateDbContextAsync();
        var now = DateTime.UtcNow;
        db.EngineTorrents.Add(new EngineTorrent
        {
            Id = Data.Ids.New(), UserId = Data.LocalUser.Id, Hash = EngineHarness.Hash(n), Name = container ?? files[0].Path,
            Magnet = EngineHarness.Magnet(n), Status = EngineTorrentStatus.Parked, Origin = "user", WorkId = "show",
            CreatedAt = now, UpdatedAt = now, LastUsedAt = now, SavePath = dest, Progress = 1, VerifiedAt = now,
            VerifiedFilesJson = JsonSerializer.Serialize(manifest, Web),
        });
        await db.SaveChangesAsync();
    }

    internal static async Task<LayoutOutcome> FinalizeAsync(EngineHarness h, CompletedLayoutFinalizer f, int n)
    {
        await using var db = await h.Db.CreateDbContextAsync();
        var row = await db.EngineTorrents.SingleAsync(r => r.Hash == EngineHarness.Hash(n));
        return await f.FinalizeAsync(db, row, CancellationToken.None);
    }

    internal static async Task<List<ManifestFile>> ManifestAsync(EngineHarness h, int n) =>
        JsonSerializer.Deserialize<List<ManifestFile>>((await h.RowAsync(n)).VerifiedFilesJson!, Web)!;

    private static string Dest(EngineHarness h, params string[] parts) => Path.Combine([h.Root, "downloads", .. parts]);

    [Fact]
    public async Task DoubleWrappedPackLandsInTheSeasonFolder()
    {
        await using var h = await EngineHarness.CreateAsync();
        var log = new ListLogger<CompletedLayoutFinalizer>();
        const string outer = "Solo Leveling 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
        const string inner = "Solo Leveling S01 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
        var dest = Dest(h, "Anime", "Solo Leveling", "Season 01");
        await SeedCompletedAsync(h, 1, dest, outer, ($"{inner}/S01E01.mkv", 10), ($"{inner}/S01E02.mkv", 11), ($"{inner}/Subs/S01E01.eng.srt", 3));

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, NewFinalizer(log), 1));

        Assert.True(File.Exists(Path.Combine(dest, "S01E01.mkv")));
        Assert.True(File.Exists(Path.Combine(dest, "S01E02.mkv")));
        Assert.True(File.Exists(Path.Combine(dest, "S01E01.eng.srt")), "a subtitle named after its episode sits beside it");
        Assert.False(Directory.Exists(Path.Combine(dest, outer)), "the emptied wrappers are removed");
        var manifest = await ManifestAsync(h, 1);
        Assert.Equal(Path.Combine(dest, "S01E02.mkv"), manifest[1].FullPath);
        Assert.Equal($"{inner}/S01E02.mkv", manifest[1].Path);
        Assert.True(log.Has($"[content-layout] {outer} → {dest}: removed 2 wrapper folders"));
    }

    [Fact]
    public async Task SingleRootMovieKeepsItsExtras()
    {
        await using var h = await EngineHarness.CreateAsync();
        var dest = Dest(h, "Movies", "Dune Part Two");
        await SeedCompletedAsync(h, 1, dest, "Dune Part Two (2024) [2160p] [4K] [WEB] [5.1] [YTS.MX]",
            ("Dune.Part.Two.2024.2160p.4K.WEB.x265.10bit.AAC5.1-[YTS.MX].mp4", 20), ("www.YTS.MX.jpg", 2));

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, NewFinalizer(new()), 1));
        Assert.True(File.Exists(Path.Combine(dest, "Dune.Part.Two.2024.2160p.4K.WEB.x265.10bit.AAC5.1-[YTS.MX].mp4")));
        Assert.True(File.Exists(Path.Combine(dest, "www.YTS.MX.jpg")));
    }

    [Fact]
    public async Task DvdStructureIsPreserved()
    {
        await using var h = await EngineHarness.CreateAsync();
        var dest = Dest(h, "Movies", "Some Film");
        await SeedCompletedAsync(h, 1, dest, "Some Film 1998 DVD", ("VIDEO_TS/VIDEO_TS.IFO", 1), ("VIDEO_TS/VTS_01_1.VOB", 5));

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, NewFinalizer(new()), 1));
        Assert.True(File.Exists(Path.Combine(dest, "VIDEO_TS", "VIDEO_TS.IFO")));
        Assert.True(File.Exists(Path.Combine(dest, "VIDEO_TS", "VTS_01_1.VOB")));
    }

    [Fact]
    public async Task ASingleFileTorrentAndABlurayRootAreUnchanged()
    {
        await using var h = await EngineHarness.CreateAsync();
        var dest = Dest(h, "Movies", "X");
        await SeedCompletedAsync(h, 1, dest, null, ("Some.Movie.2024.mkv", 5));
        await SeedCompletedAsync(h, 2, dest, "BDMV", ("index.bdmv", 1), ("STREAM/00001.m2ts", 5));
        var f = NewFinalizer(new());
        Assert.Equal(LayoutOutcome.Unchanged, await FinalizeAsync(h, f, 1));
        Assert.Equal(LayoutOutcome.Unchanged, await FinalizeAsync(h, f, 2));
        Assert.True(File.Exists(Path.Combine(dest, "BDMV", "STREAM", "00001.m2ts")));
    }

    [Fact]
    public async Task SecondReleaseInTheSameSeasonMovesAnExtraTheFirstOwnsAside()
    {
        await using var h = await EngineHarness.CreateAsync();
        var log = new ListLogger<CompletedLayoutFinalizer>();
        var f = NewFinalizer(log);
        var dest = Dest(h, "TV", "Show", "Season 03");
        await SeedCompletedAsync(h, 1, dest, "Show.S03E01.1080p.WEB", ("Show.S03E01.mkv", 10), ("Screens/s1.png", 4));
        await SeedCompletedAsync(h, 2, dest, "Show.S03E02.1080p.WEB", ("Show.S03E02.mkv", 12), ("Screens/s1.png", 4));

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, f, 1));
        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, f, 2));

        Assert.True(File.Exists(Path.Combine(dest, "Show.S03E01.mkv")));
        Assert.True(File.Exists(Path.Combine(dest, "Screens", "s1.png")));
        Assert.True(File.Exists(Path.Combine(dest, "Show.S03E02.mkv")));
        Assert.True(File.Exists(Path.Combine(dest, "Screens", "Show.S03E02.1080p.WEB", "s1.png")));
        Assert.False(Directory.Exists(Path.Combine(dest, "Show.S03E02.1080p.WEB")));
        Assert.True(log.Has($"[content-layout] \"Screens/s1.png\" would collide (it belongs to torrent {EngineHarness.Hash(1)[..8]}); moved it to \"Screens/Show.S03E02.1080p.WEB/s1.png\""));
        Assert.Equal(Path.Combine(dest, "Show.S03E02.mkv"), (await ManifestAsync(h, 2))[0].FullPath);
        Assert.Equal(Path.Combine(dest, "Screens", "Show.S03E02.1080p.WEB", "s1.png"), (await ManifestAsync(h, 2))[1].FullPath);
    }

    [Fact]
    public async Task AnUnclaimedFileOfADifferentSizeKeepsTheReleaseFolder()
    {
        await using var h = await EngineHarness.CreateAsync();
        var log = new ListLogger<CompletedLayoutFinalizer>();
        var dest = Dest(h, "Movies", "X");
        Directory.CreateDirectory(dest);
        await File.WriteAllBytesAsync(Path.Combine(dest, "movie.mkv"), new byte[3]);
        await SeedCompletedAsync(h, 1, dest, "X.2024.1080p.WEB", ("movie.mkv", 10), ("movie.nfo", 1));

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, NewFinalizer(log), 1));
        Assert.True(log.Has("[content-layout] keeping \"movie.mkv\" in its release folder — a file of a different size is already there"));
        Assert.Equal(3, new FileInfo(Path.Combine(dest, "movie.mkv")).Length);
        Assert.True(File.Exists(Path.Combine(dest, "X.2024.1080p.WEB", "movie.mkv")));
        Assert.True(File.Exists(Path.Combine(dest, "movie.nfo")), "only the colliding video stays nested");
    }

    [Fact]
    public async Task AnUnclaimedFileOfTheSameSizeIsReplacedByTheVerifiedCopy()
    {
        await using var h = await EngineHarness.CreateAsync();
        var dest = Dest(h, "Movies", "X");
        Directory.CreateDirectory(dest);
        await File.WriteAllBytesAsync(Path.Combine(dest, "movie.mkv"), Enumerable.Repeat((byte)7, 10).ToArray());
        await SeedCompletedAsync(h, 1, dest, "X.2024.1080p.WEB", ("movie.mkv", 10), ("movie.nfo", 1));

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, NewFinalizer(new()), 1));
        Assert.All(await File.ReadAllBytesAsync(Path.Combine(dest, "movie.mkv")), b => Assert.Equal(0, b));
        Assert.Empty(Directory.EnumerateFiles(dest, "*.tflayout*", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task ADirectoryInTheWayKeepsTheReleaseFolder()
    {
        await using var h = await EngineHarness.CreateAsync();
        var log = new ListLogger<CompletedLayoutFinalizer>();
        var dest = Dest(h, "Movies", "X");
        Directory.CreateDirectory(Path.Combine(dest, "movie.mkv"));
        await SeedCompletedAsync(h, 1, dest, "X.2024.1080p.WEB", ("movie.mkv", 10), ("movie.nfo", 1));

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, NewFinalizer(log), 1));
        Assert.True(log.Has("keeping \"movie.mkv\" in its release folder — a directory is in the way"));
        Assert.True(File.Exists(Path.Combine(dest, "X.2024.1080p.WEB", "movie.mkv")));
        Assert.True(Directory.Exists(Path.Combine(dest, "movie.mkv")));
    }

    [Fact]
    public async Task TrackerSpamNeverBlocksAndADuplicateIsDiscarded()
    {
        await using var h = await EngineHarness.CreateAsync();
        var log = new ListLogger<CompletedLayoutFinalizer>();
        var f = NewFinalizer(log);
        var dest = Dest(h, "TV", "Show", "Season 01");
        const string spam = "Torrent Downloaded From ExtraTorrent.cc.txt";
        await SeedCompletedAsync(h, 1, dest, "Show.S01E01.1080p.WEB", ("Show.S01E01.mkv", 10), (spam, 5));
        await SeedCompletedAsync(h, 2, dest, "Show.S01E02.1080p.WEB", ("Show.S01E02.mkv", 10), (spam, 9));

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, f, 1));
        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, f, 2));

        Assert.True(File.Exists(Path.Combine(dest, "Show.S01E02.mkv")));
        Assert.Equal(5, new FileInfo(Path.Combine(dest, spam)).Length);
        Assert.False(Directory.Exists(Path.Combine(dest, "Show.S01E02.1080p.WEB")));
        var second = await ManifestAsync(h, 2);
        Assert.Null(second[1].FullPath);
        Assert.Equal(Path.Combine(dest, spam), (await ManifestAsync(h, 1))[1].FullPath);
        Assert.True(log.Has($"[content-layout] dropped duplicate junk \"{spam}\""));
    }

    [Fact]
    public async Task FinalizingTwiceIsANoOp()
    {
        await using var h = await EngineHarness.CreateAsync();
        var f = NewFinalizer(new());
        var dest = Dest(h, "TV", "Show", "Season 02");
        await SeedCompletedAsync(h, 1, dest, "Show.S02.1080p.WEB-DL.x265-GRP", ("Show.S02E01.mkv", 10), ("Show.S02E02.mkv", 10));

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, f, 1));
        var once = (await h.RowAsync(1)).VerifiedFilesJson;
        Assert.Equal(LayoutOutcome.Unchanged, await FinalizeAsync(h, f, 1));
        Assert.Equal(once, (await h.RowAsync(1)).VerifiedFilesJson);
        Assert.True(File.Exists(Path.Combine(dest, "Show.S02E02.mkv")));
    }

    [Fact]
    public async Task ABatchUnderTheShowRootBecomesSeasonFolders()
    {
        await using var h = await EngineHarness.CreateAsync();
        var log = new ListLogger<CompletedLayoutFinalizer>();
        const string root = "Solo Leveling 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
        const string s01 = "Solo Leveling S01 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
        const string s02 = "Solo Leveling S02 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER";
        var dest = Dest(h, "Anime", "Solo Leveling");
        await SeedCompletedAsync(h, 1, dest, root, ($"{s01}/S01E01.mkv", 10), ($"{s02}/S02E01.mkv", 10));

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, NewFinalizer(log), 1));
        Assert.True(File.Exists(Path.Combine(dest, "Season 01", "S01E01.mkv")));
        Assert.True(File.Exists(Path.Combine(dest, "Season 02", "S02E01.mkv")));
        Assert.True(log.Has($"removed 1 wrapper folder; renamed {s01} → Season 01"));
    }

    [Fact]
    public async Task LongPathsAreLaidOut()
    {
        await using var h = await EngineHarness.CreateAsync();
        var dest = Dest(h, "TV", new string('S', 60), "Season 01");
        var release = "Show.S01.1080p.WEB-DL.x265-" + new string('G', 90);
        var deep = string.Join('/', Enumerable.Range(0, 3).Select(i => $"Extras {i} " + new string('e', 40)));
        await SeedCompletedAsync(h, 1, dest, release, ("Show.S01E01.mkv", 10), ($"{deep}/featurette.mkv", 4));
        Assert.True(Path.Combine(dest, release, deep, "featurette.mkv").Length > 260);

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, NewFinalizer(new()), 1));
        Assert.True(File.Exists(Path.Combine(dest, "Show.S01E01.mkv")));
        Assert.True(File.Exists(Path.Combine([dest, .. deep.Split('/'), "featurette.mkv"])));
        Assert.False(Directory.Exists(Path.Combine(dest, release)));
    }

    [Fact]
    public async Task AFileWhereAFolderIsNeededBlocks()
    {
        await using var h = await EngineHarness.CreateAsync();
        var log = new ListLogger<CompletedLayoutFinalizer>();
        var dest = Dest(h, "Movies", "X");
        Directory.CreateDirectory(dest);
        await File.WriteAllBytesAsync(Path.Combine(dest, "Subs"), new byte[1]);
        await File.WriteAllBytesAsync(Path.Combine(dest, "Screens"), new byte[1]);
        await SeedCompletedAsync(h, 1, dest, "X.2024.1080p.WEB", ("movie.mkv", 10), ("Subs/en.srt", 1), ("Screens/a.png", 1));

        Assert.Equal(LayoutOutcome.LaidOut, await FinalizeAsync(h, NewFinalizer(log), 1));
        // The one video's subtitle goes beside it, so a file named Subs no longer stands in the way.
        Assert.True(File.Exists(Path.Combine(dest, "movie.en.srt")));
        Assert.Equal(1, new FileInfo(Path.Combine(dest, "Subs")).Length);
        // An extra whose folder is a file, even under its per-release name, stays in the release folder.
        Assert.True(log.Has("keeping \"Screens/a.png\" in its release folder — a directory is in the way"));
        Assert.True(File.Exists(Path.Combine(dest, "X.2024.1080p.WEB", "Screens", "a.png")));
        Assert.True(File.Exists(Path.Combine(dest, "movie.mkv")));
    }

    [Fact]
    public async Task ALockedTargetRollsEverythingBack()
    {
        if (!OperatingSystem.IsWindows()) return;
        await using var h = await EngineHarness.CreateAsync();
        var log = new ListLogger<CompletedLayoutFinalizer>();
        var dest = Dest(h, "Movies", "X");
        await SeedCompletedAsync(h, 1, dest, "X.2024.1080p.WEB", ("movie.mkv", 10), ("movie.nfo", 1));
        var before = (await h.RowAsync(1)).VerifiedFilesJson;

        // An exclusive handle on the second source makes its rename fail after the first has moved.
        await using (new FileStream(Path.Combine(dest, "X.2024.1080p.WEB", "movie.nfo"), FileMode.Open, FileAccess.Read, FileShare.None))
            Assert.Equal(LayoutOutcome.Unchanged, await FinalizeAsync(h, NewFinalizer(log), 1));

        Assert.True(log.Has("[content-layout] rewrite failed"));
        Assert.True(File.Exists(Path.Combine(dest, "X.2024.1080p.WEB", "movie.mkv")));
        Assert.False(File.Exists(Path.Combine(dest, "movie.mkv")));
        Assert.Equal(before, (await h.RowAsync(1)).VerifiedFilesJson);
    }

    [Fact]
    public void NativeLayoutDetection()
    {
        static ManifestFile M(string p) => new(p, 1, 0, null);
        Assert.Empty(CompletedLayoutFinalizer.InferTorrentLayout([M("a.mkv")], ["a.mkv"])!.Pinned);
        Assert.Equal(["R/a.mkv"], CompletedLayoutFinalizer.InferTorrentLayout([M("a.mkv")], ["R/a.mkv"])!.Paths);
        var both = CompletedLayoutFinalizer.InferTorrentLayout([M("a.mkv"), M("s/b.srt")], ["R/a.mkv", "R/s/b.srt"])!;
        Assert.Equal(["R/a.mkv", "R/s/b.srt"], both.Paths);
        Assert.Empty(both.Pinned);
        // Already unwrapped by an earlier layout: each file sits at its torrent path directly in the save path.
        var flat = CompletedLayoutFinalizer.InferTorrentLayout([M("a.mkv"), M("s/b.srt")], ["a.mkv", "s/b.srt"])!;
        Assert.Equal(["a.mkv", "s/b.srt"], flat.Paths);
        Assert.Empty(flat.Pinned);
        Assert.Null(CompletedLayoutFinalizer.InferTorrentLayout([M("a.mkv"), M("s/b.srt")], ["x/y/a.mkv", null]));
        // One file laid out already, one still in the release folder: only the latter may move.
        var half = CompletedLayoutFinalizer.InferTorrentLayout([M("a.mkv"), M("s/b.srt")], ["R/a.mkv", "s/b.srt"])!;
        Assert.Equal("s/b.srt", Assert.Single(half.Pinned).Value);
        var discarded = CompletedLayoutFinalizer.InferTorrentLayout([M("a.mkv"), M("b.txt")], ["R/a.mkv", null])!;
        Assert.Null(Assert.Single(discarded.Pinned).Value);
    }

    // ---- engine integration: completion → layout, deferred behind an open stream

    private static EngineAddRequest Keep(int n) => new() { Magnet = EngineHarness.Magnet(n), Purpose = TorrentPurpose.Keep, WorkId = "show" };

    private static void UseReleaseFolder(EngineHarness h, int n, string release)
    {
        var s = h.Backend.Live[EngineHarness.Hash(n)];
        h.Backend.Live[s.Hash] = s with
        {
            Name = release,
            Files =
            [
                new BackendFile(0, "Show.S01E01.mkv", Path.Combine(s.SavePath, release, "Show.S01E01.mkv"), 10, true, 0),
                new BackendFile(1, "Show.S01E01.nfo", Path.Combine(s.SavePath, release, "Show.S01E01.nfo"), 1, true, 0),
            ],
        };
    }

    private static async Task WaitUntil(Func<Task<bool>> condition)
    {
        for (var i = 0; i < 200 && !await condition(); i++) await Task.Delay(25);
        Assert.True(await condition());
    }

    [Fact]
    public async Task CompletionLaysOutTheParkedDownload()
    {
        var log = new ListLogger<CompletedLayoutFinalizer>();
        await using var h = await EngineHarness.CreateAsync(layout: NewFinalizer(log));
        await h.Engine.AddAsync(Keep(1));
        UseReleaseFolder(h, 1, "Show.S01E01.1080p.WEB-GRP");
        var save = h.Backend.Live[EngineHarness.Hash(1)].SavePath;
        h.Backend.Complete(EngineHarness.Hash(1));

        await h.Engine.TickAsync();

        Assert.Equal("parked", (await h.RowAsync(1)).Status);
        Assert.True(File.Exists(Path.Combine(save, "Show.S01E01.mkv")));
        Assert.False(Directory.Exists(Path.Combine(save, "Show.S01E01.1080p.WEB-GRP")));
        Assert.Equal(Path.Combine(save, "Show.S01E01.mkv"), (await ManifestAsync(h, 1))[0].FullPath);

        await using var s = await h.Engine.OpenFileStreamAsync(EngineHarness.Hash(1), "0");
        Assert.Equal(10, s.Length);
    }

    [Fact]
    public async Task AnOpenStreamDefersTheLayoutUntilItCloses()
    {
        await using var h = await EngineHarness.CreateAsync(layout: NewFinalizer(new()));
        await h.Engine.AddAsync(Keep(1));
        UseReleaseFolder(h, 1, "Show.S01E01.1080p.WEB-GRP");
        var save = h.Backend.Live[EngineHarness.Hash(1)].SavePath;
        var stream = await h.Engine.OpenFileStreamAsync(EngineHarness.Hash(1), "0");
        h.Backend.Complete(EngineHarness.Hash(1));

        await h.Engine.TickAsync();
        Assert.True(File.Exists(Path.Combine(save, "Show.S01E01.1080p.WEB-GRP", "Show.S01E01.mkv")));

        await stream.DisposeAsync();
        await WaitUntil(() => Task.FromResult(File.Exists(Path.Combine(save, "Show.S01E01.mkv"))));
        await WaitUntil(async () => (await ManifestAsync(h, 1))[0].FullPath == Path.Combine(save, "Show.S01E01.mkv"));
    }
}
