using TorrentFlow.Engine.Layout;

namespace TorrentFlow.Engine.Tests;

/// <summary>A fact that is skipped when no ffprobe can be found (FFPROBE_PATH, node_modules/ffprobe-static, PATH).</summary>
public sealed class FfprobeFactAttribute : FactAttribute
{
    public static readonly string? Ffprobe = FfprobeLocator.Find(null, Environment.GetEnvironmentVariable(LayoutMediaOptions.FfprobeEnvVar),
        [AppContext.BaseDirectory, Environment.CurrentDirectory]);

    public FfprobeFactAttribute()
    {
        if (Ffprobe is null) Skip = "ffprobe not found (set FFPROBE_PATH to run)";
    }
}

public class LayoutFfprobeTests
{
    private static string? MediaFixture()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var f = Path.Combine(dir.FullName, "scripts", "probes", "player-screenshots", "media", "Demo Show S01E01 1080p WEB-DL H.264.mp4");
            if (File.Exists(f)) return f;
        }
        return null;
    }

    [Fact]
    public void ProbeOutputNeedsAVideoStream()
    {
        Assert.True(CompletedMediaValidator.HasVideoStream("""{"streams":[{"codec_type":"audio"},{"codec_type":"video"}]}"""));
        Assert.False(CompletedMediaValidator.HasVideoStream("""{"streams":[{"codec_type":"audio"}]}"""));
        Assert.False(CompletedMediaValidator.HasVideoStream("""{"streams":[]}"""));
        Assert.False(CompletedMediaValidator.HasVideoStream("{}"));
        Assert.False(CompletedMediaValidator.HasVideoStream("not json"));
    }

    [Fact]
    public void LocatorPrefersConfigThenEnvThenBundledBinary()
    {
        var root = EngineHarness.NewRoot();
        try
        {
            var configured = Path.Combine(root, "configured.exe");
            var env = Path.Combine(root, "env.exe");
            File.WriteAllBytes(configured, [0]);
            File.WriteAllBytes(env, [0]);
            Assert.Equal(configured, FfprobeLocator.Find(configured, env, []));
            Assert.Equal(env, FfprobeLocator.Find(Path.Combine(root, "missing.exe"), env, []));

            var platform = OperatingSystem.IsWindows() ? "win32" : OperatingSystem.IsMacOS() ? "darwin" : "linux";
            var arch = System.Runtime.InteropServices.RuntimeInformation.OSArchitecture switch
            {
                System.Runtime.InteropServices.Architecture.Arm64 => "arm64",
                System.Runtime.InteropServices.Architecture.X86 => "ia32",
                System.Runtime.InteropServices.Architecture.Arm => "arm",
                _ => "x64",
            };
            var bundled = Path.Combine(root, "node_modules", "ffprobe-static", "bin", platform, arch, OperatingSystem.IsWindows() ? "ffprobe.exe" : "ffprobe");
            Directory.CreateDirectory(Path.GetDirectoryName(bundled)!);
            File.WriteAllBytes(bundled, [0]);
            var nested = Directory.CreateDirectory(Path.Combine(root, "server", "bin")).FullName;
            Assert.Equal(bundled, FfprobeLocator.Find(null, null, [nested]));

            var managedDir = Directory.CreateDirectory(Path.Combine(root, "tools", "ffmpeg")).FullName;
            var managed = Path.Combine(managedDir, OperatingSystem.IsWindows() ? "ffprobe.exe" : "ffprobe");
            File.WriteAllBytes(managed, [0]);
            Assert.Equal(managed, FfprobeLocator.Find(null, null, [nested], managedDir));
            Assert.Equal(env, FfprobeLocator.Find(null, env, [nested], managedDir));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void AnFfprobeDownloadedAfterAMissedLookupIsFoundNextTime()
    {
        // A machine that already has ffprobe (node_modules, PATH) never misses, so there is nothing to re-look-up.
        if (FfprobeFactAttribute.Ffprobe is not null || FfprobeLocator.Find(null, null, [AppContext.BaseDirectory, Environment.CurrentDirectory]) is not null) return;
        var root = EngineHarness.NewRoot();
        try
        {
            var managedDir = Path.Combine(root, "tools", "ffmpeg");
            var locator = new FfprobeLocator(
                Microsoft.Extensions.Options.Options.Create(new LayoutMediaOptions { ManagedToolsDirectory = managedDir }),
                Microsoft.Extensions.Logging.Abstractions.NullLogger<FfprobeLocator>.Instance);
            Assert.Null(locator.Path);

            Directory.CreateDirectory(managedDir);
            var managed = Path.Combine(managedDir, OperatingSystem.IsWindows() ? "ffprobe.exe" : "ffprobe");
            File.WriteAllBytes(managed, [0]);
            Assert.Equal(managed, locator.Path);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task WithoutFfprobeValidationIsSkipped()
    {
        var validator = new CompletedMediaValidator(new FfprobeLocator(null), Microsoft.Extensions.Logging.Abstractions.NullLogger<CompletedMediaValidator>.Instance);
        Assert.False(validator.Available);
        Assert.Equal(MediaVerdict.Skipped, await validator.ValidateAsync(["readme.txt"], CancellationToken.None));
    }

    [FfprobeFact]
    public async Task AZeroFilledVideoFailsTheDownloadAndItsTarget()
    {
        await using var h = await EngineHarness.CreateAsync();
        var log = new ListLogger<CompletedLayoutFinalizer>();
        var dest = Path.Combine(h.Root, "downloads", "TV", "Show", "Season 01");
        await LayoutFinalizerTests.SeedCompletedAsync(h, 1, dest, "Show.S01E01.1080p.WEB", ("Show.S01E01.mkv", 4096), ("Show.S01E01.nfo", 1));
        await using (var db = await h.Db.CreateDbContextAsync())
        {
            db.AcquisitionTargets.Add(new Data.Entities.AcquisitionTarget
            {
                Id = Data.Ids.New(), UserId = Data.LocalUser.Id, TargetKey = "t1", WorkKey = "show", Scope = "episode", Status = "downloading",
                Progress = 0.5, InfoHash = EngineHarness.Hash(1).ToUpperInvariant(), CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        Assert.Equal(LayoutOutcome.Invalid, await LayoutFinalizerTests.FinalizeAsync(h, LayoutFinalizerTests.NewFinalizer(log, FfprobeFactAttribute.Ffprobe), 1));

        var row = await h.RowAsync(1);
        Assert.Equal("error", row.Status);
        Assert.Equal(CompletedMediaValidator.InvalidCompletedMediaMessage, row.Error);
        Assert.Null(row.VerifiedAt);
        await using (var db = await h.Db.CreateDbContextAsync())
        {
            var target = db.AcquisitionTargets.Single();
            Assert.Equal("failed", target.Status);
            Assert.Equal(0, target.Progress);
            Assert.Equal(CompletedMediaValidator.InvalidCompletedMediaMessage, target.Error);
        }
        Assert.True(log.Has($"[builtin-engine] rejected completed non-media payload {EngineHarness.Hash(1)}"));
        Assert.True(File.Exists(Path.Combine(dest, "Show.S01E01.1080p.WEB", "Show.S01E01.mkv")), "a rejected payload is not laid out");
    }

    [FfprobeFact]
    public async Task AReleaseWithNoVideoIsInvalid()
    {
        await using var h = await EngineHarness.CreateAsync();
        var dest = Path.Combine(h.Root, "downloads", "Movies", "X");
        await LayoutFinalizerTests.SeedCompletedAsync(h, 1, dest, "X.2024.1080p.WEB", ("X.2024.exe", 10), ("readme.txt", 1));
        Assert.Equal(LayoutOutcome.Invalid, await LayoutFinalizerTests.FinalizeAsync(h, LayoutFinalizerTests.NewFinalizer(new(), FfprobeFactAttribute.Ffprobe), 1));
    }

    [FfprobeFact]
    public async Task ARealVideoPassesAndIsLaidOut()
    {
        var fixture = MediaFixture();
        if (fixture is null) return;
        await using var h = await EngineHarness.CreateAsync();
        var dest = Path.Combine(h.Root, "downloads", "TV", "Demo Show", "Season 01");
        const string release = "Demo Show S01E01 1080p WEB-DL H.264";
        await LayoutFinalizerTests.SeedCompletedAsync(h, 1, dest, release, ("Demo Show S01E01.mp4", 1), ("info.nfo", 1));
        File.Copy(fixture!, Path.Combine(dest, release, "Demo Show S01E01.mp4"), overwrite: true);

        var validator = new CompletedMediaValidator(new FfprobeLocator(FfprobeFactAttribute.Ffprobe), Microsoft.Extensions.Logging.Abstractions.NullLogger<CompletedMediaValidator>.Instance);
        Assert.Equal(MediaVerdict.Valid, await validator.ValidateAsync([Path.Combine(dest, release, "Demo Show S01E01.mp4")], CancellationToken.None));
        Assert.Equal(LayoutOutcome.LaidOut, await LayoutFinalizerTests.FinalizeAsync(h, LayoutFinalizerTests.NewFinalizer(new(), FfprobeFactAttribute.Ffprobe), 1));
        Assert.True(File.Exists(Path.Combine(dest, "Demo Show S01E01.mp4")));
    }
}
