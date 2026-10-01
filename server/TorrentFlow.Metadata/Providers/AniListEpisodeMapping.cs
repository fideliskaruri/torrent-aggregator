using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Metadata.Caching;
using static TorrentFlow.Metadata.Providers.TmdbClient;

namespace TorrentFlow.Metadata.Providers;

/// <param name="Offset">Regular episodes aired by the entries before this one, so the entry's episode E is franchise
/// episode Offset + E. Null when an earlier entry is unfinished or the walk did not reach the first season.</param>
public sealed record AniListFranchiseEntry(AniListWork Work, int? Offset)
{
    public string Id => Work.Metadata.ExternalId;
}

/// <summary>An AniList entry's TV/ONA continuity in airing order: the first season, its sequels, and which one was asked for.</summary>
public sealed record AniListFranchise(IReadOnlyList<AniListFranchiseEntry> Entries, int RequestedIndex)
{
    public AniListFranchiseEntry Requested => Entries[RequestedIndex];
    public AniListFranchiseEntry Root => Entries[0];

    /// <summary>The entry and its own episode number for a franchise (absolute) episode, when offsets are known.</summary>
    public (AniListFranchiseEntry Entry, int Episode)? Locate(int absolute)
    {
        foreach (var entry in Entries)
            if (entry.Offset is { } offset && absolute > offset &&
                (entry.Work.EpisodeCount is not { } count || absolute <= offset + count))
                return (entry, absolute - offset);
        return null;
    }

    /// <summary>How many franchise episodes AniList says have aired, counted along the known offsets.</summary>
    public int AiredThrough => Entries.Where(e => e.Offset != null).Select(e => e.Offset!.Value + (e.Work.AiredEpisodeCount ?? 0))
        .DefaultIfEmpty(0).Max();
}

public sealed partial class AniListClient
{
    private const string ChainQuery = """
        query ($id: Int) {
          Media(id: $id, type: ANIME) {
            id title { english romaji native } synonyms format status episodes bannerImage seasonYear
            startDate { year month day } nextAiringEpisode { episode }
            relations { edges { relationType node { id type format } } }
          }
        }
        """;
    private readonly BoundedTtlCache<AnimeEpisodeMapping?> _mappings = new(300, time);
    private readonly SingleFlight<AnimeEpisodeMapping?> _mappingFlight = new();
    private readonly BoundedTtlCache<AniListFranchise?> _franchises = new(300, time);
    private readonly SingleFlight<AniListFranchise?> _franchiseFlight = new();
    private readonly BoundedTtlCache<JsonElement> _chainNodes = new(1000, time);

    public async Task<AnimeEpisodeMapping?> GetEpisodeMappingAsync(string id, CancellationToken ct = default)
    {
        if (!int.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out var numeric) || numeric < 1) return null;
        if (_mappings.TryGet(id, out var cached)) return cached;
        return await _mappingFlight.RunAsync(id, async () =>
        {
            var walk = await WalkAsync(numeric, sequels: false).ConfigureAwait(false);
            // A movie/OVA boundary or timeout invalidates absolute offsets, not the sequel identity already read.
            var result = walk.Current is { } current ? MapEpisodeChain([current, .. walk.Prequels], walk.Complete) : null;
            _mappings.Set(id, result, result?.AbsoluteOffset != null ? TimeSpan.FromHours(12) : TimeSpan.FromMinutes(5));
            return result;
        }, ct).ConfigureAwait(false);
    }

    /// <summary>The entry's franchise: prequels back to the first season, the entry, then released sequels.</summary>
    public async Task<AniListFranchise?> GetFranchiseAsync(string id, CancellationToken ct = default)
    {
        if (!int.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out var numeric) || numeric < 1) return null;
        if (_franchises.TryGet(id, out var cached)) return cached;
        return await _franchiseFlight.RunAsync(id, async () =>
        {
            var walk = await WalkAsync(numeric, sequels: true).ConfigureAwait(false);
            AniListFranchise? result = null;
            if (walk.Current is { } current)
            {
                var entries = new List<AniListFranchiseEntry>();
                int? offset = walk.Complete ? 0 : null;
                foreach (var node in Enumerable.Reverse(walk.Prequels).Append(current).Concat(walk.Sequels))
                {
                    var work = ToWork(node);
                    entries.Add(new(work, offset));
                    offset = offset is { } o && work.Status == "FINISHED" && work.EpisodeCount is { } count ? o + count : null;
                }
                result = new(entries, walk.Prequels.Count);
            }
            var settled = result?.Entries.All(e => e.Work.Status == "FINISHED") == true;
            _franchises.Set(id, result, settled ? TimeSpan.FromHours(12) : result is null ? TimeSpan.FromMinutes(5) : TimeSpan.FromMinutes(30));
            return result;
        }, ct).ConfigureAwait(false);
    }

    private sealed record ChainWalk(JsonElement? Current, List<JsonElement> Prequels, bool Complete, List<JsonElement> Sequels);

    /// <summary>
    /// One walk along single TV/ONA PREQUEL (and optionally SEQUEL) edges. Movies, specials, branching continuities and
    /// missing totals are not safe offsets, so the walk stops there; <c>Complete</c> says it reached the first season.
    /// </summary>
    private async Task<ChainWalk> WalkAsync(int id, bool sequels)
    {
        JsonElement? current = null;
        var prequels = new List<JsonElement>();
        var later = new List<JsonElement>();
        var complete = false;
        try
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(12));
            current = await ChainNodeAsync(id, deadline.Token).ConfigureAwait(false);
            if (current is not { } node) return new(null, prequels, false, later);
            var seen = new HashSet<int> { id };
            while (prequels.Count < 16)
            {
                if (Edges(node, "PREQUEL") is not { } edges) break;
                if (edges.Length == 0)
                {
                    complete = true;
                    break;
                }
                if (edges.Length != 1 || ChainTarget(edges[0]) is not { } next || !seen.Add(next) ||
                    await ChainNodeAsync(next, deadline.Token).ConfigureAwait(false) is not { } prequel) break;
                prequels.Add(prequel);
                node = prequel;
            }
            node = current.Value;
            while (sequels && later.Count < 16)
            {
                // A movie next to the next TV season is not a season; two TV sequels are a branch, so the walk stops.
                var next = Edges(node, "SEQUEL")?.Select(ChainTarget).OfType<int>().Distinct().ToArray();
                if (next is not { Length: 1 } || !seen.Add(next[0]) ||
                    await ChainNodeAsync(next[0], deadline.Token).ConfigureAwait(false) is not { } sequel ||
                    Str(sequel, "status") == "NOT_YET_RELEASED") break;
                later.Add(sequel);
                node = sequel;
            }
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or JsonException) { }
        return new(current, prequels, complete, later);
    }

    private static JsonElement[]? Edges(JsonElement media, string relationType) =>
        media.TryGetProperty("relations", out var relations) && relations.ValueKind == JsonValueKind.Object &&
        relations.TryGetProperty("edges", out var edges) && edges.ValueKind == JsonValueKind.Array
            ? edges.EnumerateArray().Where(e => Str(e, "relationType") == relationType).ToArray() : null;

    private static int? ChainTarget(JsonElement edge) =>
        edge.TryGetProperty("node", out var node) && Str(node, "type") == "ANIME" && Str(node, "format") is "TV" or "ONA" ? Int(node, "id") : null;

    private async Task<JsonElement?> ChainNodeAsync(int id, CancellationToken ct)
    {
        var key = id.ToString(CultureInfo.InvariantCulture);
        if (!_chainNodes.TryGet(key, out var media))
        {
            using var response = await PostAsync(ChainQuery, new JsonObject { ["id"] = id }, ct).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return null;
            using var doc = await TorrentFlow.Core.Http.BoundedHttpContent.ReadJsonAsync(response.Content, ct).ConfigureAwait(false);
            if (!doc.RootElement.TryGetProperty("data", out var data) || !data.TryGetProperty("Media", out var found) ||
                found.ValueKind != JsonValueKind.Object) return null;
            media = found.Clone();
            _chainNodes.Set(key, media, Str(media, "status") == "FINISHED" ? TimeSpan.FromHours(12) : TimeSpan.FromMinutes(30));
        }
        return Str(media, "format") is "TV" or "ONA" ? media : null;
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
