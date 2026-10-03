using System.Collections.Immutable;
using System.Text.Json;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed record AnimeMapEntry(int? AniList, int? Mal, int? Tvdb, int? TmdbTv,
    ImmutableArray<int> TmdbMovies, ImmutableArray<string> Imdb, int? Season);

internal sealed class FribbMap(ProviderHttp http, CatalogStore store)
{
    internal const string DefaultUrl = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json";
    private readonly SemaphoreSlim gate = new(1);
    private ImmutableArray<AnimeMapEntry> entries = [];
    private ImmutableDictionary<string, ImmutableArray<AnimeMapEntry>> index =
        ImmutableDictionary<string, ImmutableArray<AnimeMapEntry>>.Empty;
    private DateTimeOffset checkedAt;
    private bool loaded;
    private Task? refreshing;
    internal string Version { get; private set; } = "none";

    internal async Task LoadAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            if (loaded) return;
            var url = (await store.SettingsAsync(ct)).FribbUrl ?? DefaultUrl;
            var id = ProviderHttp.Id("fribb:" + url);
            var cached = (await store.ReadAsync<MetadataCacheRow>(CatalogStore.Query(id), ct)).FirstOrDefault();
            if (cached is not null && Valid(cached.Payload))
            {
                entries = Parse(cached.Payload);
                Index();
                Version = ProviderHttp.Id(cached.Payload.GetRawText())[..12];
                checkedAt = cached.FetchedAt;
            }
            loaded = true;
        }
        finally { gate.Release(); }
    }

    internal void RefreshInBackground()
    {
        lock (gate)
            if (refreshing is null || refreshing.IsCompleted)
                refreshing = RefreshAsync(DateTimeOffset.UtcNow, CancellationToken.None);
    }

    internal ImmutableArray<AnimeMapEntry> Find(ProviderId id) =>
        index.GetValueOrDefault(Key(id.Provider, id.ExternalId, id.ProviderKind), []);

    internal async Task RefreshAsync(DateTimeOffset now, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            if (now - checkedAt < TimeSpan.FromHours(6)) return;
            checkedAt = now;
            var settings = await store.SettingsAsync(ct);
            var url = settings.FribbUrl ?? DefaultUrl;
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https") return;
            var answer = await http.FetchAsync("fribb", url, () => new(HttpMethod.Get, uri),
                TimeSpan.FromDays(7), ct, 20, 64 * 1024 * 1024, kind: CacheKind.FribbMap, validate: Valid);
            if (answer.Json is not { ValueKind: JsonValueKind.Array } payload) return;
            var parsed = Parse(payload);
            if (parsed.IsEmpty) return;
            entries = parsed;
            Index();
            Version = ProviderHttp.Id(payload.GetRawText())[..12];
        }

        finally { gate.Release(); }
    }

    private static bool Valid(JsonElement payload) => payload.ValueKind == JsonValueKind.Array &&
        payload.Items().Any(e => e.Int("anilist_id") is > 0) &&
        payload.Items().All(e => e.ValueKind == JsonValueKind.Object);

    private static ImmutableArray<AnimeMapEntry> Parse(JsonElement payload)
    {
        var result = ImmutableArray.CreateBuilder<AnimeMapEntry>();
        foreach (var e in payload.Items())
        {
            var tmdb = e.Obj("themoviedb_id");
            var movies = Numbers(tmdb.Obj("movie")).ToImmutableArray();
            int? tv = Numbers(tmdb.Obj("tv")).Cast<int?>().FirstOrDefault();
            if (int.TryParse(tmdb.ToString(), out var legacy) && legacy > 0)
            {
                if (e.Text("type") == "MOVIE") movies = [legacy]; else tv = legacy;
            }
            var imdb = e.Obj("imdb_id");
            result.Add(new(e.Int("anilist_id"), e.Int("mal_id"), e.Int("tvdb_id"), tv,
                movies, [.. (imdb.ValueKind == JsonValueKind.String ? new[] { imdb.GetString()! } : imdb.Strings())
                    .Where(s => s.StartsWith("tt", StringComparison.Ordinal)).Distinct()],
                e.Obj("season").Int("tmdb")));
        }
        return result.ToImmutable();
    }

    private void Index()
    {
        var rows = new List<(string Key, AnimeMapEntry Entry)>();
        foreach (var entry in entries)
        {
            if (entry.AniList is { } ani) rows.Add((Key("anilist", ani.ToString()), entry));
            if (entry.Mal is { } mal) rows.Add((Key("mal", mal.ToString()), entry));
            if (entry.Tvdb is { } tvdb) rows.Add((Key("tvdb", tvdb.ToString()), entry));
            if (entry.TmdbTv is { } tv) rows.Add((Key("tmdb", tv.ToString(), "tv"), entry));
            foreach (var movie in entry.TmdbMovies) rows.Add((Key("tmdb", movie.ToString(), "movie"), entry));
            foreach (var imdb in entry.Imdb) rows.Add((Key("imdb", imdb), entry));
        }
        index = rows.GroupBy(r => r.Key).ToImmutableDictionary(g => g.Key, g => g.Select(r => r.Entry).ToImmutableArray());
    }

    private static string Key(string provider, string id, string? kind = null) =>
        (provider == "cinemeta" ? "imdb" : provider) + ":" +
        (provider == "tmdb" ? kind is "tv" or "series" ? "tv:" : "movie:" : "") + id;

    private static IEnumerable<int> Numbers(JsonElement value) => value.ValueKind == JsonValueKind.Array
        ? value.Items().SelectMany(Numbers) : int.TryParse(value.ToString(), out var n) && n > 0 ? [n] : [];
}
