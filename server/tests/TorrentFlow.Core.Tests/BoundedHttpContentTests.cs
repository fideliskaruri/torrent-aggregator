using System.Net;
using System.Text;
using TorrentFlow.Core.Http;

namespace TorrentFlow.Core.Tests;

public sealed class BoundedHttpContentTests
{
    [Fact]
    public async Task ReadsValidJsonWithAnUnknownContentLength()
    {
        using var content = new ChunkedContent("{\"title\":\"Français 日本語\",\"year\":2026}"u8.ToArray());
        using var document = await BoundedHttpContent.ReadJsonAsync(content);
        Assert.Equal("Français 日本語", document.RootElement.GetProperty("title").GetString());
        Assert.Equal(2026, document.RootElement.GetProperty("year").GetInt32());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task RejectsOversizedResponsesWithOrWithoutContentLength(bool knownLength)
    {
        var bytes = new byte[BoundedHttpContent.DefaultMaxBytes + 1];
        using HttpContent content = knownLength ? new ByteArrayContent(bytes) : new ChunkedContent(bytes);
        await Assert.ThrowsAsync<HttpRequestException>(() => BoundedHttpContent.ReadJsonAsync(content));
    }

    [Fact]
    public async Task PropagatesCancellationDuringBodyRead()
    {
        using var cancellation = new CancellationTokenSource();
        using var content = new WaitingContent();
        var read = BoundedHttpContent.ReadJsonAsync(content, cancellation.Token);
        await content.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => read);
    }

    [Fact]
    public async Task DoesNotStartBodyReadWhenAlreadyCancelled()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        using var content = new WaitingContent();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => BoundedHttpContent.ReadJsonAsync(content, cancellation.Token));
        Assert.False(content.Started.Task.IsCompleted);
    }

    [Fact]
    public async Task ElementReaderPreservesHttpJsonCharsetHandling()
    {
        using var content = new StringContent("{\"title\":\"Français 日本語\"}", Encoding.Unicode, "application/json");
        var element = await BoundedHttpContent.ReadJsonElementAsync(content);
        Assert.Equal("Français 日本語", element.GetProperty("title").GetString());
    }

    private sealed class ChunkedContent(byte[] bytes) : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => stream.WriteAsync(bytes).AsTask();
        protected override bool TryComputeLength(out long length) { length = 0; return false; }
    }

    private sealed class WaitingContent : HttpContent
    {
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => throw new NotSupportedException();
        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context, CancellationToken cancellationToken)
        {
            Started.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }
        protected override bool TryComputeLength(out long length) { length = 0; return false; }
    }
}
