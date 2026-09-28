using System.Net;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Search.Adapters;

namespace TorrentFlow.Search.Tests;

/// <summary>Shared stub HTTP for adapter fixtures kept alongside TF_NETWORK_TESTS live cases.</summary>
internal sealed class FakeHttp(Func<HttpRequestMessage, HttpResponseMessage> handler) : HttpMessageHandler, IHttpClientFactory
{
    public List<string> Requests { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        lock (Requests) Requests.Add(request.RequestUri!.ToString());
        return Task.FromResult(handler(request));
    }

    public HttpClient CreateClient(string name) => new(this, disposeHandler: false);

    public static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    public IndexerHttp Http() => new(this, NullLogger<IndexerHttp>.Instance);
}
