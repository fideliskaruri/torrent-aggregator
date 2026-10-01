using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace TorrentFlow.Metadata.Links;

/// <summary>One entry of the Fribb anime-lists map: one AniList/MAL record and its ids elsewhere.</summary>
public sealed record AnimeListEntry(string? Type, int? AniList, int? Mal, int? AniDb, int? Tvdb, int? TmdbTv, IReadOnlyList<int> TmdbMovies,
    IReadOnlyList<string> Imdb, int? TmdbSeason);

/// <summary>
/// The Fribb anime-lists map (<c>anime-list-full.json</c>), cached at <c>&lt;data&gt;/anime-lists/</c> and indexed by
/// AniList, MAL, TMDB (movie and tv apart) and IMDb id. Refreshed weekly in the background with a conditional GET; a
/// failed or offline refresh keeps the cached file, and with no file at all <see cref="Version"/> is "none" and nothing
/// is found. Startup and requests never wait on the download.
/// </summary>
public sealed class AnimeListsMap(IConfiguration configuration, IHttpClientFactory http, TimeProvider time, ILogger<AnimeListsMap> logger)
    : BackgroundService
{
    public const string HttpClientName = "TorrentFlow.AnimeLists";
    public const string DefaultUrl = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json";
    public const string NoMap = "none";
    private static readonly TimeSpan RefreshEvery = TimeSpan.FromDays(7);
    private static readonly TimeSpan CheckEvery = TimeSpan.FromHours(6);

    private sealed record Index(string Version, Dictionary<int, AnimeListEntry> AniList, Dictionary<int, AnimeListEntry> Mal,
        Dictionary<int, List<AnimeListEntry>> TmdbTv, Dictionary<int, List<AnimeListEntry>> TmdbMovie, Dictionary<string, List<AnimeListEntry>> Imdb);

    private sealed record Meta(string? ETag, string? LastModified, DateTimeOffset FetchedAt);

    private volatile Index? _index;
    private readonly TaskCompletionSource _loaded = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _checked = new(TaskCreationOptions.RunContinuationsAsynchronously);

    private string Folder => Path.Combine(configuration["TorrentFlow:DataDirectory"] ?? Path.Combine(AppContext.BaseDirectory, "data"), "anime-lists");
    private string FilePath => Path.Combine(Folder, "anime-list-full.json");
    private string MetaPath => Path.Combine(Folder, "anime-list-full.meta.json");
    private string Url => configuration["TorrentFlow:AnimeLists:Url"] is { Length: > 0 } url ? url : DefaultUrl;

    /// <summary>The loaded map's version (a hash of the file), or "none" when there is no map.</summary>
    public string Version => _index?.Version ?? NoMap;

    /// <summary>Completes once the cached file was read (or found missing) at startup; it never waits on a download.</summary>
    public Task Loaded => _loaded.Task;

    /// <summary>Completes after the first download check of this run, whether it succeeded, failed or found the copy current.</summary>
    public Task Checked => _checked.Task;

    public AnimeListEntry? ByAniList(int id) => _index?.AniList.GetValueOrDefault(id);
    public AnimeListEntry? ByMal(int id) => _index?.Mal.GetValueOrDefault(id);
    public IReadOnlyList<AnimeListEntry> ByTmdb(string mediaType, int id) =>
        (mediaType == "movie" ? _index?.TmdbMovie : _index?.TmdbTv)?.GetValueOrDefault(id) ?? [];
    public IReadOnlyList<AnimeListEntry> ByImdb(string id) => _index?.Imdb.GetValueOrDefault(id) ?? [];

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Yield();
        try { await LoadAsync(stoppingToken); }
        finally { _loaded.TrySetResult(); }
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await RefreshIfDueAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
            catch (Exception error) { logger.LogWarning("Could not refresh the anime-lists map from {Url}; keeping the cached copy: {Error}", Url, error.Message); }
            finally { _checked.TrySetResult(); }
            try { await Task.Delay(CheckEvery, time, stoppingToken); }
            catch (OperationCanceledException) { return; }
        }
    }

    private async Task LoadAsync(CancellationToken ct)
    {
        if (!File.Exists(FilePath))
        {
            logger.LogInformation("No anime-lists map cached yet at {Path}; links come from provider ids until it downloads", FilePath);
            return;
        }
        try
        {
            var bytes = await File.ReadAllBytesAsync(FilePath, ct);
            _index = Parse(bytes);
            logger.LogInformation("Anime-lists map loaded: {Count} AniList entries, version {Version}", _index.AniList.Count, _index.Version);
        }
        catch (Exception error) when (error is JsonException or IOException)
        {
            logger.LogWarning(error, "The cached anime-lists map at {Path} could not be read", FilePath);
        }
    }

    private async Task RefreshIfDueAsync(CancellationToken ct)
    {
        var meta = ReadMeta();
        if (_index != null && meta != null && time.GetUtcNow() - meta.FetchedAt < RefreshEvery) return;
        using var request = new HttpRequestMessage(HttpMethod.Get, Url);
        if (_index != null && meta != null)
        {
            if (meta.ETag != null && EntityTagHeaderValue.TryParse(meta.ETag, out var tag)) request.Headers.IfNoneMatch.Add(tag);
            if (meta.LastModified != null && DateTimeOffset.TryParse(meta.LastModified, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var since))
                request.Headers.IfModifiedSince = since;
        }
        using var client = http.CreateClient(HttpClientName);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.StatusCode == HttpStatusCode.NotModified && meta != null)
        {
            WriteMeta(meta with { FetchedAt = time.GetUtcNow() });
            logger.LogInformation("Anime-lists map is unchanged (version {Version})", Version);
            return;
        }
        if (!response.IsSuccessStatusCode)
        {
            logger.LogWarning("Anime-lists map download from {Url} answered {Status}; keeping the cached copy", Url, (int)response.StatusCode);
            return;
        }
        var bytes = await response.Content.ReadAsByteArrayAsync(ct);
        var index = Parse(bytes);
        if (index.AniList.Count == 0) throw new JsonException("The anime-lists map had no entries.");
        Directory.CreateDirectory(Folder);
        var partial = FilePath + ".part";
        await File.WriteAllBytesAsync(partial, bytes, ct);
        File.Move(partial, FilePath, overwrite: true);
        WriteMeta(new(response.Headers.ETag?.ToString(), response.Content.Headers.LastModified?.ToString("R"), time.GetUtcNow()));
        var previous = Version;
        _index = index;
        logger.LogInformation("Anime-lists map downloaded: {Count} AniList entries, version {Version} (was {Previous})", index.AniList.Count, index.Version, previous);
    }

    private Meta? ReadMeta()
    {
        try { return File.Exists(MetaPath) ? JsonSerializer.Deserialize<Meta>(File.ReadAllText(MetaPath)) : null; }
        catch (Exception error) when (error is JsonException or IOException) { return null; }
    }

    private void WriteMeta(Meta meta)
    {
        Directory.CreateDirectory(Folder);
        File.WriteAllText(MetaPath, JsonSerializer.Serialize(meta));
    }

    /// <summary>
    /// Reads the map. Schema checked on 2 Oct 2026: <c>themoviedb_id</c> is an object, <c>{"tv": 30984}</c> or
    /// <c>{"movie": [378064]}</c>; <c>imdb_id</c> is an array; <c>season</c> is <c>{"tvdb": 17, "tmdb": 2}</c>. Plain
    /// numbers and strings (older copies) are read too.
    /// </summary>
    private static Index Parse(byte[] bytes)
    {
        var version = Convert.ToHexString(SHA256.HashData(bytes))[..12].ToLowerInvariant();
        var index = new Index(version, [], [], [], [], new(StringComparer.OrdinalIgnoreCase));
        using var doc = JsonDocument.Parse(bytes);
        if (doc.RootElement.ValueKind != JsonValueKind.Array) throw new JsonException("The anime-lists map is not an array.");
        foreach (var e in doc.RootElement.EnumerateArray())
        {
            if (e.ValueKind != JsonValueKind.Object) continue;
            var type = e.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            int? tv = null;
            var movies = new List<int>();
            if (e.TryGetProperty("themoviedb_id", out var tmdb))
            {
                if (tmdb.ValueKind == JsonValueKind.Object)
                {
                    if (tmdb.TryGetProperty("tv", out var tvs) && Ints(tvs).FirstOrDefault() is > 0 and var first) tv = first;
                    if (tmdb.TryGetProperty("movie", out var ms)) movies.AddRange(Ints(ms).Where(n => n > 0));
                }
                else if (Ints(tmdb).FirstOrDefault() is > 0 and var plain)
                {
                    if (string.Equals(type, "MOVIE", StringComparison.OrdinalIgnoreCase)) movies.Add(plain); else tv = plain;
                }
            }
            var imdb = new List<string>();
            if (e.TryGetProperty("imdb_id", out var im))
            {
                if (im.ValueKind == JsonValueKind.Array) imdb.AddRange(im.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!));
                else if (im.ValueKind == JsonValueKind.String) imdb.Add(im.GetString()!);
            }
            imdb = imdb.Where(x => x.StartsWith("tt", StringComparison.OrdinalIgnoreCase)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            int? season = null;
            if (e.TryGetProperty("season", out var s) && s.ValueKind == JsonValueKind.Object && s.TryGetProperty("tmdb", out var st)
                && st.ValueKind == JsonValueKind.Number && st.TryGetInt32(out var n) && n >= 0) season = n;
            var entry = new AnimeListEntry(type, Int(e, "anilist_id"), Int(e, "mal_id"), Int(e, "anidb_id"), Int(e, "tvdb_id"), tv, movies, imdb, season);
            if (entry.AniList is { } a) index.AniList.TryAdd(a, entry);
            if (entry.Mal is { } m) index.Mal.TryAdd(m, entry);
            if (tv is { } tvId) Add(index.TmdbTv, tvId, entry);
            foreach (var movie in movies.Distinct()) Add(index.TmdbMovie, movie, entry);
            foreach (var id in imdb) Add(index.Imdb, id, entry);
        }
        return index;
    }

    private static void Add<TKey>(Dictionary<TKey, List<AnimeListEntry>> map, TKey key, AnimeListEntry entry) where TKey : notnull
    {
        if (!map.TryGetValue(key, out var list)) map[key] = list = [];
        list.Add(entry);
    }

    private static IEnumerable<int> Ints(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Number when e.TryGetInt32(out var n) => [n],
        JsonValueKind.String when int.TryParse(e.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) => [n],
        JsonValueKind.Array => e.EnumerateArray().SelectMany(Ints),
        _ => []
    };

    private static int? Int(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && Ints(v).FirstOrDefault() is > 0 and var n ? n : null;
}
