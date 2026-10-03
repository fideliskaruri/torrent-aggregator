using System.Net.Http.Headers;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using TorrentFlow.Domain;

namespace TorrentFlow.Sources;

public sealed record SourceHealth(bool Ok, string Status, string? Message);

public static class SourceSettingsHealth
{
    public static async Task<SourceHealth> TestAsync(SourceSettings source, string? credential, CancellationToken ct)
    {
        if (source.Type == "tmdb" && string.IsNullOrWhiteSpace(credential))
            return new(false, "credential_required", "TMDB needs an API key. Add one, or turn TMDB off.");
        var suffix = source.Type switch
        {
            "tvmaze" => "/shows/1", "cinemeta" => "/meta/movie/tt0038650.json",
            "tmdb" => "/configuration", "torznab" => "?t=caps", "nyaa" => "/?page=rss",
            "apibay" => "/q.php?q=public%20domain&cat=0", "yts" => "/list_movies.json?limit=1",
            "eztv" => "/get-torrents?limit=1&page=1", "animetosho" => "/json?q=test",
            "subsplease" => "/api/?f=search&tz=UTC&s=test",
            "therarbg" => "/get-posts/keywords:test:format:json/",
            "torrentdownloadinfo" => "/feed?q=test", "itunes" => "/lookup?id=909253", _ => "",
        };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMilliseconds(source.TimeoutMilliseconds));
        try
        {
            using var client = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false });
            var url = SourceSettingsContract.Endpoint(source).TrimEnd('/') + suffix;
            if (credential is not null && source.Type == "torznab") url += "&apikey=" + Uri.EscapeDataString(credential);
            if (credential is not null && source.Type == "tmdb" && credential.Length == 32) url += "?api_key=" + Uri.EscapeDataString(credential);
            using var request = new HttpRequestMessage(source.Type == "anilist" ? HttpMethod.Post : HttpMethod.Get, url);
            if (source.Type == "tmdb" && credential is { Length: > 80 })
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
            if (source.Type == "anilist")
                request.Content = new StringContent("{\"query\":\"{ Page(perPage:1) { media(type:ANIME) { id } } }\"}", Encoding.UTF8, "application/json");
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            var ok = response.IsSuccessStatusCode;
            if (ok && source.Type == "torznab")
            {
                await response.Content.LoadIntoBufferAsync(1024 * 1024, timeout.Token);
                await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
                using var reader = XmlReader.Create(stream, new XmlReaderSettings
                    { Async = true, DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 1024 * 1024 });
                var caps = await XDocument.LoadAsync(reader, LoadOptions.None, timeout.Token);
                ok = caps.Root?.Name.LocalName == "caps";
            }
            return new(ok, ok ? "ok" : "unavailable", ok ? null :
                "The source did not accept the request. Check its address and API key, then try again.");
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or XmlException or IOException or ArgumentException)
        {
            return new(false, "unavailable", "Could not reach this source. Check its address and your network, then try again.");
        }
    }
}
