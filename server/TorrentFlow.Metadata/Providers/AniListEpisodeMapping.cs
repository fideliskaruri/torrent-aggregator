using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Metadata.Caching;
using static TorrentFlow.Metadata.Providers.TmdbClient;

namespace TorrentFlow.Metadata.Providers;

public sealed partial class AniListClient
{
    private const string MappingQuery = """
        query ($id: Int) {
          Media(id: $id, type: ANIME) {
            id title { english romaji native } synonyms format status episodes
            relations { edges { relationType node { id type format } } }
          }
        }
        """;
    private readonly BoundedTtlCache<AnimeEpisodeMapping?> _mappings = new(300, time);
    private readonly SingleFlight<AnimeEpisodeMapping?> _mappingFlight = new();

    public async Task<AnimeEpisodeMapping?> GetEpisodeMappingAsync(string id, CancellationToken ct = default)
    {
        if (!int.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out var numeric) || numeric < 1) return null;
        if (_mappings.TryGet(id, out var cached)) return cached;
        return await _mappingFlight.RunAsync(id, async () =>
        {
            AnimeEpisodeMapping? result = null;
            var chain = new List<JsonElement>();
            var complete = false;
            try
            {
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(12));
                var seen = new HashSet<int>();
                while (seen.Add(numeric) && chain.Count < 16)
                {
                    using var response = await PostAsync(MappingQuery, new JsonObject { ["id"] = numeric }, deadline.Token).ConfigureAwait(false);
                    if (!response.IsSuccessStatusCode) break;
                    using var doc = await TorrentFlow.Core.Http.BoundedHttpContent.ReadJsonAsync(response.Content, deadline.Token).ConfigureAwait(false);
                    if (!doc.RootElement.TryGetProperty("data", out var data) ||
                        !data.TryGetProperty("Media", out var media) || media.ValueKind != JsonValueKind.Object ||
                        Str(media, "format") is not ("TV" or "ONA")) break;
                    chain.Add(media.Clone());
                    if (!media.TryGetProperty("relations", out var relations) ||
                        !relations.TryGetProperty("edges", out var edges) || edges.ValueKind != JsonValueKind.Array) break;
                    var prequels = edges.EnumerateArray().Where(e => Str(e, "relationType") == "PREQUEL").ToArray();
                    if (prequels.Length == 0)
                    {
                        complete = true;
                        break;
                    }
                    // Movies, specials, branching continuities and missing totals are not safe offsets.
                    if (prequels.Length != 1 || !prequels[0].TryGetProperty("node", out var node) ||
                        Str(node, "type") != "ANIME" || Str(node, "format") is not ("TV" or "ONA") ||
                        Int(node, "id") is not { } next) break;
                    numeric = next;
                }
            }
            catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException) { }
            // A movie/OVA boundary or timeout invalidates absolute offsets, not the sequel identity already read.
            if (chain.Count > 0) result = MapEpisodeChain(chain, complete);
            _mappings.Set(id, result, result?.AbsoluteOffset != null ? TimeSpan.FromHours(12) : TimeSpan.FromMinutes(5));
            return result;
        }, ct).ConfigureAwait(false);
    }

    internal static AnimeEpisodeMapping MapEpisodeChain(IReadOnlyList<JsonElement> chain, bool complete = true)
    {
        var current = chain[0];
        var explicitSeason = ExplicitSeason(current);
        var prequelTitles = chain.Skip(1).SelectMany(Titles).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var isSequel = chain.Count > 1 || HasLaterPart(current) || explicitSeason is > 1;
        var franchiseTitles = chain.Count > 1 || complete ? Titles(chain[^1]).ToArray() : BaseTitles(current);
        var offset = 0;
        var seasonOffset = 0;
        for (var i = 1; i < chain.Count; i++)
        {
            var previous = chain[i];
            if (Str(previous, "status") != "FINISHED" || Int(previous, "episodes") is not (>= 1 and <= 5000))
                return new(HasLaterPart(current) ? null : explicitSeason, null, Titles(current).ToArray(), BaseTitles(current),
                    PrequelTitles: prequelTitles, IsSequel: isSequel);
            offset += Int(previous, "episodes")!.Value;
            if (explicitSeason != null && ExplicitSeason(previous) == explicitSeason)
                seasonOffset += Int(previous, "episodes")!.Value;
        }
        // Chain length is not a season number: split cours often have separate AniList entries.
        var season = explicitSeason ?? (complete && chain.Count == 1 ? 1 : (int?)null);
        if (!complete && HasLaterPart(current)) season = null;
        return new(season, complete ? offset : null, Titles(current).ToArray(), franchiseTitles,
            SeasonEpisodeOffset: seasonOffset, PrequelTitles: prequelTitles, IsSequel: isSequel);
    }

    private static int? ExplicitSeason(JsonElement media)
    {
        foreach (var title in Titles(media))
        {
            var match = Regex.Match(title, @"\b(?:Season\s*(?<n>\d{1,2})|(?<n>\d{1,2})(?:st|nd|rd|th)\s+Season|S(?<n>\d{1,2}))\b",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
            if (match.Success && int.TryParse(match.Groups["n"].Value, out var season) && season > 0) return season;
        }
        return null;
    }

    private static bool HasLaterPart(JsonElement media) => Titles(media).Any(title =>
        Regex.IsMatch(title, @"\b(?:Part|Cour)\s*(?:[2-9]|\d{2})\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
            TimeSpan.FromSeconds(1)));

    private static string[] BaseTitles(JsonElement media) => Titles(media).Select(title => (Title: title,
            Base: Regex.Replace(title, @"\s+(?:Season\s*\d{1,2}|\d{1,2}(?:st|nd|rd|th)\s+Season|S\d{1,2})(?:\s+(?:Part|Cour)\s*\d+)?\b",
                "", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1)).Trim()))
        .Where(n => n.Base.Length > 1 && n.Base != n.Title).Select(n => n.Base).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
}
