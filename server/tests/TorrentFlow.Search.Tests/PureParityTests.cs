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
        if (test.GetProperty("method").GetString() == "rankResults")
        {
            AssertSwarmAwareRanking(index, test, expected!.AsArray(), actualNode!.AsArray());
            return;
        }
        RemoveAddedNulls(actualNode, expected);
        Assert.True(JsonNode.DeepEquals(expected, actualNode), $"Case {index}: {test}\nActual: {actualNode}");
    }

    /// <summary>
    /// The port ranks by live swarm health as well as quality, so it may deliberately reorder the TypeScript ranking —
    /// but only by lifting a better-seeded release. Everything else (the set, per-row derived fields) must match.
    /// </summary>
    private static void AssertSwarmAwareRanking(int index, JsonElement test, JsonArray expected, JsonArray actual)
    {
        static string Id(JsonNode? n) => $"{n!["id"]}|{n["title"]}|{n["seeders"]}|{n["sizeBytes"]}|{n["source"]}";
        static int Seeders(JsonNode? n) => n!["seeders"]?.GetValue<int>() ?? 0;
        static int Class(JsonNode? n) => ReleaseRanking.SwarmClass(new TorrentResult { Id = "", Title = "", Source = "", SourceUrl = "", Seeders = Seeders(n) });
        var message = $"Case {index}: {test}\nActual: {actual}";
        if (expected.Select(Id).Distinct().Count() != expected.Count)
        {
            // Indistinguishable rows: only the score scale may differ.
            foreach (var row in expected.Concat(actual).OfType<JsonObject>()) row.Remove("score");
            RemoveAddedNulls(actual, expected);
            Assert.True(JsonNode.DeepEquals(expected, actual), message);
            return;
        }
        Assert.True(expected.Select(Id).Order().SequenceEqual(actual.Select(Id).Order()), message);
        var position = actual.Select((n, i) => (Id(n), i)).ToDictionary(x => x.Item1, x => x.i);
        for (var i = 0; i < expected.Count; i++)
            for (var j = i + 1; j < expected.Count; j++)
            {
                var (x, y) = (expected[i], expected[j]);
                if (position[Id(x)] < position[Id(y)]) continue;
                Assert.True(Class(y) > Class(x) || Class(y) == Class(x) && Seeders(y) > Seeders(x), $"{Id(y)} jumped {Id(x)} without a better swarm. {message}");
            }
        var byId = actual.ToDictionary(Id);
        foreach (var e in expected)
        {
            var a = byId[Id(e)]!.DeepClone().AsObject();
            var eo = e!.DeepClone().AsObject();
            foreach (var field in new[] { "score", "bestPick" }) { a.Remove(field); eo.Remove(field); }
            RemoveAddedNulls(a, eo);
            Assert.True(JsonNode.DeepEquals(eo, a), $"Row {Id(e)} differs. {message}");
        }
        var groups = actual.Select(n => n!["groupKey"]?.GetValue<string>()).ToArray();
        for (var i = 0; i < actual.Count; i++)
            Assert.Equal(Array.IndexOf(groups, groups[i]) == i, actual[i]!["bestPick"]?.GetValue<bool>() == true);
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
