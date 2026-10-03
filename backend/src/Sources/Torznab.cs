using System.Runtime.CompilerServices;
using System.Xml.Linq;
using Microsoft.Extensions.Configuration;
using TorrentFlow.Domain;
using static TorrentFlow.Sources.CoreAdapters;

namespace TorrentFlow.Sources;

internal static class Torznab
{
    internal static async IAsyncEnumerable<Page> SearchAsync(SourceSettings settings, SourceQuery query, int limit,
        SourceTransport transport, CallTrace trace, IConfiguration configuration,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var endpoint = settings.BaseUrl!;
        var key = await KeyAsync(settings, configuration, ct);
        string Url(string function, bool search, int offset = 0) =>
            endpoint + (endpoint.Contains('?') ? "&" : "?") + $"t={function}" +
            (search ? $"&q={Uri.EscapeDataString(query.Query.Trim())}&limit={limit}&offset={offset}" : "") +
            (string.IsNullOrEmpty(key) ? "" : $"&apikey={Uri.EscapeDataString(key)}");
        var capsXml = await transport.ReadAsync(new(Url("caps", false)), null, settings, query, trace, ct);
        var caps = FeedXml.Load(capsXml);
        Error(caps);
        if (caps.Root?.Name.LocalName != "caps")
            throw new SourceException("SourceFailure", "Torznab did not return capabilities.");
        bool Supports(string name) => caps.Descendants().Any(e => e.Name.LocalName == name &&
            string.Equals((string?)e.Attribute("available"), "yes", StringComparison.OrdinalIgnoreCase) &&
            (((string?)e.Attribute("supportedParams"))?.Split(',', StringSplitOptions.TrimEntries)
                .Contains("q", StringComparer.OrdinalIgnoreCase) ?? false));
        var specialized = query.Category switch
        {
            "tv" or "series" or "anime" => Supports("tv-search") ? "tvsearch" : null,
            "movies" or "films" => Supports("movie-search") ? "movie" : null,
            _ => null
        };
        var function = specialized ?? (Supports("search") ? "search" : null);
        if (function is null) throw new SourceException("Unsupported", "This Torznab endpoint does not advertise text search.");
        var offset = 0;
        for (var page = 0; page < 4; page++)
        {
            var xml = await transport.ReadAsync(new(Url(function, true, offset)), null, settings, query, trace, ct);
            var document = FeedXml.Load(xml);
            Error(document);
            var items = FeedXml.Items(document);
            var results = new List<RawRelease>();
            foreach (var item in items)
            {
                string V(string name) => FeedXml.Value(item, name);
                string A(string name) => item.Elements().FirstOrDefault(e => e.Name.LocalName == "attr" &&
                    string.Equals((string?)e.Attribute("name"), name, StringComparison.OrdinalIgnoreCase))?.Attribute("value")?.Value ?? "";
                var enclosure = item.Elements().FirstOrDefault(e => e.Name.LocalName == "enclosure");
                var candidates = new[] { A("magneturl"), V("link"), (string?)enclosure?.Attribute("url") ?? "" };
                var magnet = candidates.FirstOrDefault(s => s.StartsWith("magnet:?", StringComparison.OrdinalIgnoreCase));
                var torrent = candidates.FirstOrDefault(s => Uri.TryCreate(s, UriKind.Absolute, out var u) && u.Scheme is "http" or "https");
                var hash = AdditionalAdapters.Hash(A("infohash"));
                if (hash.Length == 0) hash = MagnetHash(magnet) ?? "";
                var seeds = FeedXml.Count(A("seeders"));
                var peers = FeedXml.Count(A("peers"));
                var leeches = FeedXml.Count(A("leechers")) ??
                    (peers.HasValue && seeds.HasValue ? Math.Max(0, peers.Value - seeds.Value) : (int?)null);
                var release = Raw("torznab", V("title"), hash,
                    FeedXml.Bytes(V("size")) ?? FeedXml.Bytes(A("size")) ?? FeedXml.Bytes((string?)enclosure?.Attribute("length") ?? ""),
                    seeds, leeches, V("guid"), magnet, torrent, Date(V("pubDate")), allowHashless: true);
                if (release is not null) results.Add(release);
            }
            var response = document.Descendants().FirstOrDefault(e => e.Name.LocalName == "response");
            var total = FeedXml.Bytes((string?)response?.Attribute("total") ?? "");
            var more = total.HasValue ? total > offset + items.Length : items.Length >= limit;
            yield return new(results, more);
            if (!more || items.Length == 0) yield break;
            offset += items.Length;
        }
    }

    private static void Error(XDocument document)
    {
        if (document.Root?.Name.LocalName == "error")
            throw new SourceException("SourceFailure", "Torznab returned an error response (code " +
                (FeedXml.Count((string?)document.Root.Attribute("code") ?? "")?.ToString() ?? "unknown") + ").");
    }

    private static async Task<string?> KeyAsync(SourceSettings settings, IConfiguration configuration, CancellationToken ct)
    {
        // Host environment configuration is not persisted or projected into source diagnostics.
        if (configuration[$"TorrentFlow:Sources:{settings.Id}:ApiKey"] is { Length: > 0 } configured) return configured;
        if (settings.Credential is not { } reference) return null;
        var directory = configuration["TorrentFlow:DataDirectory"];
        if (string.IsNullOrWhiteSpace(directory) || reference.FileId.Length is < 1 or > 128 ||
            reference.FileId.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_')))
            throw new SourceException("Unconfigured", "The source credential reference cannot be resolved.");
        var secrets = Path.Combine(Path.GetFullPath(directory), "secrets");
        var path = Path.Combine(secrets, reference.FileId + ".secret");
        try
        {
            if (!File.Exists(path) || (File.GetAttributes(secrets) & FileAttributes.ReparsePoint) != 0 ||
                (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0 || new FileInfo(path).Length > 65536)
                throw new SourceException("Unconfigured", "The source credential file is missing or unsafe.");
            return (await File.ReadAllTextAsync(path, ct)).Trim();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new SourceException("Unconfigured", "The source credential file could not be read.");
        }
    }
}
