using System.Net;
using TorrentFlow.Core.Sources;

namespace TorrentFlow.Metadata.Providers;

public sealed class SourceRoutingHandler(SourceRegistry registry) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var uri = request.RequestUri!;
        var type = uri.Host switch
        {
            "api.themoviedb.org" => "tmdb", "api.tvmaze.com" => "tvmaze", "graphql.anilist.co" => "anilist",
            "v3-cinemeta.strem.io" => "cinemeta", "itunes.apple.com" => "itunes", _ => null
        };
        if (type is null) return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var category = type switch { "tvmaze" => "series", "anilist" => "anime", "itunes" => "movie",
            "cinemeta" => uri.AbsolutePath.Contains("/series/", StringComparison.Ordinal) ? "series" : "movie",
            "tmdb" => uri.AbsolutePath.Contains("/tv/", StringComparison.Ordinal) ? "series" : uri.AbsolutePath.Contains("/movie/", StringComparison.Ordinal) ? "movie" : "all", _ => "all" };
        var current = SourceExecution.Current;
        var source = current?.Kind == "metadata" && current.Type == type ? current :
            registry.Active("metadata", category).FirstOrDefault(e => e.Type == type);
        if (source is null) return new(HttpStatusCode.ServiceUnavailable) { Content = new StringContent("{}") };
        var suffix = uri.PathAndQuery;
        if (type == "tmdb" && suffix.StartsWith("/3/", StringComparison.Ordinal)) suffix = suffix[2..];
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(source.TimeoutMs);
        var body = request.Content is null ? null : await request.Content.ReadAsByteArrayAsync(timeout.Token);
        var endpoints = new[] { source.BaseUrl }.Concat(source.Mirrors).ToArray();
        for (var i = 0; i < endpoints.Length; i++)
        {
            using var attempt = new HttpRequestMessage(request.Method, endpoints[i].TrimEnd('/') + suffix);
            foreach (var header in request.Headers) attempt.Headers.TryAddWithoutValidation(header.Key, header.Value);
            if (body is not null)
            {
                attempt.Content = new ByteArrayContent(body);
                foreach (var header in request.Content!.Headers) attempt.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }
            try
            {
                var response = await base.SendAsync(attempt, timeout.Token).ConfigureAwait(false);
                if (response.IsSuccessStatusCode || (int)response.StatusCode < 500 || i == endpoints.Length - 1) return response;
                response.Dispose();
            }
            catch (HttpRequestException) when (i < endpoints.Length - 1) { }
        }
        return new(HttpStatusCode.ServiceUnavailable);
    }
}
