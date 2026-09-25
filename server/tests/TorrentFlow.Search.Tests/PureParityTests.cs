using System.Text.Json;
using System.Text.Json.Nodes;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Search.Tests;

public sealed class PureParityTests
{
    public static IEnumerable<object[]> Cases()
    {
        using var file = File.OpenRead(Path.Combine(AppContext.BaseDirectory, "Fixtures", "typescript-pure.json.gz"));
        using var stream = new System.IO.Compression.GZipStream(file, System.IO.Compression.CompressionMode.Decompress);
        using var doc = JsonDocument.Parse(stream);
        return doc.RootElement.EnumerateArray().Select((entry, index) => new object[] { index, entry.Clone() }).ToArray();
    }
    [Theory]
    [MemberData(nameof(Cases))]
    public void TypeScript_assertion_inputs_produce_identical_outputs(int index, JsonElement test)
    {
        _ = index;
        var args = test.GetProperty("args");
        string S(int n = 0) => args.GetArrayLength() > n && args[n].ValueKind != JsonValueKind.Null ? args[n].GetString()! : "";
        int? N(int n) => args.GetArrayLength() > n && args[n].ValueKind != JsonValueKind.Null ? args[n].GetInt32() : null;
        MediaMetadata? Metadata(JsonElement value) => value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined ? null : value.Deserialize<MediaMetadata>(SearchCacheStore.Json);
        MediaMetadata? M(int n = 1) => args.GetArrayLength() > n ? Metadata(args[n]) : null;
        TorrentResult Input(JsonElement value) => new()
        {
            Id = "", Title = value.GetProperty("title").GetString()!, Source = value.TryGetProperty("source", out var source) && source.ValueKind != JsonValueKind.Null ? source.GetString()! : "",
            SourceUrl = "", Tags = value.TryGetProperty("tags", out var tags) ? tags.Deserialize<string[]>()! : [],
            Metadata = value.TryGetProperty("metadata", out var metadata) ? Metadata(metadata) : null
        };
        SeasonPlan Plan(JsonElement input) => EpisodeSelection.Plan(input.GetProperty("season").GetInt32(), input.GetProperty("wanted").Deserialize<int[]>()!,
            input.GetProperty("releases").Deserialize<TorrentResult[]>(SearchCacheStore.Json)!,
            r => input.GetProperty("verdicts").GetProperty(r.Id).GetString()!,
            input.TryGetProperty("preferredResolution", out var preferred) && preferred.ValueKind != JsonValueKind.Null ? preferred.GetInt32() : null);
        object? actual = test.GetProperty("method").GetString() switch
        {
            "parseEpisode" => EpisodeParser.Parse(S()),
            "parseResolution" => ReleaseQuality.ParseResolution(S()),
            "isJunkSource" => ReleaseQuality.IsJunkSource(S()),
            "isImplausible" => ReleaseQuality.IsImplausible(new TorrentResult { Id = "", Title = args[0].GetProperty("title").GetString()!, Source = "", SourceUrl = "", SizeBytes = args[0].TryGetProperty("sizeBytes", out var size) && size.ValueKind != JsonValueKind.Null ? size.GetInt64() : null }),
            "meetsResolutionFloor" => ReleaseQuality.MeetsResolutionFloor(S(), N(1)),
            "resolutionAffinity" => ReleaseQuality.ResolutionAffinity(N(0), N(1) ?? 1080),
            "relevanceTier" => ReleaseQuality.RelevanceTier(S(), S(1)),
            "stripEpisodeTokens" => ReleaseQuality.StripEpisodeTokens(S()),
            "parseSourceTier" => ReleaseQuality.ParseSourceTier(S()),
            "directPlayableFromTitle" => ReleaseQuality.DirectPlayableFromTitle(S()),
            "extractTags" => ReleaseQuality.ExtractTags(S()),
            "stripReleaseGroup" => ReleaseRanking.StripReleaseGroup(S()),
            "isExtrasRelease" => TorrentFilters.IsExtras(S()),
            "isUnsafeExecutableFileName" => TorrentFilters.IsUnsafeExecutable(S()),
            "normalizeInfoHash" or "base32ToHex" => InfoHash.Normalize(S()),
            "infoHashFromMagnet" => InfoHash.FromMagnet(S()),
            "verdictTier" => ReleaseQuality.VerdictTier(S()),
            "resolutionPreferenceTier" => ReleaseQuality.ResolutionPreferenceTier(S(), N(1)),
            "rankResults" => ReleaseRanking.Rank(args[0].Deserialize<TorrentResult[]>(SearchCacheStore.Json)!, S(1), N(2) ?? 1080, args.GetArrayLength() > 3 ? S(3) : "all"),
            "dedupeResults" => ReleaseRanking.Dedupe(args[0].Deserialize<TorrentResult[]>(SearchCacheStore.Json)!),
            "applyFilters" => TorrentFilters.Apply(args[0].Deserialize<TorrentResult[]>(SearchCacheStore.Json)!, args[1].Deserialize<Core.Contracts.Search.SearchFilters>(SearchCacheStore.Json)!),
            "detectContentKind" => ContentClassifier.Detect(Input(args[0]), args[0].TryGetProperty("searchCategory", out var category) && category.ValueKind != JsonValueKind.Null ? category.GetString() : null),
            "showFolderName" => ContentClassifier.ShowFolder(S(), M()),
            "segmentTitle" => ContentClassifier.CleanTitle(S()),
            "metadataMatchesTitle" => ContentClassifier.MetadataMatches(S(), M()),
            "pickCategoryLabel" => ContentClassifier.CategoryLabel(S(), args[1].Deserialize<string[]>()),
            "workIdentity" => WorkIdentityParser.Parse(S(), M()),
            "catalogAgrees" => WorkIdentityParser.CatalogAgrees(S(), S(1)),
            "metadataAgrees" => WorkIdentityParser.MetadataAgrees(S(), M()),
            "releaseYear" => ReleaseRanking.ReleaseYear(S()),
            "stripTrailingJunkNumber" => WorkIdentityParser.StripTrailingJunkNumber(S(), S(1)),
            "releaseMatchesWork" => WorkIdentityParser.Matches(S(), args[1].Deserialize<WorkMatchTarget>(SearchCacheStore.Json)!),
            "scoreRelease" => ReleaseQuality.ScoreRelease(S(), S(1), N(2)),
            "planSeason" => Plan(args[0]),
            "packEpisodeFiles" => EpisodeSelection.PackFiles(args[0].Deserialize<PackFile[]>(SearchCacheStore.Json)!, N(1)!.Value),
            "episodesFromFilenames" => EpisodeSelection.EpisodesFromFilenames(args[0].Deserialize<string[]>()!, N(1)!.Value),
            "packEpisodeRange" => EpisodeSelection.PackRange(S()),
            "matchesTargetEpisode" => EpisodeSelection.MatchesTarget(args[0].Deserialize<TorrentResult>(SearchCacheStore.Json)!, args[1].GetProperty("season").GetInt32(), args[1].GetProperty("episode").GetInt32()),
            "selectSeriesCandidateWithPackPreference" => EpisodeSelection.SelectCandidate(args[0].Deserialize<TorrentResult[]>(SearchCacheStore.Json)!, args[1].GetProperty("season").GetInt32(), args[1].GetProperty("episode").GetInt32()),
            "seasonCoverage" => EpisodeSelection.Coverage(S(), args.GetArrayLength() > 1 ? args[1].Deserialize<EpisodeInfo>(SearchCacheStore.Json) : null),
            "describeRelease" => ReleaseQuality.Describe(args[0].Deserialize<TorrentResult>(SearchCacheStore.Json)!, S(1), N(2) ?? 1080, args.GetArrayLength() > 3 ? S(3) : "all"),
            "compareReleases" => Math.Sign(ReleaseQuality.Compare(args[0].Deserialize<ReleaseRank>(SearchCacheStore.Json)!, args[1].Deserialize<ReleaseRank>(SearchCacheStore.Json)!)),
            "selectMainFeatureFile" => TorrentFilters.SelectMainFeature(args[0].Deserialize<SelectableFile[]>(SearchCacheStore.Json)!),
            "validateTorrentMediaPayload" => TorrentFilters.ValidatePayload(args[0].Deserialize<SelectableFile[]>(SearchCacheStore.Json)!),
            "showTitleFromQuery" => Adapters.EztvAdapter.ShowTitle(S()),
            "episodeFromQuery" => Adapters.EztvAdapter.EpisodeFromQuery(S()),
            _ => throw new InvalidOperationException(test.ToString())
        };
        var expected = JsonNode.Parse(test.GetProperty("expected").GetRawText());
        if (test.GetProperty("method").GetString() == "compareReleases") expected = JsonValue.Create(Math.Sign(test.GetProperty("expected").GetDouble()));
        var actualNode = JsonSerializer.SerializeToNode(actual, SearchCacheStore.Json);
        RemoveAddedNulls(actualNode, expected);
        Assert.True(JsonNode.DeepEquals(expected, actualNode), $"Case {index}: {test}\nActual: {actualNode}");
    }
    private static void RemoveAddedNulls(JsonNode? actual, JsonNode? expected)
    {
        if (actual is JsonArray a && expected is JsonArray e)
            for (var i = 0; i < Math.Min(a.Count, e.Count); i++) RemoveAddedNulls(a[i], e[i]);
        if (actual is JsonObject obj && expected is JsonObject expectedObj)
            foreach (var p in obj.ToArray())
                if (p.Value == null && !expectedObj.ContainsKey(p.Key)) obj.Remove(p.Key);
                else RemoveAddedNulls(p.Value, expectedObj[p.Key]);
    }
}
