using System.Globalization;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.VisualBasic.FileIO;

internal static class PlanBench
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private sealed record Case(string Name, string WorkKey, string Kind, int? Season, int? Episode);
    private sealed record Row(string Title, int Run, double? FirstCandidate, double? FirstVerdict, double? Ready,
        double HttpMs, int Requests, int Probes, int CacheHits, string Bands, int Covered, int Targets,
        string Chosen, string Reasons, bool Lookalike, double? Baseline, string Status);
    private static readonly Case[] Cases =
    [
        new("Scorpion S1", "tvmaze:44", "series", 1, null),
        new("Little Fires Everywhere S1", "tvmaze:35319", "series", 1, null),
        new("Frieren S1", "anilist:154587", "anime", 1, null),
        new("Frieren S1E5", "anilist:154587", "anime", 1, 5),
        new("A Silent Voice", "anilist:20954", "anime", null, null),
        new("Prison Break S1", "tvmaze:541", "series", 1, null),
        new("Money Heist S1", "tvmaze:27436", "series", 1, null),
        new("Rick and Morty S1", "tvmaze:216", "series", 1, null),
        new("Sintel", "tmdb:movie:45745", "film", null, null),
        new("Big Buck Bunny", "tmdb:movie:10378", "film", null, null)
    ];

    internal static async Task<int> RunAsync(string[] args)
    {
        string Option(string name, string fallback)
        {
            var at = Array.IndexOf(args, name);
            if (at < 0) return fallback;
            if (at + 1 >= args.Length || args[at + 1].StartsWith("--", StringComparison.Ordinal))
                throw new ArgumentException($"Provide a value for {name}.");
            return args[at + 1];
        }
        if (args.Contains("--help"))
        {
            Console.WriteLine("bench plan --base http://127.0.0.1:3948 --label devplan --repeat 2 [--out tools\\.devplan-proof] [--only title] [--quality 1080] [--quality-floor 720] [--lane background] [--exhaust]");
            return 0;
        }
        var root = Directory.GetCurrentDirectory();
        while (!File.Exists(Path.Combine(root, "tools", "bench", "titles.json")))
            root = Directory.GetParent(root)?.FullName ?? throw new InvalidOperationException("Run inside the repository.");
        var output = Path.GetFullPath(Option("--out", Path.Combine(root, "tools", "bench", "results")));
        Directory.CreateDirectory(output);
        var label = Option("--label", "plan");
        if (label.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw new ArgumentException("Use a filename-safe label.");
        var stamp = label + "-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmm", CultureInfo.InvariantCulture);
        var repeats = int.Parse(Option("--repeat", "2"), CultureInfo.InvariantCulture);
        if (repeats is < 1 or > 10) throw new ArgumentException("repeat must be 1..10.");
        var only = Option("--only", "");
        var cases = Cases.Where(c => only.Length == 0 || c.Name.Contains(only, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (cases.Length == 0) throw new ArgumentException("No hard-set scopes matched.");
        var baseline = Baseline(Path.Combine(root, "tools", "bench", "results", "baseline-search-final-20261003-0509.csv"));
        using var http = new HttpClient { BaseAddress = new Uri(Option("--base", "http://127.0.0.1:3948")), Timeout = TimeSpan.FromMinutes(15) };
        var rows = new List<Row>();
        foreach (var scope in cases)
        {
            for (var run = 1; run <= repeats; run++)
            {
                var query = $"workKey={Uri.EscapeDataString(scope.WorkKey)}&kind={scope.Kind}&scope={(scope.Season is null ? "film" : scope.Episode is null ? "season" : "episode")}" +
                    $"&preferredQuality={Option("--quality", "1080")}&lane={Option("--lane", "owner")}";
                if (scope.Season is not null) query += $"&season={scope.Season}";
                if (scope.Episode is not null) query += $"&episode={scope.Episode}";
                if (args.Contains("--quality-floor")) query += $"&qualityFloor={Option("--quality-floor", "")}";
                if (args.Contains("--exhaust")) query += "&exhaust=true";
                var watch = System.Diagnostics.Stopwatch.StartNew();
                try
                {
                    using var response = await http.GetAsync("/api/dev/plan?" + query);
                    var body = await response.Content.ReadFromJsonAsync<JsonObject>(Json) ?? throw new InvalidOperationException("No JSON response.");
                    await File.WriteAllTextAsync(Path.Combine(output, stamp + "-" + scope.Name.Replace(' ', '-') + $"-{run}.json"),
                        body.ToJsonString(Json));
                    response.EnsureSuccessStatusCode();
                    var candidates = body["candidates"]!.AsArray().Select(c => c!.AsObject())
                        .ToDictionary(c => Text(c, "hash"), StringComparer.OrdinalIgnoreCase);
                    var assignments = body["plan"]!["assignments"]!.AsArray().Select(a => a!.AsObject()).ToArray();
                    var chosen = assignments.Select(a => Text(candidates[Text(a, "hash")], "name")).ToArray();
                    var chosenHashes = assignments.Select(a => Text(a, "hash")).ToHashSet(StringComparer.OrdinalIgnoreCase);
                    var lookalike = body["plan"]!["rejections"]!.AsArray()
                        .Any(r => Text(r, "code") == "wrong_work" && chosenHashes.Contains(Text(r, "hash"))) ||
                        scope.Name.StartsWith("Scorpion", StringComparison.Ordinal) &&
                        candidates.Values.Any(c => new string(Text(c, "name").Where(char.IsLetterOrDigit).ToArray())
                            .Contains("scorpionking", StringComparison.OrdinalIgnoreCase));
                    var targets = body["targets"]!.AsArray().Count;
                    var covered = assignments.Sum(a => a["targetIds"]!.AsArray().Count);
                    var baselineName = scope.Name.StartsWith("Frieren", StringComparison.Ordinal) ? "Frieren: Beyond Journey's End" :
                        scope.Season is null ? scope.Name : scope.Name[..scope.Name.LastIndexOf(" S", StringComparison.Ordinal)];
                    var bands = string.Join(" ", body["verdictCounts"]!.AsObject().Select(p => $"{p.Key}:{p.Value}"));
                    var row = new Row(scope.Name, run, Number(body["timeline"], "firstCandidateMs"),
                        Number(body["timeline"], "firstVerdictMs"), Number(body["timeline"], "planReadyMs"),
                        watch.Elapsed.TotalMilliseconds, (int)(Number(body, "sourceRequests") ?? 0),
                        (int)(Number(body, "probes") ?? 0), (int)(Number(body, "verdictCacheHits") ?? 0),
                        bands, covered, targets, string.Join(" | ", chosen),
                        string.Join(" | ", assignments.Select(a => Text(a, "reason")).Distinct()),
                        lookalike, baseline.GetValueOrDefault(baselineName),
                        lookalike ? "FAIL lookalike" : covered == targets ? "covered" : $"waiting {targets - covered}");
                    rows.Add(row);
                    Console.WriteLine($"{scope.Name} run {run}: first={row.FirstCandidate:0}ms verdict={row.FirstVerdict:0}ms ready={row.Ready:0}ms requests={row.Requests} probes={row.Probes} {bands} {row.Status}");
                }
                catch (Exception ex)
                {
                    rows.Add(new(scope.Name, run, null, null, null, watch.Elapsed.TotalMilliseconds,
                        0, 0, 0, "", 0, 0, "", "", false, null, "ERROR " + ex.Message));
                    Console.Error.WriteLine($"{scope.Name}: {ex.Message}");
                }
                await Save(output, stamp, rows);
            }
        }
        return rows.Any(r => r.Lookalike || r.Status.StartsWith("ERROR", StringComparison.Ordinal)) ? 1 : 0;
    }

    private static Dictionary<string, double?> Baseline(string path)
    {
        using var parser = new TextFieldParser(path) { HasFieldsEnclosedInQuotes = true };
        parser.SetDelimiters(",");
        var headers = parser.ReadFields()!;
        var title = Array.IndexOf(headers, "title");
        var latency = Array.IndexOf(headers, "first_result_ms");
        var result = new Dictionary<string, double?>(StringComparer.OrdinalIgnoreCase);
        while (!parser.EndOfData)
        {
            var fields = parser.ReadFields()!;
            result[fields[title]] = double.TryParse(fields[latency], CultureInfo.InvariantCulture, out var n) ? n : null;
        }
        return result;
    }

    private static async Task Save(string directory, string stamp, List<Row> rows)
    {
        static string Csv(object? value) => "\"" + (Convert.ToString(value, CultureInfo.InvariantCulture) ?? "").Replace("\"", "\"\"") + "\"";
        var csv = new StringBuilder("title,run,first_candidate_ms,first_verdict_ms,plan_ready_ms,http_ms,source_requests,probes,verdict_cache_hits,verdict_counts,covered,targets,chosen,reason,lookalike_survived,baseline_first_ms,status\n");
        var md = new StringBuilder("# Dry-run Find → Check → Plan\n\nNo Download or Target admission. Real swarms receive bounded probes only. Full candidates, selected files and every rejection are in the adjacent JSON replies.\n\n" +
            "Times exclude metadata lookup (reported separately in JSON). Plan-ready is null when coverage is incomplete. The Phase 0 first-result baseline is an atomic search response, not a checked plan; do not compare it to plan-ready as though it measured the same work.\n\n" +
            "| Scope | Run | First candidate ms | First verdict ms | Plan ready ms | Requests | Probes | Cache hits | Verdicts | Coverage | Lookalike | Baseline first ms |\n|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|---:|\n");
        foreach (var r in rows)
        {
            object?[] values = [r.Title, r.Run, r.FirstCandidate, r.FirstVerdict, r.Ready, r.HttpMs,
                r.Requests, r.Probes, r.CacheHits, r.Bands, r.Covered, r.Targets, r.Chosen, r.Reasons, r.Lookalike, r.Baseline, r.Status];
            csv.AppendLine(string.Join(",", values.Select(Csv)));
            md.AppendLine($"| {r.Title} | {r.Run} | {r.FirstCandidate:0} | {r.FirstVerdict:0} | {r.Ready:0} | {r.Requests} | {r.Probes} | {r.CacheHits} | {r.Bands} | {r.Covered}/{r.Targets} | {r.Lookalike} | {r.Baseline:0} |");
        }
        md.AppendLine("\n## Choices and reasons\n");
        foreach (var r in rows)
            md.AppendLine($"### {r.Title}, run {r.Run}\n\n{r.Status}\n\n{r.Chosen}\n\n{r.Reasons}\n");
        await File.WriteAllTextAsync(Path.Combine(directory, stamp + ".csv"), csv.ToString());
        await File.WriteAllTextAsync(Path.Combine(directory, stamp + ".md"), md.ToString());
    }
    private static string Text(JsonNode? node, string key) => node?[key]?.GetValue<string>() ?? "";
    private static double? Number(JsonNode? node, string key) => node?[key]?.GetValue<double>();
}
