using System.Net;
using Xunit.Abstractions;
using TorrentFlow.Engine.Client;

namespace TorrentFlow.Engine.Tests;

[CollectionDefinition("HTTP memory budget", DisableParallelization = true)]
public class HttpMemoryBudgetCollection;

[Collection("HTTP memory budget")]
public class TorrentHttpLimitsTests(ITestOutputHelper output)
{
    private sealed class GeneratedContent(long length, bool knownLength) : HttpContent
    {
        public long Written { get; private set; }
        protected override bool TryComputeLength(out long value) { value = length; return knownLength; }
        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context)
        {
            var block = new byte[16 * 1024];
            block[0] = (byte)'d';
            while (Written < length)
            {
                var count = (int)Math.Min(block.Length, length - Written);
                await stream.WriteAsync(block.AsMemory(0, count));
                Written += count;
            }
        }
    }

    private sealed class Handler(HttpContent content) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
    }

    [Fact]
    public async Task WebseedBufferBudgetComparison()
    {
        async Task<(long Written, long Allocated)> Measure(bool bounded)
        {
            using var content = new GeneratedContent(64 * 1024 * 1024, true);
            using var client = new HttpClient(new Handler(content));
            if (bounded) TorrentHttpLimits.Configure(client);
            var before = GC.GetTotalAllocatedBytes(true);
            try
            {
                using var response = await client.GetAsync("https://synthetic.invalid/large-file.bin");
                Assert.False(bounded);
            }
            catch (HttpRequestException) when (bounded) { }
            return (content.Written, GC.GetTotalAllocatedBytes(true) - before);
        }
        var before = await Measure(false);
        var after = await Measure(true);
        output.WriteLine($"Synthetic 64 MiB response: baseline written={before.Written}, allocated={before.Allocated}; " +
            $"bounded written={after.Written}, allocated={after.Allocated} bytes.");
        Assert.Equal(64 * 1024 * 1024, before.Written);
        Assert.Equal(0, after.Written);
        Assert.True(after.Allocated < before.Allocated);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task WebseedThatIgnoresRangeCannotBufferAnEntireLargeFile(bool knownLength)
    {
        using var content = new GeneratedContent(2L * 1024 * 1024 * 1024, knownLength);
        using var client = TorrentHttpLimits.Configure(new HttpClient(new Handler(content)));
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://synthetic.invalid/episode.bin");
        request.Headers.Range = new(0, 2 * 1024 * 1024 - 1);
        await Assert.ThrowsAsync<HttpRequestException>(() => client.SendAsync(request));
        Assert.InRange(content.Written, 0, TorrentHttpLimits.MaxBufferedResponseBytes);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task MetadataSizeLimitAlsoAppliesWithoutContentLength(bool knownLength)
    {
        using var content = new GeneratedContent(TorrentHttpLimits.MaxMetadataBytes + 1L, knownLength);
        await Assert.ThrowsAsync<HttpRequestException>(() => TorrentHttpLimits.ReadMetadataAsync(content, default));
        Assert.InRange(content.Written, 0, TorrentHttpLimits.MaxMetadataBytes);
    }

    [Fact]
    public async Task OrdinaryMetadataAndWebseedBlocksStillWork()
    {
        using var content = new GeneratedContent(2 * 1024 * 1024, false);
        using var client = TorrentHttpLimits.Configure(new HttpClient(new Handler(content)));
        using var response = await client.GetAsync("https://synthetic.invalid/episode.bin");
        Assert.Equal(2 * 1024 * 1024, (await response.Content.ReadAsByteArrayAsync()).Length);
        using var metadata = new ByteArrayContent([(byte)'d', (byte)'e']);
        var bytes = await TorrentHttpLimits.ReadMetadataAsync(metadata, default);
        Assert.Equal(new byte[] { (byte)'d', (byte)'e' }, bytes);
    }

    [Fact]
    public void DefaultDiskBudgetIsSharedAndBounded()
    {
        var settings = MonoTorrentBackend.BuildSettings(new EngineOptions { ListenPort = 3925 });
        Assert.Equal(32 * 1024 * 1024, settings.DiskCacheBytes);
        Assert.Equal(MonoTorrent.PieceWriter.CachePolicy.WritesOnly, settings.DiskCachePolicy);
        Assert.Equal(40, settings.MaximumOpenFiles);
        Assert.Equal(400, settings.MaximumConnections);
    }
}
