using System.Collections.Concurrent;
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

    internal const string Complete = "complete";
    internal const string Pending = "pending";
    internal const string Missing = "missing";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };
    private readonly ConcurrentDictionary<string, Lazy<Task<LanguageHint?>>> flights = new(StringComparer.Ordinal);
    private readonly Line animeTosho = new(AnimeToshoSpacing, 3);
    private readonly Line apibay = new(ApibaySpacing, 1);

    /// <param name="Fetch">Among the top <see cref="Candidates"/> of its source: asked for when not cached.</param>
    private sealed record Lookup(string ResultId, string Source, string Key, bool Fetch);

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
            if (rows.TryGetValue((lookup.Source, lookup.Key), out var row))
            {
                if (row.State == Complete) { Keep(found, lookup.ResultId, Read(lookup.Source, row.FilesJson)); continue; }
                if (row.RetryAt > now) continue;
            }
            if (lookup.Fetch && Fetch(lookup.Source, lookup.Key, row?.Attempts ?? 0) is { } work) fetches.Add((lookup, work));
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
        foreach (var listing in listings)
        {
            if (Hash(listing) is not { } hash) continue;
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
            if (animeOn && hash != null && seen.Add($"{AnimeTosho}:{hash}"))
                picked.Add(new(r.Id, AnimeTosho, hash, anime.Contains(hash) && animeCount++ < Candidates));
            if (tpbOn && (hash != null && tpb.TryGetValue(hash, out var id) ? id : r.Source == Apibay ? TpbId(r) : null) is { } tpbId &&
                seen.Add($"{Apibay}:{tpbId}"))
                picked.Add(new(r.Id, Apibay, tpbId, tpbCount++ < Candidates));
        }
        return picked;
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

    /// <summary>One lookup per hash or id at a time; null when the site's line is already full.</summary>
    private Task<LanguageHint?>? Fetch(string source, string key, int attempts)
    {
        var flight = $"{source}:{key}";
        if (flights.TryGetValue(flight, out var running)) return running.Value;
        var line = source == AnimeTosho ? animeTosho : apibay;
        if (line.Waiting >= MaxWaiting) return null;
        return flights.GetOrAdd(flight, name => new Lazy<Task<LanguageHint?>>(() => Task.Run(async () =>
        {
            try { return await FetchAsync(line, source, key, attempts); }
            finally { flights.TryRemove(name, out var _); }
        }))).Value;
    }

    private async Task<LanguageHint?> FetchAsync(Line line, string source, string key, int attempts)
    {
        using var bounded = CancellationTokenSource.CreateLinkedTokenSource(lifetime?.ApplicationStopping ?? CancellationToken.None);
        bounded.CancelAfter(TimeSpan.FromSeconds(60));
        var url = source == AnimeTosho
            ? $"{BaseUrl(AnimeTosho, "https://feed.animetosho.org")}/json?show=torrent&btih={key}"
            : $"{BaseUrl(Apibay, "https://apibay.org")}/f.php?id={key}";
        (string State, IReadOnlyList<LanguageHintFile> Files) answer;
        var sent = false;
        try
        {
            var body = await line.RunAsync(() =>
            {
                sent = true;
                return http.GetAsync(url, IndexerHttp.BrowserAgent, timeoutMs: 8000,
                    accept: "application/json, text/plain, */*", cancellationToken: bounded.Token);
            }, bounded.Token);
            answer = source == AnimeTosho ? ReadAnimeTosho(body) : ReadFileList(body);
        }
        catch (HttpRequestException e) when (e.StatusCode == HttpStatusCode.NotFound)
        {
            answer = (Missing, []);
        }
        // The site is cooling down after a 429 (Retry-After is honoured by IndexerHttp): not this release's fault.
        catch (HttpRequestException e) when (e is SourceBusyException || e.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.ServiceUnavailable)
        {
            logger.LogInformation("Language hint {Source} {Key}: site busy, no hint this time", source, key);
            return null;
        }
        catch (Exception e) when (e is HttpRequestException or JsonException or InvalidDataException or OperationCanceledException or TimeoutException)
        {
            logger.LogDebug(e, "Language hint {Source} {Key} failed", source, key);
            // Still waiting in the site's line when time ran out, or shutting down: nothing was asked, so nothing to record.
            if (!sent || lifetime?.ApplicationStopping.IsCancellationRequested == true) return null;
            answer = (Pending, []);
        }
        await SaveAsync(source, key, answer.State, answer.Files, attempts);
        logger.LogInformation("Language hint {Source} {Key}: {State}, {Files} file(s)", source, key, answer.State, answer.Files.Count);
        return answer.State == Complete && answer.Files.Count > 0 ? new LanguageHint(Kind(source), answer.Files) : null;
    }

    private static string Kind(string source) => source == AnimeTosho ? LanguageHint.AnimeTosho : LanguageHint.FileList;

    private string BaseUrl(string id, string fallback) =>
        registry?.Find(id)?.BaseUrl is { Length: > 0 } configured ? configured.TrimEnd('/') : fallback;

    private async Task SaveAsync(string source, string key, string state, IReadOnlyList<LanguageHintFile> files, int attempts)
    {
        try
        {
            await using var db = await factory.CreateDbContextAsync();
            var row = await db.ReleaseHints.FirstOrDefaultAsync(h => h.Source == source && h.Key == key);
            if (row is null) db.ReleaseHints.Add(row = new ReleaseHint { Id = Ids.New(), Source = source, Key = key });
            var now = DateTime.UtcNow;
            row.State = state;
            row.FetchedAt = now;
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
                row.RetryAt = now + RetryAfter(state, row.Attempts);
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
    /// AnimeTosho's <c>json?show=torrent</c>: each file's subtitle attachments (language, name, default, forced) and, when it
    /// has one, the mediainfo text's audio tracks. Not processed yet, or no files: pending. Skipped: missing.
    /// </summary>
    internal static (string State, IReadOnlyList<LanguageHintFile> Files) ReadAnimeTosho(string body)
    {
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return (Missing, []);
        if (root.TryGetProperty("error", out _)) return (Missing, []);
        var status = Text(root, "status");
        // AnimeTosho never processes an item it skipped (batches, many non-English releases): ask again only rarely.
        if (string.Equals(status, "skipped", StringComparison.OrdinalIgnoreCase)) return (Missing, []);
        if (!string.Equals(status, Complete, StringComparison.OrdinalIgnoreCase) ||
            !root.TryGetProperty("files", out var list) || list.ValueKind != JsonValueKind.Array || list.GetArrayLength() == 0)
            return (Pending, []);
        var files = new List<LanguageHintFile>();
        foreach (var file in list.EnumerateArray())
        {
            var path = Text(file, "filename");
            if (string.IsNullOrWhiteSpace(path)) continue;
            var size = file.TryGetProperty("size", out var s) && s.TryGetInt64(out var n) ? n : 0;
            var processed = !file.TryGetProperty("processed", out var p) || p.ValueKind is JsonValueKind.True ||
                p.ValueKind == JsonValueKind.Number && p.GetInt32() != 0;
            files.Add(new(path, size, processed ? Tracks(file) : null));
        }
        // A video still unprocessed has no track list yet: ask again later.
        if (files.Count == 0 || files.Any(f => MediaFileRules.IsVideo(f.Path) && f.Tracks == null)) return (Pending, []);
        return (Complete, files);
    }

    private static List<MediaTrack> Tracks(JsonElement file)
    {
        var tracks = new List<MediaTrack>();
        if (file.TryGetProperty("attachments", out var attachments) && attachments.ValueKind == JsonValueKind.Array)
            foreach (var attachment in attachments.EnumerateArray())
            {
                if (Text(attachment, "type") != "subtitle" || !attachment.TryGetProperty("info", out var info) || info.ValueKind != JsonValueKind.Object) continue;
                var raw = Text(info, "lang");
                var number = Number(info, "tracknum") ?? Number(info, "trackid") ?? tracks.Count + 1;
                tracks.Add(new(number, MediaTrackKind.Subtitle, LanguageTag.Normalize(raw), raw, Flag(info, "default"),
                    !info.TryGetProperty("enabled", out _) || Flag(info, "enabled"), Flag(info, "forced"), Text(info, "name"),
                    Text(info, "codec"), MediaTrack.Indexer));
            }
        if (file.TryGetProperty("info", out var fileInfo) && fileInfo.ValueKind == JsonValueKind.Object && Text(fileInfo, "mediainfo") is { } mediainfo)
            tracks.AddRange(AudioTracks(mediainfo));
        return tracks;
    }

    /// <summary>The Audio sections of MediaInfo's text report: "Language : Japanese", "Title : Commentary", "Default : Yes".</summary>
    internal static IEnumerable<MediaTrack> AudioTracks(string mediainfo)
    {
        var tracks = new List<MediaTrack>();
        string? language = null, title = null, codec = null;
        bool inAudio = false, isDefault = false, forced = false;
        void Close()
        {
            if (inAudio)
                tracks.Add(new(1000 + tracks.Count, MediaTrackKind.Audio, ReleaseLanguage.LanguageCode(language), language, isDefault, true, forced,
                    title, codec, MediaTrack.Indexer));
            inAudio = false;
            language = title = codec = null;
            isDefault = forced = false;
        }
        foreach (var raw in mediainfo.Split('\n'))
        {
            var line = raw.Trim();
            var colon = line.IndexOf(':');
            if (colon < 0)
            {
                if (line.Length == 0) continue;
                Close();
                inAudio = line.StartsWith("Audio", StringComparison.OrdinalIgnoreCase);
                continue;
            }
            if (!inAudio) continue;
            var name = line[..colon].Trim();
            var value = line[(colon + 1)..].Trim();
            switch (name.ToLowerInvariant())
            {
                case "language": language ??= value; break;
                case "title": title ??= value; break;
                case "format": codec ??= value; break;
                case "default": isDefault = value.StartsWith("Yes", StringComparison.OrdinalIgnoreCase); break;
                case "forced": forced = value.StartsWith("Yes", StringComparison.OrdinalIgnoreCase); break;
            }
        }
        Close();
        return tracks;
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

    private static string? Text(JsonElement row, string key) =>
        row.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static int? Number(JsonElement row, string key) =>
        row.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var n) ? n : null;

    private static bool Flag(JsonElement row, string key) => row.TryGetProperty(key, out var value) &&
        (value.ValueKind == JsonValueKind.True || value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var n) && n != 0);

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
