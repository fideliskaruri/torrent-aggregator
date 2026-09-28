using System.Net;
using System.Security.Authentication;
using TorrentFlow.Core.Contracts.Engine;

namespace TorrentFlow.Engine.Tests;

public sealed class TorrentUrlFailureTests
{
    private sealed class Factory(Func<HttpResponseMessage> response) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(new Handler(response));
    }

    private sealed class Handler(Func<HttpResponseMessage> response) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(response());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RefusedSecureConnectionIsPlainAndStillAllowsMagnetFallback(bool withMagnet)
    {
        await using var h = await EngineHarness.CreateAsync(httpFactory: new Factory(() =>
            throw new HttpRequestException(HttpRequestError.SecureConnectionError, "The SSL connection could not be established",
                new AuthenticationException("Remote party sent HandshakeFailure"))));
        var result = await h.Engine.AddAsync(new()
        {
            TorrentUrl = "https://synthetic.invalid/example.torrent",
            Magnet = withMagnet ? EngineHarness.Magnet(1) : null,
            Purpose = TorrentPurpose.Keep
        });
        Assert.Equal(withMagnet, result.Ok);
        if (!withMagnet)
        {
            Assert.Equal("That torrent host could not establish a secure connection. Try another host or paste the magnet instead.", result.Message);
            Assert.Empty(await h.RowsAsync());
            Assert.Empty(h.Backend.AddLog);
        }
    }

    [Theory]
    [InlineData(403, "refused")]
    [InlineData(404, "not found")]
    [InlineData(503, "HTTP 503")]
    public async Task RemoteHttpFailuresExplainTheProblemWithoutAdmittingARow(int status, string expected)
    {
        await using var h = await EngineHarness.CreateAsync(httpFactory: new Factory(() =>
            new HttpResponseMessage((HttpStatusCode)status)));
        var result = await h.Engine.AddAsync(new() { TorrentUrl = "https://synthetic.invalid/example.torrent", Purpose = TorrentPurpose.Keep });
        Assert.False(result.Ok);
        Assert.Contains(expected, result.Message);
        Assert.Empty(await h.RowsAsync());
    }
}
