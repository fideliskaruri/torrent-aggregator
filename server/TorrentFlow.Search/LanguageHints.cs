using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Search.Adapters;

namespace TorrentFlow.Search;

/// <summary>
/// Language hints before download (docs/release-language.md, "Hints before download"): AnimeTosho's per-file track lists
/// for anime candidates, by info hash, and apibay's file lists for TPB candidates, by TPB id. One fetcher per source, one
/// cache (the ReleaseHint table), a polite line per site, and a time budget per search: a missing or slow hint is no hint.
/// Each source's hosts are its registry entry's (base URL, then mirrors), the same ones its search uses, and a host that
/// keeps failing rests behind a breaker so a dead or frozen site never slows a search.
/// Hints only order releases and let an automatic pick skip a clear no-English one; the files decide once they are here.
/// </summary>
public sealed class LanguageHints(IndexerHttp http, IDbContextFactory<TorrentFlowDbContext> factory, ILogger<LanguageHints> logger,
    TorrentFlow.Core.Sources.SourceRegistry? registry = null, IHostApplicationLifetime? lifetime = null)
{
    public const string AnimeTosho = "animetosho";
    public const string Apibay = "apibay";
    /// <summary>Candidates per source looked up for one search, best ranked first.</summary>
    public const int Candidates = 8;
    /// <summary>The longest a search waits for its hints.</summary>
    public static readonly TimeSpan Budget = TimeSpan.FromSeconds(3);
    /// <summary>Gap between two hint request starts to one site. The site's searches keep their own pacing (1 s for AnimeTosho),
    /// so together they stay at about 2 requests a second. AnimeTosho answers a track list in about 2 s, so up to 3 may be open.</summary>
    public static readonly TimeSpan AnimeToshoSpacing = TimeSpan.FromSeconds(1);
    public static readonly TimeSpan ApibaySpacing = TimeSpan.FromSeconds(2);
    /// <summary>Lookups waiting in one site's line; past this a candidate gets no hint this time.</summary>
    public const int MaxWaiting = 16;
    /// <summary>An unfinished or missing answer is asked again after this, doubled for each such answer in a row (fresh
    /// episodes take AnimeTosho minutes to process).</summary>
    public static readonly TimeSpan PendingRetry = TimeSpan.FromMinutes(2);
    public static readonly TimeSpan MissingRetry = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan MaxRetry = TimeSpan.FromHours(24);
    /// <summary>A miss for a release out longer than this is kept for good: the index won't add it now.</summary>
    public static readonly TimeSpan PermanentMissAge = TimeSpan.FromDays(30);
    /// <summary>Failures in a row (no answer, a timeout, a server error or a page that isn't the feed) that rest a host.</summary>
    public const int BreakerFailures = 3;
    /// <summary>How long a failing host rests before one probe request.</summary>
    public static readonly TimeSpan BreakerRest = TimeSpan.FromMinutes(30);
    /// <summary>How long one lookup may take, waiting in the site's line included; also the probe's turn.</summary>
    private static readonly TimeSpan FetchBound = TimeSpan.FromSeconds(60);

    internal const string Complete = "complete";
    internal const string Pending = "pending";
    internal const string Missing = "missing";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };
    private readonly ConcurrentDictionary<string, Lazy<Task<LanguageHint?>>> flights = new(StringComparer.Ordinal);
    private readonly Line animeTosho = new(AnimeToshoSpacing, 3);
    private readonly Line apibay = new(ApibaySpacing, 1);
    private readonly Breaker breaker = new(logger);

    /// <param name="Fetch">Among the top <see cref="Candidates"/> of its source: asked for when not cached.</param>
    /// <param name="Released">The earliest date a site gave the release, when one did.</param>
    private sealed record Lookup(string ResultId, string Source, string Key, bool Fetch, DateTimeOffset? Released);

    /// <summary>
    /// The hints for the best ranked candidates, keyed by <see cref="TorrentResult.Id"/>: AnimeTosho for anime releases that
    /// AnimeTosho or nyaa listed, apibay for releases TPB listed (<paramref name="listings"/> holds every site's listing
    /// before duplicates were merged, so a release kept under another site's name still finds its TPB id). Cached answers
    /// come at once; the rest are fetched until <paramref name="wait"/> ends, and lookups still running then finish in the
    /// background for the next search.
    /// </summary>
    public async Task<IReadOnlyDictionary<string, LanguageHint>> FindAsync(IReadOnlyList<TorrentResult> ranked,
        IEnumerable<TorrentResult> listings, CancellationToken wait, CancellationToken ct)
    {
        var lookups = Pick(ranked, listings);
        var found = new Dictionary<string, LanguageHint>(StringComparer.Ordinal);
        if (lookups.Count == 0) return found;
        var keys = lookups.Select(l => l.Key).Distinct().ToList();
        Dictionary<(string, string), ReleaseHint> rows;
        try
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            rows = (await db.ReleaseHints.AsNoTracking().Where(h => keys.Contains(h.Key)).ToListAsync(ct))
                .ToDictionary(h => (h.Source, h.Key));
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            logger.LogDebug(e, "Language hint cache unavailable");
            return found;
        }
        var now = DateTime.UtcNow;
        var fetches = new List<(Lookup Lookup, Task<LanguageHint?> Work)>();
        foreach (var lookup in lookups)
        {
            var attempts = 0;
            if (rows.TryGetValue((lookup.Source, lookup.Key), out var row))
            {
                if (row.State == Complete) { Keep(found, lookup.ResultId, Read(lookup.Source, row.FilesJson)); continue; }
                // A miss or an unfinished answer holds while the source still uses the host that gave it: until RetryAt, or
                // for good without one. After the owner moves the source to another host, that host is asked afresh.
                if (row.Host is { } host && Endpoints(lookup.Source).Any(e => HostOf(e) == host))
                {
                    if (row.RetryAt is not { } retry || retry > now) continue;
                    attempts = row.Attempts;
                }
            }
            if (lookup.Fetch && Fetch(lookup, attempts) is { } work) fetches.Add((lookup, work));
        }
        if (fetches.Count > 0)
        {
            try { await Task.WhenAll(fetches.Select(f => f.Work)).WaitAsync(wait); }
            catch (OperationCanceledException) { }
            catch (Exception e) { logger.LogDebug(e, "Language hint lookup failed"); }
            foreach (var (lookup, work) in fetches)
                if (work.IsCompletedSuccessfully) Keep(found, lookup.ResultId, work.Result);
        }
        return found;
    }

    /// <summary>A release with both keeps AnimeTosho's track lists over a file list.</summary>
    private static void Keep(Dictionary<string, LanguageHint> found, string id, LanguageHint? hint)
    {
        if (hint == null || found.TryGetValue(id, out var known) && known.Source == LanguageHint.AnimeTosho) return;
        found[id] = hint;
    }

    /// <summary>
    /// Every candidate a hint could cover, in rank order, each hash or id once. Cached answers are read for all of them;
    /// only the top <see cref="Candidates"/> per source (<see cref="Lookup.Fetch"/>) are asked for when not cached.
    /// </summary>
    private List<Lookup> Pick(IReadOnlyList<TorrentResult> ranked, IEnumerable<TorrentResult> listings)
    {
        var anime = new HashSet<string>(StringComparer.Ordinal);
        var tpb = new Dictionary<string, string>(StringComparer.Ordinal);
        var released = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);
        foreach (var listing in listings)
        {
            if (Hash(listing) is not { } hash) continue;
            Note(released, hash, listing);
            if (WaitsForHint(listing)) anime.Add(hash);
            else if (listing.Source == Apibay && TpbId(listing) is { } id) tpb.TryAdd(hash, id);
        }
        var picked = new List<Lookup>();
        var animeCount = 0;
        var tpbCount = 0;
        var animeOn = Enabled(AnimeTosho);
        var tpbOn = Enabled(Apibay);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var r in ranked)
        {
            // A hash's files never change, so a cached AnimeTosho answer counts for whichever site listed it; only releases
            // AnimeTosho or nyaa listed are asked for.
            var hash = Hash(r);
            if (hash != null) Note(released, hash, r);
            var date = hash != null && released.TryGetValue(hash, out var at) ? at : Published(r);
            if (animeOn && hash != null && seen.Add($"{AnimeTosho}:{hash}"))
                picked.Add(new(r.Id, AnimeTosho, hash, anime.Contains(hash) && animeCount++ < Candidates, date));
            if (tpbOn && (hash != null && tpb.TryGetValue(hash, out var id) ? id : r.Source == Apibay ? TpbId(r) : null) is { } tpbId &&
                seen.Add($"{Apibay}:{tpbId}"))
                picked.Add(new(r.Id, Apibay, tpbId, tpbCount++ < Candidates, date));
        }
        return picked;
    }

    private static DateTimeOffset? Published(TorrentResult r) =>
        DateTimeOffset.TryParse(r.PublishedAt, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at : null;

    /// <summary>Keeps the earliest date any site gave a hash.</summary>
    private static void Note(Dictionary<string, DateTimeOffset> released, string hash, TorrentResult r)
    {
        if (Published(r) is { } at && (!released.TryGetValue(hash, out var known) || at < known)) released[hash] = at;
    }

    private static string? Hash(TorrentResult r) =>
        r.InfoHash?.Trim().ToLowerInvariant() is { Length: 40 } h && h.All(Uri.IsHexDigit) ? h : null;

    private static string? TpbId(TorrentResult r) => r.SiteId is { Length: > 0 } id && id.All(char.IsAsciiDigit) ? id : null;

    /// <summary>AnimeTosho mirrors nyaa's English-translated anime (1_2); its other anime categories come back not found.</summary>
    private static bool IsNyaaAnime(string? category) => category != null &&
        (category.Contains("English-translated", StringComparison.OrdinalIgnoreCase) && !category.Contains("Non-English", StringComparison.OrdinalIgnoreCase)
            || category == "1_2");

    /// <summary>An anime candidate AnimeTosho may know: a search with one waits for its track lists up to the budget.</summary>
    public static bool WaitsForHint(TorrentResult r) => r.InfoHash is { Length: 40 } &&
        (r.Source == AnimeTosho || r.Source == "nyaa" && IsNyaaAnime(r.Category));

    private bool Enabled(string id) => registry?.Find(id) is not { } entry || registry.IsEnabled(entry);

    /// <summary>One lookup per hash or id at a time; null when the site's line is full or every host of the source rests.</summary>
    private Task<LanguageHint?>? Fetch(Lookup lookup, int attempts)
    {
        var flight = $"{lookup.Source}:{lookup.Key}";
        if (flights.TryGetValue(flight, out var running)) return running.Value;
        if (Endpoints(lookup.Source).All(e => breaker.Resting(HostOf(e)))) return null;
        var line = lookup.Source == AnimeTosho ? animeTosho : apibay;
        if (line.Waiting >= MaxWaiting) return null;
        return flights.GetOrAdd(flight, name => new Lazy<Task<LanguageHint?>>(() => Task.Run(async () =>
        {
            try { return await FetchAsync(line, lookup, attempts); }
            finally { flights.TryRemove(name, out var _); }
        }))).Value;
    }

    /// <summary>
    /// Asks the source's hosts in order (base URL, then mirrors), skipping a resting one. Any answer from a host, a 404
    /// included, is that host's answer; a host that fails counts toward its breaker and the next one is asked.
    /// </summary>
    private async Task<LanguageHint?> FetchAsync(Line line, Lookup lookup, int attempts)
    {
        var (source, key) = (lookup.Source, lookup.Key);
        using var bounded = CancellationTokenSource.CreateLinkedTokenSource(lifetime?.ApplicationStopping ?? CancellationToken.None);
        bounded.CancelAfter(FetchBound);
        string? failed = null;
        foreach (var endpoint in Endpoints(source))
        {
            var host = HostOf(endpoint);
            if (breaker.Resting(host)) continue;
            var url = source == AnimeTosho ? $"{endpoint}/json?show=torrent&btih={key}" : $"{endpoint}/f.php?id={key}";
            (string State, IReadOnlyList<LanguageHintFile> Files, string Via) answer;
            var sent = false;
            try
            {
                // Checked again when the request's turn comes: lookups queued behind the failures that opened the breaker
                // send nothing, and the first one after a rest is the probe.
                var body = await line.RunAsync<string?>(async () =>
                {
                    if (!breaker.Allow(host)) return null;
                    sent = true;
                    return await http.GetAsync(url, IndexerHttp.BrowserAgent, timeoutMs: 8000,
                        accept: "application/json, text/plain, */*", cancellationToken: bounded.Token);
                }, bounded.Token);
                if (body is null) continue;
                answer = Parse(source, body);
                breaker.Answered(host);
                // An item out for over 30 days that the index still hasn't finished never will be (Anime Tosho NEW reports
                // the batches the original skipped as "unknown", with no files): that is a miss.
                if (answer.State == Pending && Old(lookup)) answer = (Missing, [], answer.Via);
            }
            catch (HttpRequestException e) when (e.StatusCode == HttpStatusCode.NotFound)
            {
                breaker.Answered(host);
                answer = (Missing, [], "none");
            }
            // The site is cooling down after a 429 (Retry-After is honoured by IndexerHttp): busy, not down, and not this
            // release's fault.
            catch (HttpRequestException e) when (e is SourceBusyException || e.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.ServiceUnavailable)
            {
                logger.LogInformation("Language hint {Source} {Key}: {Host} busy, no hint this time", source, key, host);
                return null;
            }
            catch (Exception e) when (e is HttpRequestException or JsonException or InvalidDataException or OperationCanceledException or TimeoutException)
            {
                // Still waiting in the site's line when time ran out, or shutting down: nothing was asked, so nothing to record.
                if (!sent || lifetime?.ApplicationStopping.IsCancellationRequested == true) return null;
                logger.LogDebug(e, "Language hint {Source} {Key} failed on {Host}", source, key, host);
                breaker.Failed(host, e);
                failed = host;
                continue;
            }
            await SaveAsync(lookup, answer.State, answer.Files, attempts, host);
            logger.LogInformation("Language hint {Source} {Key} from {Host}: {State}, {Files} file(s), tracks from {Via}",
                source, key, host, answer.State, answer.Files.Count, answer.Via);
            return answer.State == Complete && answer.Files.Count > 0 ? new LanguageHint(Kind(source), answer.Files) : null;
        }
        // Every host failed: ask again after the pending wait.
        if (failed != null) await SaveAsync(lookup, Pending, [], attempts, failed);
        return null;
    }

    private static (string State, IReadOnlyList<LanguageHintFile> Files, string Via) Parse(string source, string body)
    {
        if (source != AnimeTosho)
        {
            var (state, files) = ReadFileList(body);
            return (state, files, "file list");
        }
        var answer = AnimeToshoTracks.Read(body);
        return (answer.State, answer.Files, answer.Via);
    }

    private static string Kind(string source) => source == AnimeTosho ? LanguageHint.AnimeTosho : LanguageHint.FileList;

    /// <summary>Out for longer than <see cref="PermanentMissAge"/>, by the earliest date a site gave it.</summary>
    private static bool Old(Lookup lookup) => lookup.Released is { } released && DateTimeOffset.UtcNow - released > PermanentMissAge;

    /// <summary>The source's registry entry, base URL then mirrors: the hosts its search uses, which the owner sets.</summary>
    private IReadOnlyList<string> Endpoints(string source)
    {
        var entry = registry?.Find(source);
        var urls = (entry is null ? [] : new[] { entry.BaseUrl }.Concat(entry.Mirrors))
            .Where(u => !string.IsNullOrWhiteSpace(u)).Select(u => u.Trim().TrimEnd('/')).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        return urls.Count > 0 ? urls : [source == AnimeTosho ? AnimeToshoAdapter.DefaultBaseUrl : ApiBayAdapter.DefaultBaseUrl];
    }

    private static string HostOf(string endpoint) =>
        Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) ? uri.Authority.ToLowerInvariant() : endpoint.ToLowerInvariant();

    private async Task SaveAsync(Lookup lookup, string state, IReadOnlyList<LanguageHintFile> files, int attempts, string host)
    {
        var (source, key) = (lookup.Source, lookup.Key);
        try
        {
            await using var db = await factory.CreateDbContextAsync();
            var row = await db.ReleaseHints.FirstOrDefaultAsync(h => h.Source == source && h.Key == key);
            if (row is null) db.ReleaseHints.Add(row = new ReleaseHint { Id = Ids.New(), Source = source, Key = key });
            var now = DateTime.UtcNow;
            row.State = state;
            row.FetchedAt = now;
            row.Host = host;
            if (state == Complete)
            {
                row.FilesJson = JsonSerializer.Serialize(files, Json);
                row.Attempts = 0;
                row.RetryAt = null;
            }
            else
            {
                row.FilesJson = null;
                row.Attempts = attempts + 1;
                // The index won't add a release that has been out for over 30 days: that miss is kept for good.
                row.RetryAt = state == Missing && Old(lookup) ? null : now + RetryAfter(state, row.Attempts);
            }
            await db.SaveChangesAsync();
        }
        catch (DbUpdateException e) { logger.LogDebug(e, "Language hint {Source} {Key} raced another save", source, key); }
        catch (Exception e) when (e is not OperationCanceledException) { logger.LogDebug(e, "Language hint {Source} {Key} not saved", source, key); }
    }

    /// <summary>2 minutes for an item still processing, 10 for a miss, doubled per answer in a row, at most a day.</summary>
    internal static TimeSpan RetryAfter(string state, int attempts)
    {
        var first = state == Pending ? PendingRetry : MissingRetry;
        var wait = first * Math.Pow(2, Math.Clamp(attempts - 1, 0, 16));
        return wait > MaxRetry ? MaxRetry : wait;
    }

    private LanguageHint? Read(string source, string? json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try
        {
            return JsonSerializer.Deserialize<List<LanguageHintFile>>(json, Json) is { Count: > 0 } files ? new LanguageHint(Kind(source), files) : null;
        }
        catch (JsonException e)
        {
            logger.LogDebug(e, "Unreadable language hint for {Source}", source);
            return null;
        }
    }

    /// <summary>
    /// apibay's <c>f.php</c>: <c>[{"name":["Subs/English.srt"],"size":[72229]}]</c>, or one "Filelist not found" entry (missing).
    /// </summary>
    internal static (string State, IReadOnlyList<LanguageHintFile> Files) ReadFileList(string body)
    {
        using var doc = JsonDocument.Parse(body);
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return (Missing, []);
        var files = new List<LanguageHintFile>();
        foreach (var entry in doc.RootElement.EnumerateArray())
        {
            var path = First(entry, "name");
            if (string.IsNullOrWhiteSpace(path)) continue;
            if (path.Equals("Filelist not found", StringComparison.OrdinalIgnoreCase)) return (Missing, []);
            files.Add(new(path.Replace('\\', '/'), long.TryParse(First(entry, "size"), out var size) ? size : 0));
        }
        return files.Count == 0 ? (Missing, []) : (Complete, files);
    }

    private static string? First(JsonElement row, string key)
    {
        if (!row.TryGetProperty(key, out var value)) return null;
        var first = value.ValueKind switch
        {
            JsonValueKind.Array => value.EnumerateArray().FirstOrDefault(),
            JsonValueKind.Object => value.EnumerateObject().Select(p => p.Value).FirstOrDefault(),
            _ => value
        };
        return first.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null ? null : first.ToString();
    }

    /// <summary>
    /// Hosts that stopped answering. After <see cref="BreakerFailures"/> failures in a row a host gets no hint requests for
    /// <see cref="BreakerRest"/>, then one probe: an answer closes the breaker, a failure rests the host again. Logged once
    /// when it opens and once when the host answers again.
    /// </summary>
    private sealed class Breaker(ILogger logger)
    {
        private sealed class State
        {
            public int Failures;
            public DateTimeOffset? RestUntil;
        }

        private readonly ConcurrentDictionary<string, State> hosts = new(StringComparer.OrdinalIgnoreCase);

        public bool Resting(string host)
        {
            if (!hosts.TryGetValue(host, out var state)) return false;
            lock (state) return state.RestUntil > DateTimeOffset.UtcNow;
        }

        /// <summary>Whether a request may go now; the first one after a rest is the probe, and the rest wait for its answer.</summary>
        public bool Allow(string host)
        {
            if (!hosts.TryGetValue(host, out var state)) return true;
            lock (state)
            {
                if (state.RestUntil is not { } until) return true;
                var now = DateTimeOffset.UtcNow;
                if (now < until) return false;
                state.RestUntil = now + FetchBound;
                return true;
            }
        }

        public void Answered(string host)
        {
            if (!hosts.TryGetValue(host, out var state)) return;
            lock (state)
            {
                if (state.RestUntil != null) logger.LogInformation("Language hints: {Host} answers again, breaker closed", host);
                state.Failures = 0;
                state.RestUntil = null;
            }
        }

        public void Failed(string host, Exception error)
        {
            var state = hosts.GetOrAdd(host, _ => new State());
            lock (state)
            {
                state.Failures++;
                var now = DateTimeOffset.UtcNow;
                // The probe, or a request sent before the breaker opened, failed: rest again without another log line.
                if (state.RestUntil != null) { state.RestUntil = now + BreakerRest; return; }
                if (state.Failures < BreakerFailures) return;
                state.RestUntil = now + BreakerRest;
                logger.LogWarning("Language hints: {Host} failed {Failures} times in a row ({Error}); breaker open, no hint requests to it for {Minutes} minutes, then one probe",
                    host, state.Failures, error.Message, BreakerRest.TotalMinutes);
            }
        }
    }

    /// <summary>One site's hint requests: at most <paramref name="concurrency"/> open, starts at least <paramref name="spacing"/> apart.</summary>
    private sealed class Line(TimeSpan spacing, int concurrency)
    {
        private readonly SemaphoreSlim open = new(concurrency, concurrency);
        private readonly object gate = new();
        private DateTimeOffset next;
        private int waiting;
        public int Waiting => Volatile.Read(ref waiting);

        public async Task<T> RunAsync<T>(Func<Task<T>> send, CancellationToken ct)
        {
            Interlocked.Increment(ref waiting);
            try { await open.WaitAsync(ct); }
            finally { Interlocked.Decrement(ref waiting); }
            try
            {
                TimeSpan wait;
                lock (gate)
                {
                    var now = DateTimeOffset.UtcNow;
                    var start = next > now ? next : now;
                    next = start + spacing;
                    wait = start - now;
                }
                if (wait > TimeSpan.Zero) await Task.Delay(wait, ct);
                return await send();
            }
            finally { open.Release(); }
        }
    }
}
