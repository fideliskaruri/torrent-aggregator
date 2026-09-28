using System.Net;
using System.Text;

namespace TorrentFlow.Engine.Tests;

internal sealed record ExternalRequest(string Url, string Method, string Body, IReadOnlyDictionary<string, string> Headers);

internal sealed class ExternalHandler(Func<ExternalRequest, HttpResponseMessage> respond) : HttpMessageHandler
{
    public List<ExternalRequest> Requests { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var snapshot = new ExternalRequest(
            request.RequestUri!.AbsoluteUri,
            request.Method.Method,
            request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct),
            request.Headers.ToDictionary(h => h.Key, h => string.Join(", ", h.Value), StringComparer.OrdinalIgnoreCase));
        Requests.Add(snapshot);
        return respond(snapshot);
    }

    public static HttpResponseMessage Response(string content, HttpStatusCode status = HttpStatusCode.OK, string? header = null, string? value = null)
    {
        var response = new HttpResponseMessage(status)
        {
            Content = new StringContent(content, Encoding.UTF8, "application/json")
        };
        if (header is not null)
            response.Headers.TryAddWithoutValidation(header, value);
        return response;
    }

    public static HttpResponseMessage Login(string sid = "session") =>
        Response("Ok.", header: "Set-Cookie", value: $"other=1; Path=/, SID={sid}; HttpOnly; Path=/");
}
