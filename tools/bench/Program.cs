using System.Diagnostics;
using System.Globalization;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

return await Bench.Run(args);

internal static class Bench
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    private static readonly CancellationTokenSource Stop = new();

    public static async Task<int> Run(string[] args)
    {
        if (args.FirstOrDefault() == "parse") return ParseBench.Run(args[1..]);
        Options options;
        try { options = Options.Parse(args); }
        catch (Exception e) { Console.Error.WriteLine(e.Message); return 2; }
        if (options.Help)
        {
            Console.WriteLine("dotnet run --project tools\\bench -- --base http://127.0.0.1:3931 --label baseline [--titles file] [--wait-seconds 120] [--search-only] [--only \"Sintel\"]");
            Console.WriteLine("dotnet run --project tools\\bench -c Release -- parse [--corpus file] [--iterations 10] [--stress] [--json file]");
            return 0;
        }
        var root = FindRoot();
        var journalPath = Path.Combine(root, "cleanup-pending.json");
        var results = new List<Result>();
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
        {
            BaseAddress = options.Base,
            Timeout = TimeSpan.FromSeconds(180)
        };
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; Stop.Cancel(); };
        try
        {
            var api = new Api(http);
            await api.Get("/api/client/torrents"); // Reachability and API contract, not the SPA fallback.
            if (File.Exists(journalPath))
            {
                var pending = JsonSerializer.Deserialize<Journal>(await File.ReadAllTextAsync(journalPath), JsonOptions)
                    ?? throw new InvalidOperationException("Unreadable cleanup journal.");
                if (pending.Base != options.Base.AbsoluteUri)
                    throw new InvalidOperationException("Pending cleanup belongs to a different server. Run against its original --base first.");
                await Cleanup(api, pending);
                File.Delete(journalPath);
            }
            var titlesPath = options.Titles is null ? Path.Combine(root, "titles.json") : Path.GetFullPath(options.Titles);
            var titles = JsonSerializer.Deserialize<List<Title>>(await File.ReadAllTextAsync(titlesPath), JsonOptions)
                ?? throw new InvalidOperationException("Title list must be an array.");
            if (options.Only is not null)
                titles = titles.Where(t => t.Name.Equals(options.Only, StringComparison.OrdinalIgnoreCase)).ToList();
            if (titles.Count == 0) throw new InvalidOperationException("No titles matched --only.");
            foreach (var title in titles)
            {
                if (Stop.IsCancellationRequested) break;
                Validate(title);
                var result = new Result { Title = title.Name, Kind = title.Kind, Year = title.Year, Season = title.Season };
                results.Add(result);
                Console.WriteLine($"Measuring {title.Name}...");
                try { await Measure(api, title, options, result, journalPath); }
                catch (Exception e) { result.Status = "failed"; result.Notes.Add(e.Message); Console.Error.WriteLine(e.Message); }
                WriteResults(root, options, results);
                // Never start another action while cleanup is uncertain.
                if (File.Exists(journalPath)) break;
            }
            if (Stop.IsCancellationRequested) return 130;
            return results.Any(r => r.Status is "failed" or "blocked" || r.Cleanup == "FAILED") ? 1 : 0;
        }
        catch (Exception e) { Console.Error.WriteLine($"Bench stopped: {e.Message}"); return 1; }
    }

    private static async Task Measure(Api api, Title title, Options options, Result result, string journalPath)
    {
        var identityClock = Stopwatch.StartNew();
        var hits = Rows(await api.Get($"/api/search/titles?q={E(title.Name)}&category=all&limit=30"), "results");
        result.TitleSearchMs = identityClock.ElapsedMilliseconds;
        var candidates = hits.Where(h => Number(h, "year") == title.Year &&
            Bool(h, "isSeries") == (title.Season is not null) &&
            (title.TmdbId is not null && Number(h["externalIds"], "tmdb") == title.TmdbId ||
             Normalize(Text(h, "title")) == Normalize(title.Name))).ToList();
        var hit = candidates.Count == 1 ? candidates[0] : null;
        if (hit is null) throw new InvalidOperationException("No unambiguous title/year/type identity from the server's title search.");
        result.WorkKey = Text(hit, "workKey");
        result.ResolvedTitle = Text(hit, "title");
        result.Provider = Text(hit, "provider");
        result.ProviderId = Text(hit, "providerId");
        var mediaType = Text(hit, "titleMediaType");
        if (mediaType.Length == 0) mediaType = Text(hit, "mediaType");
        var titlePath = $"/api/title/{E(result.WorkKey)}";
        var hints = $"t={E(title.Name)}&y={title.Year}&type={E(mediaType)}&provider={E(result.Provider)}&providerId={E(result.ProviderId)}";
        if (title.Season is not null) hints += $"&s={title.Season}";
        var detail = await api.Get($"{titlePath}?{hints}");
        var extras = await api.Get($"{titlePath}/extras?{hints}");
        var expected = title.Season is null ? new List<int> { 0 } :
            Rows(extras, "episodes").Where(e => DateTime.TryParse(Text(e, "airDate"), out var date) && date.Date <= DateTime.UtcNow.Date)
                .Select(e => (int)(Number(e, "episode") ?? 0)).Where(e => e > 0).Distinct().Order().ToList();
        if (title.Season is not null && expected.Count == 0)
            expected = Rows(detail, "episodes").Select(e => (int)(Number(e, "episode") ?? 0)).Where(e => e > 0).Distinct().Order().ToList();
        result.ExpectedTargets = expected.Count;
        var query = title.Name + (title.Season is null ? "" : $" S{title.Season:00}");
        result.SearchQuery = query;
        var searchClock = Stopwatch.StartNew();
        // This JSON API is atomic: first visible result arrives with the completed response.
        var poolResponse = await api.Get($"/api/search?q={E(query)}&pageSize=100");
        var pool = Rows(poolResponse, "results").ToList();
        result.FirstResultMs = pool.Count > 0 ? searchClock.ElapsedMilliseconds : null;
        result.SearchResponseMs = searchClock.ElapsedMilliseconds;
        result.PoolSize = (int)(Number(poolResponse, "totalCount") ?? pool.Count);
        var pages = (int)(Number(poolResponse, "totalPages") ?? 1);
        for (var page = 2; page <= pages; page++)
            pool.AddRange(Rows(await api.Get($"/api/search?q={E(query)}&pageSize=100&page={page}"), "results"));
        result.PoolReturned = pool.Count;
        result.Notes.Add("Search is an atomic JSON response; first-result latency is response completion, not an internal provider time. Search warms the cache before Download.");
        if (result.ResolvedTitle != title.Name) result.Notes.Add($"Catalog name: {result.ResolvedTitle}; release query and Download title remain English: {title.Name}.");
        if (options.SearchOnly) { result.Status = "search-only"; result.Cleanup = "not-needed"; return; }
        if (expected.Count == 0) throw new InvalidOperationException("No season episode inventory; refusing to claim all targets are accounted for.");
        var baseline = Rows(await api.Get("/api/client/torrents"), "torrents");
        var wantedBefore = Rows(await api.Get("/api/wanted"), "wanted");
        var progressBefore = await api.Get($"{titlePath}/progress");
        if (baseline.Any(r => Matches(r, result.WorkKey, title.Season)) ||
            wantedBefore.Any(r => Matches(r, result.WorkKey, title.Season)) || HasTargets(progressBefore, title.Season))
        {
            result.Status = "blocked";
            result.Cleanup = "not-needed";
            result.Notes.Add("Pre-existing downloads/targets overlap this scope. Refused to alter or remove them; use a clean sandbox copy for a full measurement.");
            return;
        }
        var journal = new Journal(options.Base.AbsoluteUri, result.WorkKey, title.Season,
            baseline.Select(Identity).ToArray());
        await File.WriteAllTextAsync(journalPath, JsonSerializer.Serialize(journal, JsonOptions));
        var samples = new Dictionary<string, Sample>(StringComparer.OrdinalIgnoreCase);
        var clock = Stopwatch.StartNew();
        var actionAttempted = false;
        try
        {
            actionAttempted = true; // A lost response can still have created targets.
            var post = await api.Post(titlePath, new
            {
                scope = title.Season is null ? "title" : "season",
                season = title.Season,
                episodes = title.Season is null ? null : expected,
                title = title.Name,
                mediaType,
                year = title.Year,
                provider = result.Provider,
                providerId = result.ProviderId,
                sourceType = Text(hit, "mediaType"),
                format = Text(hit, "format"),
                seasonComplete = title.Season is not null &&
                    Rows(extras, "episodes").Count == expected.Count
            });
            result.AcceptedMs = clock.ElapsedMilliseconds;
            var returnedKey = Text(post, "workKey");
            if (returnedKey.Length > 0 && returnedKey != result.WorkKey)
            {
                journal = journal with { WorkKey = returnedKey };
                result.WorkKey = returnedKey;
                await File.WriteAllTextAsync(journalPath, JsonSerializer.Serialize(journal, JsonOptions));
            }
            result.Notes.Add("Download response: " + Text(post, "message"));
            var previousReady = false;
            do
            {
                Stop.Token.ThrowIfCancellationRequested();
                var downloads = Rows(await api.Get("/api/client/torrents"), "torrents");
                var owned = downloads.Where(r => Matches(r, result.WorkKey, title.Season) && !journal.BaselineIds.Contains(Identity(r))).ToList();
                var wanted = Rows(await api.Get("/api/wanted"), "wanted").Where(r => Matches(r, result.WorkKey, title.Season)).ToList();
                var progress = await api.Get($"/api/title/{E(result.WorkKey)}/progress");
                result.DuplicateHashes = Math.Max(result.DuplicateHashes, Duplicates(owned, r => Text(r, "hash")));
                result.DuplicateTargets = Math.Max(result.DuplicateTargets, Duplicates(owned, TargetIdentity));
                foreach (var row in owned)
                {
                    var hash = Text(row, "hash");
                    var name = Text(row, "name");
                    var listed = pool.FirstOrDefault(p => Text(p, "infoHash").Equals(hash, StringComparison.OrdinalIgnoreCase));
                    var sample = new Sample
                    {
                        Hash = hash, Name = name, State = Text(row, "state"),
                        Episode = (int?)Number(row, "episode"),
                        ListedSeeds = Number(listed, "indexerSeeders") ?? Number(listed, "seeders"),
                        ConnectedPeers = Number(row["health"], "connectedPeers") ?? Number(row, "peers"),
                        ConnectedSeeds = Number(row["health"], "connectedSeeds") ?? Number(row, "seeds"),
                        Progress = Number(row, "progress"), Speed = Number(row, "dlspeed"),
                        ElapsedMs = clock.ElapsedMilliseconds,
                        Reason = Reason(row),
                        Replaced = Bool(row, "replaced")
                    };
                    if (samples.TryGetValue(hash, out var previous))
                    {
                        sample.PeakConnectedPeers = previous.PeakConnectedPeers is null && sample.ConnectedPeers is null
                            ? null : Math.Max(previous.PeakConnectedPeers ?? 0, sample.ConnectedPeers ?? 0);
                        sample.PeakConnectedSeeds = previous.PeakConnectedSeeds is null && sample.ConnectedSeeds is null
                            ? null : Math.Max(previous.PeakConnectedSeeds ?? 0, sample.ConnectedSeeds ?? 0);
                        sample.FirstBytesMs = previous.FirstBytesMs;
                    }
                    else
                    {
                        sample.PeakConnectedPeers = sample.ConnectedPeers;
                        sample.PeakConnectedSeeds = sample.ConnectedSeeds;
                    }
                    if ((sample.Progress > 0 || sample.Speed > 0) && sample.FirstBytesMs is null)
                        sample.FirstBytesMs = clock.ElapsedMilliseconds;
                    samples[hash] = sample;
                    foreach (var flag in Flags(name)) result.Flags.Add($"{hash}: {flag}");
                    // Some backends expose files on list rows; today's API does not.
                    if (row["files"] is JsonArray files)
                    {
                        result.FilesExposed = true;
                        foreach (var file in files)
                        {
                            var path = file is JsonValue ? file.ToString() : Text(file, "path");
                            if (path.Length == 0) path = Text(file, "name");
                            if (Regex.IsMatch(path, @"\.(exe|lnk|scr|zip)$", RegexOptions.IgnoreCase))
                                result.Flags.Add($"{hash}: unsafe payload {path}");
                        }
                    }
                }
                result.Samples = samples.Values.ToList();
                var ready = expected.All(episode => Accounted(episode, title.Season, owned, wanted, progress));
                // Two consecutive polls avoid counting a fleeting admitted state.
                if (ready && previousReady && result.AllTargetsMs is null) result.AllTargetsMs = clock.ElapsedMilliseconds;
                previousReady = ready;
                result.AccountedTargets = expected.Count(episode => Accounted(episode, title.Season, owned, wanted, progress));
                result.WaitReasons = wanted.Select(Reason).Where(s => s.Length > 0)
                    .Concat(owned.Where(r => !Bool(r, "replaced")).Select(Reason).Where(s => s.Length > 0)).Distinct().ToList();
                // Never wait for a seed-count sample at the cost of fetching a real title.
                if (!IsFree(title) && owned.Any(r => Number(r, "progress") > 0 || Number(r, "dlspeed") > 0))
                {
                    foreach (var row in owned.Where(r => Text(r, "state") is not "downloaded" and not "seeding"))
                        await api.Post("/api/client/torrents", new { action = "pause", hash = Text(row, "hash"),
                            ownerClientType = Text(row, "ownerClientType") });
                    result.Notes.Add($"Stopped real-title transfer at first observed bytes ({clock.Elapsed.TotalSeconds:F1}s); this is NOT a {options.WaitSeconds}s sample. Peer/seed evidence is limited to that interval.");
                    break;
                }
                if (clock.Elapsed.TotalSeconds >= options.WaitSeconds) break;
                await Task.Delay(TimeSpan.FromSeconds(Math.Min(1, options.WaitSeconds - clock.Elapsed.TotalSeconds)), Stop.Token);
            } while (true);
            result.ObservedMs = clock.ElapsedMilliseconds;
            result.Status = result.AccountedTargets == result.ExpectedTargets ? "accounted" : "stalled";
            if (result.Samples.Count == 0) result.Notes.Add("No release entered the engine during the observation.");
            if (!result.FilesExposed) result.Notes.Add("File lists and connected seed counts may be absent from the public API; blank means unavailable, never zero.");
        }
        finally
        {
            if (actionAttempted)
            {
                try
                {
                    await Cleanup(api, journal);
                    result.Cleanup = "verified";
                    File.Delete(journalPath);
                }
                catch (Exception e)
                {
                    result.Cleanup = "FAILED";
                    result.Notes.Add("Cleanup failed; persistent journal retained. " + e.Message);
                    throw;
                }
            }
        }
    }

    private static bool Accounted(int episode, int? season, List<JsonNode> rows, List<JsonNode> wanted, JsonNode? progress)
    {
        var matching = rows.Where(r => !Bool(r, "replaced") &&
            (season is null || Number(r, "episode") == episode)).ToList();
        if (matching.Any(r => Text(r, "state") is "downloaded" or "seeding")) return true;
        if (matching.Any(r => Text(r, "state") is "downloading" &&
            (Number(r, "dlspeed") > 0 || Number(r, "progress") > 0))) return true;
        if (matching.Any(r => Reason(r).Length > 0 && Text(r, "state") is not "error" and not "failed")) return true;
        if (wanted.Any(r => (season is null || Number(r, "episode") == episode) && !Bool(r, "looking") && Reason(r).Length > 0)) return true;
        var transfer = season is null ? progress?["transfer"] : progress?["episodeTransfers"]?[$"S{season:00}E{episode:00}"];
        return Text(transfer, "state") == "downloaded" ||
            (Text(transfer, "state").StartsWith("waiting", StringComparison.Ordinal) && Reason(transfer).Length > 0);
    }

    private static async Task Cleanup(Api api, Journal journal)
    {
        var query = $"workKey={E(journal.WorkKey)}" + (journal.Season is null ? "" : $"&season={journal.Season}");
        // Cancel wanted work first, so a search cannot refill Downloads after deletion.
        await api.Delete("/api/wanted?" + query);
        var stable = 0;
        for (var attempt = 0; attempt < 30; attempt++)
        {
            var rows = Rows(await api.Get("/api/client/torrents"), "torrents");
            var own = rows.Where(r => Matches(r, journal.WorkKey, journal.Season) && !journal.BaselineIds.Contains(Identity(r))).ToList();
            foreach (var row in own)
                await api.Post("/api/client/torrents", new { action = "delete", deleteFiles = true,
                    hash = Text(row, "hash"), ownerClientType = Text(row, "ownerClientType") });
            var wanted = Rows(await api.Get("/api/wanted"), "wanted");
            if (wanted.Any(r => Matches(r, journal.WorkKey, journal.Season)))
                await api.Delete("/api/wanted?" + query);
            var state = await api.Get($"/api/title/{E(journal.WorkKey)}/progress");
            var targetRemains = HasTargets(state, journal.Season);
            if (own.Count == 0 && !wanted.Any(r => Matches(r, journal.WorkKey, journal.Season)) && !targetRemains)
                stable++;
            else stable = 0;
            if (stable >= 3) return;
            await Task.Delay(1000); // Cleanup is intentionally not cancelled by Ctrl+C.
        }
        throw new InvalidOperationException("Downloads/wanted/title-progress still contain bench targets after cleanup.");
    }

    private static List<JsonNode> Rows(JsonNode? node, string key) =>
        node?[key] is JsonArray array ? array.OfType<JsonNode>().ToList() :
        throw new InvalidOperationException($"API contract missing array '{key}'.");
    private static string Text(JsonNode? node, string key) => node?[key]?.ToString() ?? "";
    private static double? Number(JsonNode? node, string key) =>
        double.TryParse(Text(node, key), NumberStyles.Float, Invariant, out var number) ? number : null;
    private static bool Bool(JsonNode? node, string key) => Text(node, key).Equals("true", StringComparison.OrdinalIgnoreCase);
    private static bool HasTargets(JsonNode? state, int? season) => season is null ? state?["transfer"] is JsonObject :
        state?["seasonTransfers"]?[season.Value.ToString(Invariant)] is JsonObject ||
        state?["episodeTransfers"] is JsonObject transfers && transfers.Any(p =>
            p.Key.StartsWith($"S{season:00}E", StringComparison.Ordinal) && p.Value is JsonObject);
    private static bool IsFree(Title title) => title.FreelyLicensed &&
        (Normalize(title.Name), title.Year) is ("sintel", 2010) or ("bigbuckbunny", 2008) or ("tearsofsteel", 2012);
    private static string E(string value) => Uri.EscapeDataString(value);
    private static string Normalize(string text) => Regex.Replace(text.ToLowerInvariant(), @"[^\p{L}\p{N}]", "");
    private static bool Matches(JsonNode row, string key, int? season) =>
        Text(row, "workKey") == key && (season is null ? row["season"] is null : Number(row, "season") == season);
    private static string Identity(JsonNode row) => Text(row, "ownerClientType") + ":" + Text(row, "hash").ToLowerInvariant();
    private static string TargetIdentity(JsonNode row) => $"{Text(row, "workKey")}:{Text(row, "targetScope")}:{Text(row, "season")}:{Text(row, "episode")}";
    private static int Duplicates(List<JsonNode> rows, Func<JsonNode, string> key) =>
        rows.GroupBy(key, StringComparer.OrdinalIgnoreCase).Where(g => g.Key.Length > 0).Sum(g => Math.Max(0, g.Count() - 1));
    private static string Reason(JsonNode? node) => new[] { "waitReason", "why", "heldReason", "languageNote", "error" }
        .Select(k => Text(node, k)).FirstOrDefault(s => !string.IsNullOrWhiteSpace(s)) ?? "";
    private static IEnumerable<string> Flags(string name)
    {
        if (Regex.IsMatch(name, @"(?i)(?<![a-z])(rus|russian|vostfr|french|german|deutsch|ita|italian|spanish|esp|castellano|latino|hindi|tamil|telugu|korean|raws?|jpn|japanese)(?![a-z])|LostFilm|NewStudio"))
            yield return "obvious foreign-language marker (heuristic, not an audio verdict)";
        if (Regex.IsMatch(name, @"(?i)(?<![a-z])(cam|hdcam|ts|telesync|telecine)(?![a-z])"))
            yield return "cam/TS marker";
        if (Regex.IsMatch(name, @"(?i)\.(exe|lnk|scr|zip)(?:$|[\s\]])"))
            yield return "unsafe payload name";
    }
    private static void Validate(Title t)
    {
        if (string.IsNullOrWhiteSpace(t.Name) || t.Kind is not ("movie" or "series" or "anime") || t.Year < 1900 ||
            t.Kind == "series" && t.Season is null || t.Season <= 0)
            throw new InvalidOperationException("Invalid title entry.");
    }
    private static string FindRoot()
    {
        var cwd = Directory.GetCurrentDirectory();
        if (File.Exists(Path.Combine(cwd, "tools", "bench", "Bench.csproj"))) return Path.Combine(cwd, "tools", "bench");
        if (File.Exists(Path.Combine(cwd, "Bench.csproj"))) return cwd;
        var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", ".."));
        if (File.Exists(Path.Combine(root, "Bench.csproj"))) return root;
        throw new InvalidOperationException("Cannot locate tools\\bench.");
    }

    private static void WriteResults(string root, Options options, List<Result> results)
    {
        var directory = Path.Combine(root, "results");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, options.Label + "-" + options.Timestamp);
        var columns = new[] { "title", "kind", "year", "season", "work_key", "provider", "provider_id", "title_search_ms", "query",
            "first_result_ms", "search_response_ms", "pool_size", "pool_returned", "expected_targets", "accounted_targets",
            "accepted_ms", "all_targets_ms", "observed_ms", "releases_json", "wait_reasons", "flags", "duplicate_hashes",
            "duplicate_targets", "files_exposed", "status", "cleanup", "notes" };
        var csv = new StringBuilder(string.Join(',', columns) + Environment.NewLine);
        foreach (var r in results)
        {
            object?[] values = [r.Title, r.Kind, r.Year, r.Season, r.WorkKey, r.Provider, r.ProviderId, r.TitleSearchMs,
                r.SearchQuery, r.FirstResultMs, r.SearchResponseMs, r.PoolSize, r.PoolReturned, r.ExpectedTargets, r.AccountedTargets,
                r.AcceptedMs, r.AllTargetsMs, r.ObservedMs, JsonSerializer.Serialize(r.Samples, JsonOptions),
                string.Join("; ", r.WaitReasons), string.Join("; ", r.Flags), r.DuplicateHashes, r.DuplicateTargets,
                r.FilesExposed, r.Status, r.Cleanup, string.Join(" ", r.Notes)];
            csv.AppendLine(string.Join(',', values.Select(v => "\"" + (Convert.ToString(v, Invariant) ?? "").Replace("\"", "\"\"") + "\"")));
        }
        File.WriteAllText(path + ".csv", csv.ToString(), new UTF8Encoding(false));
        var md = new StringBuilder($"# TorrentFlow benchmark: {options.Label}\n\nServer: `{options.Base}`. Started: {options.Timestamp}. Wait: {options.WaitSeconds}s. Search only: {options.SearchOnly}.\n\n");
        md.AppendLine("Blank timings/counts mean unavailable or not reached, not zero. Peer counts are connected peers, not advertised seeds. Real titles stop at first observed bytes; early samples are labelled. Pre-existing transfers are never deleted.\n");
        md.AppendLine("| Title | First result ms | Pool | All targets ms | Accounted | Observed s | Releases | Duplicates hash/target | Status | Cleanup |");
        md.AppendLine("|---|---:|---:|---:|---:|---:|---:|---:|---|---|");
        foreach (var r in results)
            md.AppendLine($"| {Md(r.Title)} | {r.FirstResultMs} | {r.PoolSize} | {r.AllTargetsMs} | {r.AccountedTargets}/{r.ExpectedTargets} | {(r.ObservedMs / 1000d)?.ToString("F1", Invariant)} | {r.Samples.Count} | {r.DuplicateHashes}/{r.DuplicateTargets} | {r.Status} | {r.Cleanup} |");
        foreach (var r in results)
        {
            md.AppendLine($"\n## {r.Title}\n\nIdentity: `{r.WorkKey}` ({r.Provider}:{r.ProviderId}); query: `{r.SearchQuery}`.");
            foreach (var sample in r.Samples)
                md.AppendLine($"- `{sample.Hash}` {sample.Name}: {sample.State}; listed seeds {sample.ListedSeeds?.ToString(Invariant) ?? "unavailable"}; connected peers {sample.ConnectedPeers?.ToString(Invariant) ?? "unavailable"} (peak {sample.PeakConnectedPeers?.ToString(Invariant) ?? "unavailable"}); connected seeds {sample.ConnectedSeeds?.ToString(Invariant) ?? "unavailable"}; progress {sample.Progress?.ToString("P2", Invariant)}; first bytes {(sample.FirstBytesMs is null ? "not observed" : sample.FirstBytesMs.Value.ToString(Invariant) + "ms")}; at {sample.ElapsedMs / 1000d:F1}s{(sample.Replaced ? " (replaced)" : "")}. {sample.Reason}");
            foreach (var flag in r.Flags) md.AppendLine("- FLAG: " + flag);
            foreach (var reason in r.WaitReasons) md.AppendLine("- Wait: " + reason);
            foreach (var note in r.Notes) md.AppendLine("- " + note);
        }
        File.WriteAllText(path + ".md", md.ToString(), new UTF8Encoding(false));
        Console.WriteLine(path + ".md");
    }
    private static string Md(string text) => text.Replace("|", "\\|").Replace("\n", " ");
}

internal sealed class Api(HttpClient http)
{
    public Task<JsonNode?> Get(string path) => Send(HttpMethod.Get, path, null);
    public Task<JsonNode?> Post(string path, object body) => Send(HttpMethod.Post, path, body);
    public Task<JsonNode?> Delete(string path) => Send(HttpMethod.Delete, path, null);
    private async Task<JsonNode?> Send(HttpMethod method, string path, object? body)
    {
        using var request = new HttpRequestMessage(method, path);
        if (body is not null) request.Content = JsonContent.Create(body);
        using var response = await http.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"{method} {path}: HTTP {(int)response.StatusCode}: {text}");
        var json = text.Length == 0 ? null : JsonNode.Parse(text);
        if (json?["ok"]?.ToString().Equals("false", StringComparison.OrdinalIgnoreCase) == true)
            throw new InvalidOperationException($"{method} {path}: {json["message"] ?? json["error"]}");
        return json;
    }
}

internal sealed record Title(string Name, string Kind, int Year, int? Season, int? TmdbId, string Set, bool FreelyLicensed);
internal sealed record Journal(string Base, string WorkKey, int? Season, string[] BaselineIds);
internal sealed class Sample
{
    public string Hash { get; set; } = "";
    public string Name { get; set; } = "";
    public string State { get; set; } = "";
    public int? Episode { get; set; }
    public double? ListedSeeds { get; set; }
    public double? ConnectedPeers { get; set; }
    public double? ConnectedSeeds { get; set; }
    public double? PeakConnectedPeers { get; set; }
    public double? PeakConnectedSeeds { get; set; }
    public long? FirstBytesMs { get; set; }
    public double? Progress { get; set; }
    public double? Speed { get; set; }
    public long ElapsedMs { get; set; }
    public string Reason { get; set; } = "";
    public bool Replaced { get; set; }
}
internal sealed class Result
{
    public string Title { get; set; } = "";
    public string Kind { get; set; } = "";
    public int Year { get; set; }
    public int? Season { get; set; }
    public string ResolvedTitle { get; set; } = "";
    public string WorkKey { get; set; } = "";
    public string Provider { get; set; } = "";
    public string ProviderId { get; set; } = "";
    public string SearchQuery { get; set; } = "";
    public long? TitleSearchMs { get; set; }
    public long? FirstResultMs { get; set; }
    public long? SearchResponseMs { get; set; }
    public int PoolSize { get; set; }
    public int PoolReturned { get; set; }
    public int ExpectedTargets { get; set; }
    public int AccountedTargets { get; set; }
    public long? AcceptedMs { get; set; }
    public long? AllTargetsMs { get; set; }
    public long? ObservedMs { get; set; }
    public int DuplicateHashes { get; set; }
    public int DuplicateTargets { get; set; }
    public bool FilesExposed { get; set; }
    public string Status { get; set; } = "";
    public string Cleanup { get; set; } = "not-needed";
    public List<Sample> Samples { get; set; } = [];
    public List<string> WaitReasons { get; set; } = [];
    public HashSet<string> Flags { get; set; } = [];
    public List<string> Notes { get; set; } = [];
}
internal sealed record Options(Uri Base, string Label, string? Titles, int WaitSeconds, bool SearchOnly, string? Only, bool Help, string Timestamp)
{
    public static Options Parse(string[] args)
    {
        string? baseUrl = null, label = null, titles = null, only = null;
        var wait = 120;
        var searchOnly = false;
        var help = false;
        for (var i = 0; i < args.Length; i++)
        {
            string Value() => ++i < args.Length ? args[i] : throw new ArgumentException($"Missing value for {args[i - 1]}.");
            switch (args[i])
            {
                case "--base": baseUrl = Value(); break;
                case "--label": label = Value(); break;
                case "--titles": titles = Value(); break;
                case "--wait-seconds": wait = int.Parse(Value(), CultureInfo.InvariantCulture); break;
                case "--only": only = Value(); break;
                case "--search-only": searchOnly = true; break;
                case "--help": help = true; break;
                default: throw new ArgumentException("Unknown argument: " + args[i]);
            }
        }
        if (help) return new(new Uri("http://127.0.0.1:3931"), "help", null, 120, true, null, true, "");
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri) || !uri.IsLoopback || uri.Scheme != "http" ||
            uri.Port is < 3921 or > 3940 || uri.Port == 3930 || uri.AbsolutePath != "/" || uri.Query.Length > 0 ||
            uri.UserInfo.Length > 0 || uri.Fragment.Length > 0)
            throw new ArgumentException("--base must be a loopback HTTP sandbox on ports 3921–3940, never live port 3930.");
        if (string.IsNullOrWhiteSpace(label) || !Regex.IsMatch(label, @"^[A-Za-z0-9][A-Za-z0-9_-]*$"))
            throw new ArgumentException("--label must contain only letters, digits, underscores or hyphens.");
        if (wait is < 1 or > 3600) throw new ArgumentException("--wait-seconds must be 1–3600.");
        return new(uri, label, titles, wait, searchOnly, only, false, DateTime.Now.ToString("yyyyMMdd-HHmm", CultureInfo.InvariantCulture));
    }
}
