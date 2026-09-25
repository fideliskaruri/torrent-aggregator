using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace TorrentFlow.Media.Tests;

public class StreamRouteTests : IClassFixture<MediaApiFactory>
{
    private const string Hash = "0123456789abcdef0123456789abcdef01234567";
    private const string PendingHash = "fedcba9876543210fedcba9876543210fedcba98";
    private const int Size = 300_000;
    private static readonly byte[] Data = Fixtures.Bytes(Size);
    private readonly MediaApiFactory _factory;
    private readonly HttpClient _http;

    public StreamRouteTests(MediaApiFactory factory)
    {
        _factory = factory;
        factory.Engine.Add(Hash, "Movie", ("Movie/Movie.mp4", Data), ("Movie/Movie.mkv", Fixtures.Bytes(1000)), ("Movie/Movie.en.srt", "1\n00:00:01,000 --> 00:00:02,000\nHi\n"u8.ToArray()), ("Movie/setup.exe", Fixtures.Bytes(10)));
        factory.Engine.AddPending(PendingHash);
        _http = factory.CreateClient();
    }

    private static string FileUrl(string path) => $"/api/stream/{Hash}/{path}";

    private Task<HttpResponseMessage> Get(string url, string? range = null, HttpMethod? method = null)
    {
        var req = new HttpRequestMessage(method ?? HttpMethod.Get, url);
        if (range is not null) req.Headers.TryAddWithoutValidation("Range", range);
        return _http.SendAsync(req);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage r) => JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;

    [Fact]
    public async Task FullFileWithoutRangeIs200WithAcceptRanges()
    {
        var r = await Get(FileUrl("Movie/Movie.mp4"));
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal("bytes", string.Join(",", r.Headers.AcceptRanges));
        Assert.Equal("video/mp4", r.Content.Headers.ContentType?.MediaType);
        Assert.Equal(Size, r.Content.Headers.ContentLength);
        Assert.Equal(Data, await r.Content.ReadAsByteArrayAsync());
    }

    [Fact]
    public async Task FirstRangeIs206WithContentRange()
    {
        var r = await Get(FileUrl("Movie/Movie.mp4"), "bytes=0-1023");
        Assert.Equal(HttpStatusCode.PartialContent, r.StatusCode);
        Assert.Equal($"bytes 0-1023/{Size}", r.Content.Headers.ContentRange?.ToString());
        Assert.Equal(1024, r.Content.Headers.ContentLength);
        Assert.Equal(Data[..1024], await r.Content.ReadAsByteArrayAsync());
    }

    [Fact]
    public async Task MiddleRangeServesExactBytes()
    {
        var r = await Get(FileUrl("Movie/Movie.mp4"), "bytes=150000-150999");
        Assert.Equal(HttpStatusCode.PartialContent, r.StatusCode);
        Assert.Equal($"bytes 150000-150999/{Size}", r.Content.Headers.ContentRange?.ToString());
        Assert.Equal(Data[150000..151000], await r.Content.ReadAsByteArrayAsync());
    }

    [Fact]
    public async Task SuffixRangeServesTheTail()
    {
        var r = await Get(FileUrl("Movie/Movie.mp4"), "bytes=-500");
        Assert.Equal(HttpStatusCode.PartialContent, r.StatusCode);
        Assert.Equal($"bytes {Size - 500}-{Size - 1}/{Size}", r.Content.Headers.ContentRange?.ToString());
        Assert.Equal(Data[^500..], await r.Content.ReadAsByteArrayAsync());
    }

    [Fact]
    public async Task OpenEndedRangeRunsToEnd()
    {
        var r = await Get(FileUrl("Movie/Movie.mp4"), "bytes=299000-");
        Assert.Equal(HttpStatusCode.PartialContent, r.StatusCode);
        Assert.Equal(Data[299000..], await r.Content.ReadAsByteArrayAsync());
    }

    [Theory]
    [InlineData("bytes=300000-")]
    [InlineData("bytes=400000-400100")]
    [InlineData("bytes=abc")]
    [InlineData("bytes=-900000")]
    public async Task UnsatisfiableRangeIs416(string range)
    {
        var r = await Get(FileUrl("Movie/Movie.mp4"), range);
        Assert.Equal(HttpStatusCode.RequestedRangeNotSatisfiable, r.StatusCode);
        Assert.Equal($"bytes */{Size}", r.Content.Headers.ContentRange?.ToString());
    }

    [Fact]
    public async Task HeadReportsLengthWithoutBodyOrOpeningAStream()
    {
        var before = _factory.Engine.OpenCount;
        var r = await Get(FileUrl("Movie/Movie.mp4"), method: HttpMethod.Head);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal(Size, r.Content.Headers.ContentLength);
        Assert.Equal("bytes", string.Join(",", r.Headers.AcceptRanges));
        Assert.Empty(await r.Content.ReadAsByteArrayAsync());
        Assert.Equal(before, _factory.Engine.OpenCount);
    }

    [Fact]
    public async Task HeadWithRangeIs206()
    {
        var r = await Get(FileUrl("Movie/Movie.mp4"), "bytes=10-19", HttpMethod.Head);
        Assert.Equal(HttpStatusCode.PartialContent, r.StatusCode);
        Assert.Equal(10, r.Content.Headers.ContentLength);
        Assert.Equal($"bytes 10-19/{Size}", r.Content.Headers.ContentRange?.ToString());
    }

    [Fact]
    public async Task MatroskaGetsItsContentType()
    {
        var r = await Get(FileUrl("Movie/Movie.mkv"), "bytes=0-9");
        Assert.Equal(HttpStatusCode.PartialContent, r.StatusCode);
        Assert.Equal("video/x-matroska", r.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task SubtitleFilesAreServedAsWebVtt()
    {
        var r = await Get(FileUrl("Movie/Movie.en.srt"));
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal("text/vtt", r.Content.Headers.ContentType?.MediaType);
        var body = await r.Content.ReadAsStringAsync();
        Assert.StartsWith("WEBVTT", body);
        Assert.Contains("00:00:01.000 --> 00:00:02.000", body);
    }

    [Theory]
    [InlineData("Movie/setup.exe")]
    [InlineData("Movie/missing.mp4")]
    public async Task UnknownOrUnsafeFilesAre404(string path)
    {
        var r = await Get(FileUrl(path));
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        Assert.Equal("Torrent file not found", (await Json(r)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task UnknownTorrentIndexIs404()
    {
        var r = await Get("/api/stream/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        Assert.Equal("Torrent not found", (await Json(r)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task IndexListsOnlyMediaAssetsAndThePrimaryVideo()
    {
        var r = await Get($"/api/stream/{Hash}");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var body = await Json(r);
        var paths = body.GetProperty("files").EnumerateArray().Select(f => f.GetProperty("path").GetString()).ToList();
        Assert.Equal(["Movie/Movie.mp4", "Movie/Movie.mkv", "Movie/Movie.en.srt"], paths);
        Assert.Equal(0, body.GetProperty("primaryVideoIndex").GetInt32());
        Assert.Equal("builtin", body.GetProperty("clientType").GetString());
        Assert.Equal(3, body.GetProperty("swarm").GetProperty("peers").GetInt32());
    }

    [Fact]
    public async Task NonLiveTorrentIsResumedAndReports425WhileMetadataIsPending()
    {
        var before = _factory.Engine.ResumeCount;
        var r = await Get($"/api/stream/{PendingHash}");
        Assert.Equal((HttpStatusCode)425, r.StatusCode);
        Assert.Equal("Torrent metadata is not ready yet", (await Json(r)).GetProperty("error").GetString());
        Assert.True(_factory.Engine.ResumeCount > before);
    }

    [Fact]
    public async Task InvalidHashFileRouteIs404()
    {
        var r = await Get("/api/stream/not-a-hash/Movie.mp4");
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
    }

    [Fact]
    public async Task SubtitleListingFindsTheSidecar()
    {
        var r = await Get($"/api/subtitles/{Hash}?filePath={Uri.EscapeDataString("Movie/Movie.mp4")}");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var body = await r.Content.ReadAsStringAsync();
        Assert.Contains("sidecar:Movie/Movie.en.srt", body);
    }

    [Fact]
    public async Task PlaybackStatusIsInactiveWithoutForegroundPlayback()
    {
        var r = await Get("/api/playback/status");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.False((await Json(r)).GetProperty("active").GetBoolean());
    }

    [Fact]
    public async Task UnknownHlsSessionIs404()
    {
        var r = await Get("/api/playback/hls/0123456789abcdef/playlist.m3u8");
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
    }

    [Fact]
    public async Task PlanRejectsNonJsonBodies()
    {
        var content = new StringContent("{}");
        content.Headers.ContentType = new MediaTypeHeaderValue("text/plain");
        var r = await _http.PostAsync("/api/playback/plan", content);
        Assert.True((int)r.StatusCode is 400 or 415, $"unexpected {(int)r.StatusCode}");
    }
}
