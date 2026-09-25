using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Media.Features.Subtitles;

namespace TorrentFlow.Media.Tests;

public sealed class SubtitlesApiFactory : WebApplicationFactory<Program>
{
    public string Root { get; } = Path.Combine(Directory.GetCurrentDirectory(), ".subtitle-tests", Guid.NewGuid().ToString("N"));
    internal SubtitleFakeEngine Engine { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("TorrentFlow:DataDirectory", Root);
        builder.UseSetting("TorrentFlow:Media:FfmpegPath", Path.Combine(Root, "missing-ffmpeg.exe"));
        builder.UseSetting("TorrentFlow:Media:FfprobePath", Path.Combine(Root, "missing-ffprobe.exe"));
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<ITorrentEngine>();
            services.AddSingleton<ITorrentEngine>(Engine);
            // These tests exercise HTTP contracts, not the production swarm/background workers.
            services.RemoveAll<IHostedService>();
        });
    }

    internal async Task SeedProbeAsync(string hash, string path, SubtitleStream[]? streams)
    {
        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
        db.MediaProbes.Add(new MediaProbe
        {
            Id = Guid.NewGuid().ToString("N"), InfoHash = hash, FilePath = path,
            StreamsJson = JsonSerializer.Serialize(streams, new JsonSerializerOptions(JsonSerializerDefaults.Web)),
            ProbedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow
        });
        await db.SaveChangesAsync();
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        if (Directory.Exists(Root)) Directory.Delete(Root, true);
    }
}

internal sealed class SubtitleFakeEngine : ITorrentEngine
{
    internal Dictionary<string, EngineTorrentInfo> Torrents { get; } = [];
    internal Dictionary<(string Hash, string Path), byte[]> Content { get; } = [];
    internal int OpenCount;
    internal Func<string, string, CancellationToken, Task<Stream>>? OpenOverride { get; set; }
    public event EventHandler<EngineTorrentCompletedEventArgs>? TorrentCompleted { add { } remove { } }
    public Task<EngineTorrentInfo?> GetAsync(string infoHash, CancellationToken ct = default) => Task.FromResult(Torrents.GetValueOrDefault(infoHash));
    public Task<Stream> OpenFileStreamAsync(string infoHash, string fileIndexOrPath, CancellationToken ct = default)
    {
        Interlocked.Increment(ref OpenCount);
        if (OpenOverride is not null) return OpenOverride(infoHash, fileIndexOrPath, ct);
        return Content.TryGetValue((infoHash, fileIndexOrPath), out var bytes)
            ? Task.FromResult<Stream>(new MemoryStream(bytes, false)) : throw new IOException("Missing fixture");
    }
    public Task<IReadOnlyList<EngineTorrentInfo>> ListAsync(CancellationToken ct = default) => Task.FromResult<IReadOnlyList<EngineTorrentInfo>>(Torrents.Values.ToArray());
    public Task<long> QueuedReservedBytesAsync(CancellationToken ct = default) => Task.FromResult(0L);
    public Task<EngineAddResult> AddAsync(EngineAddRequest request, CancellationToken ct = default) => throw new NotSupportedException();
    public Task<EngineActionResult> PauseAsync(string infoHash, CancellationToken ct = default) => throw new NotSupportedException();
    public Task<EngineActionResult> ResumeAsync(string infoHash, CancellationToken ct = default) => throw new NotSupportedException();
    public Task<EngineActionResult> RemoveAsync(string infoHash, bool deleteFiles, CancellationToken ct = default) => throw new NotSupportedException();
    public Task<EngineActionResult> ForceAsync(string infoHash, CancellationToken ct = default) => throw new NotSupportedException();
    public Task<EngineActionResult> SelectFilesAsync(string infoHash, IReadOnlyCollection<int> fileIndices, CancellationToken ct = default) => throw new NotSupportedException();
}

public class SubtitlesRouteTests(SubtitlesApiFactory factory) : IClassFixture<SubtitlesApiFactory>
{
    private readonly HttpClient _http = factory.CreateClient();

    private string AddTorrent(string? state = null, string[]? paths = null)
    {
        var hash = Guid.NewGuid().ToString("N") + "12345678";
        factory.Engine.Torrents[hash] = new()
        {
            Hash = hash, Name = "fixture", State = state ?? "downloaded",
            Files = (paths ?? ["Film.mkv", "Film.eng.srt", "Film.fra.srt"])
                .Select((p, i) => new EngineFileInfo(i, p, 0, true, 1)).ToArray()
        };
        return hash;
    }
    private static string Url(string hash, string query = "") => $"/api/subtitles/{hash}?filePath=Film.mkv{query}";
    private static async Task<JsonElement> Body(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
    private void SetSidecar(string hash, byte[] bytes, long? declaredSize = null)
    {
        var info = factory.Engine.Torrents[hash];
        factory.Engine.Torrents[hash] = info with { Files = info.Files!.Select(f => f.Path == "Film.eng.srt" ? f with { Length = declaredSize ?? bytes.Length } : f).ToArray() };
        factory.Engine.Content[(hash, "Film.eng.srt")] = bytes;
    }

    [Theory]
    [InlineData("/api/subtitles/nope?filePath=Film.mkv", "infoHash and filePath are required")]
    [InlineData("/api/subtitles/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "infoHash and filePath are required")]
    [InlineData("/api/subtitles/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?filePath=..%2FFilm.mkv", "Invalid file path")]
    [InlineData("/api/subtitles/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?filePath=a%5C.%5CFilm.mkv", "Invalid file path")]
    public async Task ValidatesBeforeLookingUpTorrents(string url, string error)
    {
        var response = await _http.GetAsync(url);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(error, (await Body(response)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task UnknownAndMetadataPendingHaveDistinctErrors()
    {
        var missing = await _http.GetAsync(Url(new string('0', 40)));
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal("Torrent not found", (await Body(missing)).GetProperty("error").GetString());
        var pending = await _http.GetAsync(Url(AddTorrent("metaDL", [])));
        Assert.Equal(425, (int)pending.StatusCode);
        Assert.Equal("Torrent metadata is not ready yet", (await Body(pending)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task CachedListingIsFreeAndKeepsExplicitNullFields()
    {
        var hash = AddTorrent();
        await factory.SeedProbeAsync(hash, "Film.mkv", SubtitlesRulesTests.Streams);
        var opens = factory.Engine.OpenCount;
        var response = await _http.GetAsync(Url(hash.ToUpperInvariant()));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await Body(response);
        Assert.Equal(opens, factory.Engine.OpenCount);
        Assert.True(body.GetProperty("embeddedInspected").GetBoolean());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("probeError").ValueKind);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("defaultTrackId").ValueKind);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("subtitleDefault").GetProperty("defaultTrackId").ValueKind);
        var tracks = body.GetProperty("tracks").EnumerateArray().ToArray();
        Assert.Equal(6, tracks.Length);
        Assert.Equal("sidecar", tracks[0].GetProperty("kind").GetString());
        Assert.Equal(JsonValueKind.Null, tracks[0].GetProperty("streamIndex").ValueKind);
        Assert.Equal(JsonValueKind.Null, tracks[0].GetProperty("unsupportedReason").ValueKind);
        Assert.Equal(SubtitleRules.TrackSrc(hash, "Film.mkv", "sidecar:Film.eng.srt"), tracks[0].GetProperty("src").GetString());
        var unsupported = tracks.Single(t => t.GetProperty("id").GetString() == "embedded:3");
        Assert.False(unsupported.GetProperty("supported").GetBoolean());
        Assert.Equal(JsonValueKind.Null, unsupported.GetProperty("src").ValueKind);
        Assert.Equal(JsonValueKind.Null, unsupported.GetProperty("filePath").ValueKind);
    }

    [Fact]
    public async Task FailedProbeDoesNotHideSidecarsOrClaimInspection()
    {
        var response = await _http.GetAsync(Url(AddTorrent()));
        var body = await Body(response);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.False(body.GetProperty("embeddedInspected").GetBoolean());
        Assert.Equal("probe_failed", body.GetProperty("probeError").GetString());
        Assert.Equal(2, body.GetProperty("tracks").GetArrayLength());
        Assert.Equal("sidecar:Film.eng.srt", body.GetProperty("defaultTrackId").GetString());
    }

    [Fact]
    public async Task SidecarConversionHeadersHeadAndCachedOffsetsMatch()
    {
        var hash = AddTorrent();
        SetSidecar(hash, Encoding.UTF8.GetBytes("\uFEFF1\r\n00:01:29,500 --> 00:01:32,000\r\nCafé 日本語\r\n"));
        const string track = "&track=sidecar%3AFilm.eng.srt";
        var response = await _http.GetAsync(Url(hash, track));
        var vtt = await response.Content.ReadAsStringAsync();
        Assert.Equal("WEBVTT\n\n1\n00:01:29.500 --> 00:01:32.000\nCafé 日本語\n", vtt);
        Assert.Equal("text/vtt; charset=utf-8", response.Content.Headers.ContentType?.ToString());
        Assert.Equal(Encoding.UTF8.GetByteCount(vtt), response.Content.Headers.ContentLength);
        Assert.True(response.Headers.CacheControl?.Private);
        Assert.Equal(TimeSpan.FromHours(1), response.Headers.CacheControl?.MaxAge);
        var opens = factory.Engine.OpenCount;
        var rebased = await _http.GetStringAsync(Url(hash, track + "&offset=90&start=480"));
        Assert.Contains("00:00:00.000 --> 00:00:02.000", rebased);
        Assert.Equal(opens, factory.Engine.OpenCount);
        var head = await _http.SendAsync(new HttpRequestMessage(HttpMethod.Head, Url(hash, track)));
        Assert.Equal(HttpStatusCode.OK, head.StatusCode);
        Assert.Empty(await head.Content.ReadAsByteArrayAsync());
        Assert.Equal(Encoding.UTF8.GetByteCount(vtt), head.Content.Headers.ContentLength);
    }

    [Theory]
    [InlineData("&track=embedded%3A2&start=-1", "Invalid subtitle window")]
    [InlineData("&track=embedded%3A2&start=NaN", "Invalid subtitle window")]
    [InlineData("&track=embedded%3A2&start=86401", "Invalid subtitle window")]
    [InlineData("&track=embedded%3A2&start=12", "Subtitle window must use the canonical stride")]
    [InlineData("&track=magic%3A2", "Unknown subtitle track")]
    [InlineData("&track=sidecar%3A..%2Fsecret.srt", "Unknown subtitle track")]
    public async Task ContentValidationHasExactErrors(string query, string error)
    {
        var response = await _http.GetAsync(Url(AddTorrent(), query));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(error, (await Body(response)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task SidecarMustBelongToTheRequestedVideo()
    {
        var hash = AddTorrent(paths: ["Film.mkv", "Other.mkv", "Other.srt"]);
        var response = await _http.GetAsync(Url(hash, "&track=sidecar%3AOther.srt"));
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("Subtitle file not found for this video", (await Body(response)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task UnreadableAndOversizedSidecarsReturn503WithoutConversion()
    {
        foreach (var size in new long?[] { null, SubtitleRules.MaxBytes + 1L })
        {
            var hash = AddTorrent();
            if (size.HasValue) SetSidecar(hash, [], size);
            var response = await _http.GetAsync(Url(hash, "&track=sidecar%3AFilm.eng.srt"));
            Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
            Assert.Equal("Could not read the subtitle file", (await Body(response)).GetProperty("error").GetString());
        }
    }

    [Fact]
    public async Task EmbeddedUnknownBitmapAndUnavailableToolsAreDistinct()
    {
        var hash = AddTorrent();
        await factory.SeedProbeAsync(hash, "Film.mkv", SubtitlesRulesTests.Streams);
        var unknown = await _http.GetAsync(Url(hash, "&track=embedded%3A42"));
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Equal("Subtitle track not found", (await Body(unknown)).GetProperty("error").GetString());
        var bitmap = await _http.GetAsync(Url(hash, "&track=embedded%3A3"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, bitmap.StatusCode);
        Assert.Equal("Unsupported subtitle track", (await Body(bitmap)).GetProperty("error").GetString());
        var unavailable = await _http.GetAsync(Url(hash, "&track=embedded%3A2"));
        Assert.Equal(HttpStatusCode.ServiceUnavailable, unavailable.StatusCode);
        Assert.Equal("Could not extract that subtitle track", (await Body(unavailable)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task EmbeddedCachedWindowRebasesIndependentlyFromPlaybackOffset()
    {
        var hash = AddTorrent();
        factory.Services.GetRequiredService<SubtitleExtraction>().WriteCache(hash, "Film.mkv", "embedded:2",
            "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nwindow cue", 480);
        var response = await _http.GetAsync(Url(hash, "&track=embedded%3A2&start=480&offset=90"));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("00:06:40.000 --> 00:06:42.000", await response.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("&track=embedded%3A2&consumer=player&start=480", 204)]
    [InlineData("&track=embedded%3A2&consumer=player&start=960", 204)]
    [InlineData("&track=sidecar%3AFilm.srt&consumer=player", 400)]
    [InlineData("&track=embedded%3A2", 400)]
    [InlineData("&track=embedded%3A2&consumer=%20", 400)]
    [InlineData("&track=embedded%3A2&consumer=player&start=1", 400)]
    public async Task CancellationValidatesWithoutLookingUpTheTorrent(string query, int status)
    {
        var response = await _http.DeleteAsync(Url(new string('0', 40), query));
        Assert.Equal(status, (int)response.StatusCode);
        if (status == 400) Assert.Equal("Invalid subtitle cancellation request", (await Body(response)).GetProperty("error").GetString());
        else Assert.Empty(await response.Content.ReadAsStringAsync());
    }
}
