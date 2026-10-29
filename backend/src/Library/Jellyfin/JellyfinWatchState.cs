using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TorrentFlow.Domain;

namespace TorrentFlow.Library.Jellyfin;

public sealed record JellyfinProgress(bool Watched, double? InProgress, DateTimeOffset? LastPlayedAt);
public sealed record JellyfinNextEpisode(string EpisodeId, int Season, int Episode);
public sealed record JellyfinTitleState(JellyfinProgress? Film,
    ImmutableDictionary<string, JellyfinProgress> Episodes, JellyfinNextEpisode? NextUp);
public sealed record JellyfinBatchRead(string Status,
    ImmutableDictionary<string, JellyfinTitleState> Items);

/// <summary>Read-only Jellyfin adapter. No playback writes or inferred local watch history.</summary>
public sealed class JellyfinWatchState
{
    private readonly HttpClient http = new() { Timeout = Timeout.InfiniteTimeSpan };
    private readonly SemaphoreSlim gate = new(1, 1);
    private MetadataCacheRow? cache;
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };
    public void Invalidate() => Interlocked.Exchange(ref cache, null);

    public static string ValidateUrl(string? value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            throw new ArgumentException("Enter an HTTP or HTTPS Jellyfin server URL.");
        return uri.AbsoluteUri.TrimEnd('/');
    }

    public async Task<bool> TestAsync(JellyfinSettings settings, string? key, CancellationToken ct)
    {
        if (settings.ServerUrl is null || string.IsNullOrWhiteSpace(settings.UserId) || string.IsNullOrWhiteSpace(key))
            return false;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromMilliseconds(1500));
        try
        {
            await GetAsync<JsonElement>(settings.ServerUrl, key,
                "Users/" + Uri.EscapeDataString(settings.UserId), deadline.Token);
            return true;
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or JsonException or ArgumentException)
        { return false; }
    }

    public async Task<JellyfinTitleState?> ReadAsync(JellyfinSettings settings, string? key,
        WorkSnapshot work, ImmutableArray<MediaFileRow> files, CancellationToken ct)
        => (await ReadBatchAsync(settings, key, [(work, files)], ct)).GetValueOrDefault(work.Work.Id);

    public async Task<ImmutableDictionary<string, JellyfinTitleState>> ReadBatchAsync(
        JellyfinSettings settings, string? key,
        IEnumerable<(WorkSnapshot Work, ImmutableArray<MediaFileRow> Files)> works, CancellationToken ct)
        => (await ReadBatchWithStatusAsync(settings, key, works, ct)).Items;

    public async Task<JellyfinBatchRead> ReadBatchWithStatusAsync(
        JellyfinSettings settings, string? key,
        IEnumerable<(WorkSnapshot Work, ImmutableArray<MediaFileRow> Files)> works, CancellationToken ct)
    {
        if (settings.ServerUrl is null || string.IsNullOrWhiteSpace(settings.UserId) || string.IsNullOrWhiteSpace(key))
            return new("off", ImmutableDictionary<string, JellyfinTitleState>.Empty);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromMilliseconds(1500));
        var locked = false;
        string? cacheKey = null;
        try
        {
            var server = ValidateUrl(settings.ServerUrl);
            cacheKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
                server + "|" + settings.UserId + "|" + key)));
            await gate.WaitAsync(deadline.Token);
            locked = true;
            var snapshot = cache;
            if (snapshot is null || snapshot.CacheKey != cacheKey || snapshot.ExpiresAt <= DateTimeOffset.UtcNow)
            {
                var items = new List<Item>();
                var start = 0;
                Page page;
                do
                {
                    page = await GetAsync<Page>(server, key, "Items?UserId=" + Uri.EscapeDataString(settings.UserId)
                        + "&Recursive=true&IncludeItemTypes=Movie,Episode,Series&Fields=ProviderIds,Path,UserData&EnableUserData=true"
                        + "&Limit=1000&StartIndex=" + start, deadline.Token);
                    items.AddRange(page.Items);
                    start += page.Items.Length;
                } while (page.Items.Length > 0 && start < page.TotalRecordCount && start < 100000);
                if (start < page.TotalRecordCount)
                    return new("unreachable", ImmutableDictionary<string, JellyfinTitleState>.Empty);
                var next = await GetAsync<Page>(server, key, "Shows/NextUp?UserId=" +
                    Uri.EscapeDataString(settings.UserId) + "&Fields=ProviderIds,Path,UserData&EnableUserData=true&Limit=1000",
                    deadline.Token);
                var now = DateTimeOffset.UtcNow;
                snapshot = new MetadataCacheRow
                {
                    Id = "jellyfin-state",
                    Kind = CacheKind.JellyfinState,
                    CacheKey = cacheKey,
                    Payload = JsonSerializer.SerializeToElement(new Snapshot([.. items], next.Items)),
                    FetchedAt = now,
                    ExpiresAt = now.AddSeconds(15),
                    Etag = null,
                    LastModified = null,
                    Complete = true,
                    Provider = "jellyfin",
                };
                cache = snapshot;
            }
            if (!snapshot.Complete)
                return new("unreachable", ImmutableDictionary<string, JellyfinTitleState>.Empty);
            var data = snapshot.Payload.Deserialize<Snapshot>(Json)!;
            var result = ImmutableDictionary.CreateBuilder<string, JellyfinTitleState>();
            foreach (var (work, files) in works)
            {
                deadline.Token.ThrowIfCancellationRequested();
                result[work.Work.Id] = Project(data, work, files);
            }
            return new("ok", result.ToImmutable());
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or JsonException or ArgumentException)
        {
            if (locked && cacheKey is not null && !ct.IsCancellationRequested)
            {
                var now = DateTimeOffset.UtcNow;
                cache = new MetadataCacheRow
                {
                    Id = "jellyfin-state",
                    Kind = CacheKind.JellyfinState,
                    CacheKey = cacheKey,
                    Payload = JsonSerializer.SerializeToElement(new Snapshot([], [])),
                    FetchedAt = now,
                    ExpiresAt = now.AddSeconds(5),
                    Etag = null,
                    LastModified = null,
                    Complete = false,
                    Provider = "jellyfin",
                };
            }
            return new("unreachable", ImmutableDictionary<string, JellyfinTitleState>.Empty);
        }
        finally { if (locked) gate.Release(); }
    }

    private static JellyfinTitleState Project(Snapshot data, WorkSnapshot work, ImmutableArray<MediaFileRow> files)
    {
        var series = Unique(data.Items.Where(i => i.Type == "Series" && ProviderMatch(i, work.Links)));
        Item? Match(EpisodeRow? episode)
        {
            var candidates = data.Items.Where(i => i.Type == (episode is null ? "Movie" : "Episode")).ToArray();
            var byId = episode is null ? candidates.Where(i => ProviderMatch(i, work.Links)) :
                candidates.Where(i => EpisodeProviderMatch(i, episode) || series is not null &&
                    i.SeriesId == series.Id && i.IndexNumber == episode.Number &&
                    i.ParentIndexNumber == work.Seasons.FirstOrDefault(s => s.Id == episode.SeasonId)?.Number);
            var identified = Unique(byId);
            if (identified is not null) return identified;
            // A conflicting provider match is not made less ambiguous by a filesystem guess.
            if (byId.Any()) return null;
            var paths = files.Where(f => f.EpisodeId == episode?.Id).Select(f => NormalizePath(f.Path)).ToHashSet();
            return Unique(candidates.Where(i => i.Path is not null && paths.Contains(NormalizePath(i.Path))));
        }
        var episodes = ImmutableDictionary.CreateBuilder<string, JellyfinProgress>();
        JellyfinNextEpisode? nextUp = null;
        foreach (var episode in work.Episodes)
        {
            var item = Match(episode);
            if (item is null) continue;
            if (item.UserData is not null) episodes[episode.Id] = Progress(item);
            if (nextUp is null && data.Next.Any(n => n.Id == item.Id))
            {
                var season = work.Seasons.FirstOrDefault(s => s.Id == episode.SeasonId);
                if (season is not null) nextUp = new(episode.Id, season.Number, episode.Number);
            }
        }
        var film = work.Work.Kind == WorkKind.Film ? Match(null) : null;
        return new(film?.UserData is null ? null : Progress(film), episodes.ToImmutable(), nextUp);
    }

    private async Task<T> GetAsync<T>(string server, string key, string path, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, ValidateUrl(server) + "/" + path);
        request.Headers.Authorization = new("MediaBrowser",
            "Client=\"TorrentFlow\", Device=\"Server\", DeviceId=\"TorrentFlow\", Version=\"0.2\", Token=\"" +
            key.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        return await JsonSerializer.DeserializeAsync<T>(stream, Json, ct) ?? throw new JsonException();
    }
    private static Item? Unique(IEnumerable<Item> source)
    {
        var matches = source.Take(2).ToArray();
        return matches.Length == 1 ? matches[0] : null;
    }
    private static bool ProviderMatch(Item item, ImmutableArray<WorkLinkRow> links) =>
        links.Any(link => link.Status == LinkStatus.Verified && ProviderValue(item, link.Provider, link.ExternalId));
    private static bool EpisodeProviderMatch(Item item, EpisodeRow episode) =>
        episode.Provider is not null && episode.ProviderEpisodeId is not null &&
        ProviderValue(item, episode.Provider, episode.ProviderEpisodeId);
    private static bool ProviderValue(Item item, string provider, string id) =>
        provider.ToLowerInvariant() is "tmdb" or "tvdb" or "imdb" &&
        item.ProviderIds?.Any(pair => pair.Key.Equals(provider, StringComparison.OrdinalIgnoreCase) &&
            pair.Value.Equals(id, StringComparison.OrdinalIgnoreCase)) == true;
    private static string NormalizePath(string path) => path.Replace('/', '\\').TrimEnd('\\').ToUpperInvariant();
    private static JellyfinProgress Progress(Item item) => new(item.UserData!.Played,
        !item.UserData.Played && item.UserData.PlaybackPositionTicks > 0 && item.RunTimeTicks > 0
            ? Math.Clamp(100d * item.UserData.PlaybackPositionTicks / item.RunTimeTicks, 0, 100) : null,
        item.UserData.LastPlayedDate);
    private sealed record Page(Item[] Items, int TotalRecordCount);
    private sealed record Snapshot(Item[] Items, Item[] Next);
    private sealed record Item(string Id, string Type, string? Path, Dictionary<string, string>? ProviderIds,
        string? SeriesId, int? ParentIndexNumber, int? IndexNumber, long RunTimeTicks, UserData? UserData);
    private sealed record UserData(bool Played, long PlaybackPositionTicks, DateTimeOffset? LastPlayedDate);
}
