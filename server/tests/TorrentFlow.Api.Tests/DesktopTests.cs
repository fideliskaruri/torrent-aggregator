using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Api.Desktop;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Media;
using TorrentFlow.Media.Tools;

namespace TorrentFlow.Api.Tests;

public sealed class DesktopTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tf-desktop-" + Guid.NewGuid().ToString("N"));

    public DesktopTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    [Theory]
    [InlineData("v1.3.0", "1.2.0", true)]
    [InlineData("v1.2.1", "1.2.0", true)]
    [InlineData("2.0", "1.9.9", true)]
    [InlineData("v1.2.0", "1.2.0", false)]
    [InlineData("v1.1.9", "1.2.0", false)]
    [InlineData("v1.2.0", "1.2.0-beta.1", true)]
    [InlineData("v1.2.0-beta.2", "1.2.0-beta.1", true)]
    [InlineData("v1.2.0-beta.1", "1.2.0", false)]
    [InlineData("v1.10.0", "1.9.0", true)]
    [InlineData("nightly", "1.2.0", false)]
    [InlineData("v1.3.0", "not-a-version", false)]
    [InlineData("", "1.0.0", false)]
    [InlineData("v1.2.3+build.7", "1.2.2", true)]
    public void ReleaseVersionComparesTagsAgainstTheRunningVersion(string latest, string current, bool newer) =>
        Assert.Equal(newer, ReleaseVersion.IsNewer(latest, current));

    [Fact]
    public void UnversionedBuildsAreNotUpdateCandidates()
    {
        Assert.False(Env(version: "0.0.0").IsVersioned);
        Assert.True(Env(version: "1.0.0").IsVersioned);
    }

    [Fact]
    public void HostArgsDropSwitchOnlyFlagsSoTheyDoNotSwallowTheNextArgument()
    {
        string[] args = ["--background", "--urls", "http://127.0.0.1:3924", "--NO-BROWSER"];
        Assert.Equal(["--urls", "http://127.0.0.1:3924"], DesktopEnvironment.HostArgs(args));
        Assert.True(DesktopEnvironment.HasFlag(args, "--no-browser"));
    }

    [Fact]
    public void GitHubReleaseParsingPicksTheInstallerAssetAndItsDigest()
    {
        using var doc = JsonDocument.Parse("""
            {"tag_name":"v1.4.0","html_url":"https://github.com/fideliskaruri/torrent-aggregator/releases/tag/v1.4.0",
             "assets":[
               {"name":"TorrentFlow.exe","browser_download_url":"https://github.com/x/TorrentFlow.exe","size":10},
               {"name":"TorrentFlow-Setup-1.4.0.exe","browser_download_url":"https://github.com/fideliskaruri/torrent-aggregator/releases/download/v1.4.0/TorrentFlow-Setup-1.4.0.exe",
                "size":1234,"digest":"sha256:ABCDEF"}]}
            """);
        var release = GitHubReleaseSource.Parse(doc.RootElement)!;
        Assert.Equal("1.4.0", release.Version);
        Assert.Equal("v1.4.0", release.Tag);
        Assert.Equal("TorrentFlow-Setup-1.4.0.exe", release.InstallerName);
        Assert.Equal("abcdef", release.InstallerSha256);
        Assert.Equal(1234, release.InstallerSize);
    }

    [Fact]
    public void GitHubReleaseParsingNeverOffersANonGitHubDownload()
    {
        using var doc = JsonDocument.Parse("""
            {"tag_name":"v1.4.0","assets":[{"name":"TorrentFlow-Setup-1.4.0.exe","browser_download_url":"http://evil.example/TorrentFlow-Setup-1.4.0.exe"}]}
            """);
        var release = GitHubReleaseSource.Parse(doc.RootElement)!;
        Assert.Null(release.InstallerUrl);
        Assert.Null(GitHubReleaseSource.Parse(JsonDocument.Parse("""{"tag_name":"latest"}""").RootElement));
    }

    [Fact]
    public void AutostartWritesAQuotedBackgroundCommandForThisExeAndRemovesIt()
    {
        var registry = new FakeRegistry();
        var exe = Path.Combine(_root, "Program Files", "TorrentFlow.exe");
        var service = new AutostartService(registry, Env(exe: exe));

        Assert.False(service.Status().Enabled);
        service.SetEnabled(true);
        Assert.Equal($"\"{exe}\" --background", registry.Values[AutostartService.ValueName]);
        var status = service.Status();
        Assert.True(status.Available);
        Assert.True(status.Enabled);
        Assert.False(status.PointsElsewhere);

        service.SetEnabled(false);
        Assert.False(registry.Values.ContainsKey(AutostartService.ValueName));
        service.SetEnabled(false);
    }

    [Fact]
    public void AutostartReportsAnEntryForAnotherCopyOfTheExe()
    {
        var registry = new FakeRegistry();
        registry.Values[AutostartService.ValueName] = AutostartService.BuildCommand(Path.Combine(_root, "old", "TorrentFlow.exe"));
        var status = new AutostartService(registry, Env(exe: Path.Combine(_root, "new", "TorrentFlow.exe"))).Status();
        Assert.True(status.Enabled);
        Assert.True(status.PointsElsewhere);
    }

    [Theory]
    [InlineData("\"C:\\Apps\\TorrentFlow.exe\" --background", "C:\\Apps\\TorrentFlow.exe")]
    [InlineData("C:\\Apps\\TorrentFlow.exe --background", "C:\\Apps\\TorrentFlow.exe")]
    [InlineData("C:\\Apps\\TorrentFlow.exe", "C:\\Apps\\TorrentFlow.exe")]
    [InlineData("", null)]
    [InlineData("\"", null)]
    public void AutostartReadsTheExeOutOfARunCommand(string command, string? exe) => Assert.Equal(exe, AutostartService.ExeOf(command));

    [Fact]
    public void AutostartIsUnavailableOutsideTheDesktopApp()
    {
        var registry = new FakeRegistry();
        var service = new AutostartService(registry, Env(isDesktop: false));
        Assert.False(service.Status().Available);
        Assert.Throws<InvalidOperationException>(() => service.SetEnabled(true));
        Assert.Empty(registry.Values);
    }

    [Fact]
    public async Task UpdateCheckSurfacesANewerReleaseOnly()
    {
        var source = new FakeReleaseSource { Latest = Release("1.3.0") };
        var (checker, store, _) = Checker(source, "1.2.0");

        await checker.CheckNowAsync(CancellationToken.None);
        Assert.True(checker.UpdateAvailable(store.Current));

        source.Latest = Release("1.2.0");
        await checker.CheckNowAsync(CancellationToken.None);
        Assert.False(checker.UpdateAvailable(store.Current));

        store.Update(s => s with { Latest = Release("9.0.0"), CheckForUpdates = false });
        Assert.False(checker.UpdateAvailable(store.Current));
    }

    [Fact]
    public async Task UpdateCheckOfflineOrWithoutReleasesIsQuiet()
    {
        var source = new FakeReleaseSource { Error = new HttpRequestException("offline") };
        var (checker, store, _) = Checker(source, "1.2.0");
        var settings = await checker.CheckNowAsync(CancellationToken.None);
        Assert.Equal("Could not reach GitHub.", settings.LastCheckError);
        Assert.NotNull(settings.LastCheckedAt);
        Assert.False(checker.UpdateAvailable(settings));

        source.Error = null;
        source.Latest = null; // 404: no releases yet
        settings = await checker.CheckNowAsync(CancellationToken.None);
        Assert.Null(settings.LastCheckError);
        Assert.Null(settings.Latest);
        Assert.True(File.Exists(store.FilePath));
    }

    [Fact]
    public async Task UpdateCheckRunsAtMostDailyAndNeverForLocalBuilds()
    {
        var (checker, store, time) = Checker(new FakeReleaseSource(), "1.2.0");
        Assert.True(checker.IsDue(store.Current));
        await checker.CheckNowAsync(CancellationToken.None);
        Assert.False(checker.IsDue(store.Current));
        time.Now += TimeSpan.FromHours(23);
        Assert.False(checker.IsDue(store.Current));
        time.Now += TimeSpan.FromHours(1);
        Assert.True(checker.IsDue(store.Current));
        store.Update(s => s with { CheckForUpdates = false });
        Assert.False(checker.IsDue(store.Current));

        var (dev, devStore, _) = Checker(new FakeReleaseSource(), "0.0.0");
        Assert.False(dev.Supported);
        Assert.False(dev.IsDue(devStore.Current));
    }

    [Fact]
    public void DesktopSettingsSurviveARestartAndIgnoreACorruptFile()
    {
        var store = new DesktopSettingsStore(_root);
        store.Update(s => s with { CheckForUpdates = false, Latest = Release("1.5.0") });
        var reloaded = new DesktopSettingsStore(_root).Current;
        Assert.False(reloaded.CheckForUpdates);
        Assert.Equal("1.5.0", reloaded.Latest?.Version);

        File.WriteAllText(store.FilePath, "{not json");
        Assert.True(new DesktopSettingsStore(_root).Current.CheckForUpdates);
    }

    [Fact]
    public async Task VerifiedDownloadKeepsAFileOnlyWhenItsChecksumMatches()
    {
        var payload = Encoding.UTF8.GetBytes("installer bytes");
        var sha = Convert.ToHexString(SHA256.HashData(payload));
        using var client = new HttpClient(new BytesHandler(payload));
        var target = Path.Combine(_root, "updates", "setup.exe");
        long last = 0;

        await VerifiedDownload.DownloadAsync(client, "https://github.com/x", target, sha.ToLowerInvariant(), payload.Length, (r, _) => last = r, CancellationToken.None);
        Assert.Equal(payload, File.ReadAllBytes(target));
        Assert.Equal(payload.Length, last);

        File.Delete(target);
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            VerifiedDownload.DownloadAsync(client, "https://github.com/x", target, new string('0', 64), null, (_, _) => { }, CancellationToken.None));
        Assert.False(File.Exists(target));
        Assert.False(File.Exists(target + ".part"));

        await Assert.ThrowsAsync<InvalidDataException>(() =>
            VerifiedDownload.DownloadAsync(client, "https://github.com/x", target, null, payload.Length + 1, (_, _) => { }, CancellationToken.None));
        Assert.False(File.Exists(target));
    }

    [Fact]
    public void FfmpegExtractionTakesOnlyTheBinariesAndLicence()
    {
        var zip = Path.Combine(_root, "ff.zip");
        using (var archive = ZipFile.Open(zip, ZipArchiveMode.Create))
        {
            Add(archive, "ffmpeg-7.1.1-essentials_build/bin/ffmpeg.exe", "ffmpeg");
            Add(archive, "ffmpeg-7.1.1-essentials_build/bin/ffprobe.exe", "ffprobe");
            Add(archive, "ffmpeg-7.1.1-essentials_build/bin/ffplay.exe", "ffplay");
            Add(archive, "ffmpeg-7.1.1-essentials_build/LICENSE", "GPL");
            Add(archive, "ffmpeg-7.1.1-essentials_build/doc/ffmpeg.html", "doc");
        }
        var tools = Path.Combine(_root, "tools", "ffmpeg");
        FfmpegInstaller.ExtractTools(zip, tools);
        Assert.Equal(["LICENSE.txt", "ffmpeg.exe", "ffprobe.exe"], Directory.GetFiles(tools).Select(Path.GetFileName).Order(StringComparer.Ordinal));
        Assert.Equal("ffprobe", File.ReadAllText(Path.Combine(tools, "ffprobe.exe")));
    }

    [Fact]
    public void FfmpegExtractionRejectsAPackageWithoutBothBinaries()
    {
        var zip = Path.Combine(_root, "bad.zip");
        using (var archive = ZipFile.Open(zip, ZipArchiveMode.Create))
            Add(archive, "x/bin/ffmpeg.exe", "ffmpeg");
        Assert.Throws<InvalidDataException>(() => FfmpegInstaller.ExtractTools(zip, Path.Combine(_root, "tools")));
    }

    [Fact]
    public async Task FfmpegDownloadVerifiesThePinnedChecksumThenReportsTheManagedCopy()
    {
        var zipBytes = ZipWith(("pkg/bin/ffmpeg.exe", "ffmpeg"), ("pkg/bin/ffprobe.exe", "ffprobe"));
        var tools = Path.Combine(_root, "tools", "ffmpeg");
        var locator = new FfmpegLocator(new MediaOptions { ManagedToolsDirectory = tools }, [], _ => null);

        var bad = new FfmpegInstaller(tools, locator, new Factory(new BytesHandler(zipBytes)), NullLogger<FfmpegInstaller>.Instance,
            new FfmpegPackage("https://github.com/x.zip", new string('0', 64), zipBytes.Length, "test"));
        Assert.Null(bad.Start());
        var failed = await WaitFor(bad, DownloadProgress.Failed);
        Assert.Contains("checksum", failed.Download.Error);
        Assert.False(File.Exists(Path.Combine(tools, "ffmpeg.exe")));

        var good = new FfmpegInstaller(tools, locator, new Factory(new BytesHandler(zipBytes)), NullLogger<FfmpegInstaller>.Instance,
            new FfmpegPackage("https://github.com/x.zip", Convert.ToHexString(SHA256.HashData(zipBytes)), zipBytes.Length, "test"));
        Assert.Null(good.Start());
        var done = await WaitFor(good, DownloadProgress.Done);
        if (OperatingSystem.IsWindows())
        {
            Assert.True(done.Managed);
            Assert.Equal(Path.Combine(tools, "ffmpeg.exe"), done.Ffmpeg, ignoreCase: true);
            Assert.Equal(Path.Combine(tools, "ffprobe.exe"), done.Ffprobe, ignoreCase: true);
        }
        Assert.False(File.Exists(Path.Combine(tools, "ffmpeg-download.zip")));
    }

    [Fact]
    public void TrayPauseAndResumeAllOnlyTouchKeptDownloads()
    {
        static EngineTorrentInfo T(string state, string retention = "kept") => new() { Hash = "a", Name = "n", State = state, RetentionState = retention };
        Assert.True(DesktopShellService.CanPause(T("downloading")));
        Assert.True(DesktopShellService.CanPause(T("queued")));
        Assert.True(DesktopShellService.CanPause(T("stalledDL")));
        Assert.False(DesktopShellService.CanPause(T("paused")));
        Assert.False(DesktopShellService.CanPause(T("downloaded")));
        Assert.False(DesktopShellService.CanPause(T("downloading", "stream")));
        Assert.True(DesktopShellService.CanResume(T("paused")));
        Assert.False(DesktopShellService.CanResume(T("downloading")));
        Assert.False(DesktopShellService.CanResume(T("paused", "prewarm")));
    }

    [Fact]
    public async Task UpdateInstallRunsOnlyAVerifiedNewerInstallerThenQuits()
    {
        var payload = Encoding.UTF8.GetBytes("setup exe");
        var sha = Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant();
        var (checker, store, _) = Checker(new FakeReleaseSource(), "1.2.0");
        var launcher = new FakeLauncher();
        var lifetime = new FakeLifetime();
        var installer = new UpdateInstaller(Env(version: "1.2.0"), store, checker, new Factory(new BytesHandler(payload)), launcher, lifetime,
            NullLogger<UpdateInstaller>.Instance);

        Assert.Equal("No update is available.", installer.Start());
        store.Update(s => s with { Latest = Release("1.2.0") with { InstallerSha256 = sha } });
        Assert.Equal("No update is available.", installer.Start());
        store.Update(s => s with { Latest = Release("1.3.0") with { InstallerUrl = null } });
        Assert.Contains("no Windows installer", installer.Start());
        store.Update(s => s with { Latest = Release("1.3.0") });
        Assert.Contains("no published checksum", installer.Start());
        Assert.Empty(launcher.Started);

        store.Update(s => s with { Latest = Release("1.3.0") with { InstallerSha256 = sha, InstallerSize = payload.Length } });
        Assert.Null(installer.Start());
        for (var i = 0; i < 200 && !lifetime.Stopped; i++) await Task.Delay(25);
        Assert.True(lifetime.Stopped);
        var (file, args) = Assert.Single(launcher.Started);
        Assert.Equal(Path.Combine(_root, "updates", "TorrentFlow-Setup-1.3.0.exe"), file);
        Assert.Equal(payload, File.ReadAllBytes(file));
        Assert.Contains("/UPDATE=1", args);
        Assert.Equal(DownloadProgress.Installing, installer.Progress.State);
    }

    [Fact]
    public async Task UpdateInstallRefusesAnInstallerWhoseChecksumDiffers()
    {
        var (checker, store, _) = Checker(new FakeReleaseSource(), "1.2.0");
        var launcher = new FakeLauncher();
        var lifetime = new FakeLifetime();
        var installer = new UpdateInstaller(Env(version: "1.2.0"), store, checker, new Factory(new BytesHandler([1, 2, 3])), launcher, lifetime,
            NullLogger<UpdateInstaller>.Instance);
        store.Update(s => s with { Latest = Release("1.3.0") with { InstallerSha256 = new string('0', 64) } });
        Assert.Null(installer.Start());
        for (var i = 0; i < 200 && installer.Progress.State != DownloadProgress.Failed; i++) await Task.Delay(25);
        Assert.Equal(DownloadProgress.Failed, installer.Progress.State);
        Assert.Empty(launcher.Started);
        Assert.False(lifetime.Stopped);
    }

    private static async Task<FfmpegStatus> WaitFor(FfmpegInstaller installer, string state)
    {
        for (var i = 0; i < 200; i++)
        {
            var status = installer.Status();
            if (status.Download.State == state) return status;
            await Task.Delay(25);
        }
        throw new TimeoutException($"ffmpeg download never reached {state}: {installer.Status().Download}");
    }

    private (UpdateChecker Checker, DesktopSettingsStore Store, ManualTime Time) Checker(IReleaseSource source, string version)
    {
        var store = new DesktopSettingsStore(Path.Combine(_root, Guid.NewGuid().ToString("N")));
        var time = new ManualTime();
        return (new UpdateChecker(Env(version: version), store, source, time, NullLogger<UpdateChecker>.Instance), store, time);
    }

    private DesktopEnvironment Env(bool isDesktop = true, string? exe = null, string version = "1.2.0") =>
        new(isDesktop, exe ?? Path.Combine(_root, "TorrentFlow.exe"), version, _root, "http://127.0.0.1:3924", background: false);

    private static LatestRelease Release(string version) =>
        new(version, "v" + version, null, $"TorrentFlow-Setup-{version}.exe", "https://github.com/x/setup.exe", null, null);

    private static void Add(ZipArchive archive, string name, string content)
    {
        using var writer = new StreamWriter(archive.CreateEntry(name).Open());
        writer.Write(content);
    }

    private static byte[] ZipWith(params (string Name, string Content)[] entries)
    {
        using var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
            foreach (var (name, content) in entries) Add(archive, name, content);
        return stream.ToArray();
    }

    private sealed class FakeRegistry : IAutostartRegistry
    {
        public Dictionary<string, string> Values { get; } = [];
        public string? Get(string name) => Values.GetValueOrDefault(name);
        public void Set(string name, string command) => Values[name] = command;
        public void Delete(string name) => Values.Remove(name);
    }

    private sealed class FakeReleaseSource : IReleaseSource
    {
        public LatestRelease? Latest { get; set; }
        public Exception? Error { get; set; }
        public Task<LatestRelease?> GetLatestAsync(CancellationToken ct) => Error is null ? Task.FromResult(Latest) : Task.FromException<LatestRelease?>(Error);
    }

    private sealed class FakeLauncher : IProcessLauncher
    {
        public List<(string File, string Args)> Started { get; } = [];
        public void Start(string fileName, string arguments) => Started.Add((fileName, arguments));
    }

    private sealed class FakeLifetime : Microsoft.Extensions.Hosting.IHostApplicationLifetime
    {
        public volatile bool Stopped;
        public CancellationToken ApplicationStarted => CancellationToken.None;
        public CancellationToken ApplicationStopping => CancellationToken.None;
        public CancellationToken ApplicationStopped => CancellationToken.None;
        public void StopApplication() => Stopped = true;
    }

    private sealed class ManualTime : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class BytesHandler(byte[] payload) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(payload) });
    }

    private sealed class Factory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }
}

public sealed class DesktopRouteTests(HostFactory factory) : IClassFixture<HostFactory>
{
    [Fact]
    public async Task DesktopEndpointReportsAServerBuildAsUnsupported()
    {
        var client = factory.CreateClient();
        using var doc = JsonDocument.Parse(await client.GetStringAsync("/api/desktop"));
        var root = doc.RootElement;
        Assert.False(root.GetProperty("supported").GetBoolean());
        Assert.False(root.GetProperty("autostart").GetProperty("available").GetBoolean());
        Assert.False(root.GetProperty("updates").GetProperty("available").GetBoolean());
        Assert.Equal("idle", root.GetProperty("ffmpeg").GetProperty("download").GetProperty("state").GetString());
        Assert.EndsWith(Path.Combine("tools", "ffmpeg"), root.GetProperty("ffmpeg").GetProperty("toolsDirectory").GetString());

        var put = await client.PutAsync("/api/desktop/settings", new StringContent("""{"startWithWindows":true}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.Conflict, put.StatusCode);
        var bad = await client.PutAsync("/api/desktop/settings", new StringContent("""{"startWithWindows":"yes"}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var check = await client.PostAsync("/api/desktop/update/check", null);
        Assert.Equal(HttpStatusCode.Conflict, check.StatusCode);
        var install = await client.PostAsync("/api/desktop/update/install", null);
        Assert.Equal(HttpStatusCode.Conflict, install.StatusCode);
    }
}
