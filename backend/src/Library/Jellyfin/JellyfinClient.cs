using System.Collections.Immutable;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Reflection;

namespace TorrentFlow.Library.Jellyfin;

public enum JellyfinErrorKind { Unreachable, Unauthorized, NotFound, Rejected, InvalidResponse }

public sealed class JellyfinException(JellyfinErrorKind kind, string message, HttpStatusCode? statusCode = null,
    Exception? innerException = null) : Exception(message, innerException)
{
    public JellyfinErrorKind Kind { get; } = kind;
    public HttpStatusCode? StatusCode { get; } = statusCode;
}

public sealed record JellyfinServerInfo(string? ServerName, string? ServerId, string? Version);
public sealed record JellyfinUser(string Id, string? Name, bool IsAdmin, bool IsDisabled = false);
public sealed record JellyfinAuthentication(string AccessToken, JellyfinUser User, string? ServerId);
public sealed record JellyfinVirtualFolder(string? Name, string? CollectionType, ImmutableArray<string> Locations,
    string? ItemId);
public sealed record JellyfinDirectoryEntry(string? Name, string? Path, string? Type);
public sealed record JellyfinSession(string? UserId, JellyfinItemDto? NowPlayingItem);
public sealed record JellyfinRemoteSubtitle(string? Id, string? Name, int? DownloadCount, bool? IsForced,
    string? ThreeLetterISOLanguageName, bool? IsHearingImpaired = null);
public sealed record JellyfinItemsResult(ImmutableArray<JellyfinItemDto> Items, int TotalRecordCount);
public sealed record JellyfinItemDto(string? Id, string? Name, string? Type, string? Path,
    string? LocationType, Dictionary<string, string>? ProviderIds, string? SeriesId,
    int? ParentIndexNumber, int? IndexNumber, long? RunTimeTicks, JellyfinUserData? UserData,
    ImmutableArray<JellyfinMediaSource> MediaSources, bool? IsLocked, int? ProductionYear = null,
    bool? LockData = null);
public sealed record JellyfinUserData(bool Played, long PlaybackPositionTicks, DateTimeOffset? LastPlayedDate);
public sealed record JellyfinMediaSource(string? Path, ImmutableArray<JellyfinMediaStream> MediaStreams);
public sealed record JellyfinMediaStream(string? Type, string? Language, int? Index = null, string? Codec = null,
    int? Channels = null, string? ChannelLayout = null, bool? IsDefault = null, bool? IsForced = null,
    string? DisplayTitle = null);

public sealed record JellyfinItemQuery
{
    public string? UserId { get; init; }
    public ImmutableArray<string> Ids { get; init; } = [];
    public bool? Recursive { get; init; }
    public ImmutableArray<string> IncludeItemTypes { get; init; } = [];
    public ImmutableArray<string> Filters { get; init; } = [];
    public ImmutableArray<string> SortBy { get; init; } = [];
    public ImmutableArray<string> SortOrder { get; init; } = [];
    public ImmutableArray<string> Fields { get; init; } = [];
    public string? ParentId { get; init; }
    public int? Limit { get; init; }
    public int? StartIndex { get; init; }
    public bool? EnableUserData { get; init; }
}

public sealed record JellyfinMediaUpdate(string Path, string UpdateType);

public sealed class JellyfinClient
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
    private readonly HttpClient http;
    private readonly string deviceId;
    private readonly string version;

    public JellyfinClient(HttpClient http, string deviceId, string? version = null)
    {
        this.http = http;
        this.deviceId = string.IsNullOrWhiteSpace(deviceId) ? throw new ArgumentException("A device id is required.", nameof(deviceId)) : deviceId;
        this.version = version ?? Assembly.GetEntryAssembly()?.GetName().Version?.ToString()
            ?? typeof(JellyfinClient).Assembly.GetName().Version?.ToString() ?? "0.0.0";
        if (http.Timeout == Timeout.InfiniteTimeSpan || http.Timeout > TimeSpan.FromSeconds(10))
            http.Timeout = TimeSpan.FromSeconds(10);
    }

    public static JellyfinClient Create(string dataDirectory)
    {
        Directory.CreateDirectory(dataDirectory);
        var idPath = Path.Combine(dataDirectory, "jellyfin-device-id");
        string id;
        if (File.Exists(idPath)) id = File.ReadAllText(idPath).Trim();
        else
        {
            id = Guid.NewGuid().ToString("N");
            try
            {
                using var stream = new FileStream(idPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
                var bytes = Encoding.ASCII.GetBytes(id);
                stream.Write(bytes);
                stream.Flush(true);
            }
            catch (IOException) when (File.Exists(idPath)) { id = File.ReadAllText(idPath).Trim(); }
        }
        return new JellyfinClient(new HttpClient { Timeout = TimeSpan.FromSeconds(10) }, id);
    }

    public Task<JsonElement> GetPublicSystemInfo(string serverUrl, CancellationToken ct = default) =>
        SendAsync<JsonElement>(HttpMethod.Get, serverUrl, "System/Info/Public", null, authenticated: false, null, ct);

    public async Task<JellyfinServerInfo> GetSystemInfo(string serverUrl, string token, CancellationToken ct = default)
    {
        var response = await SendAsync<SystemInfoDto>(HttpMethod.Get, serverUrl, "System/Info", token, true, null, ct);
        return new(response.ServerName, response.Id, response.Version);
    }

    public async Task<JellyfinAuthentication> AuthenticateByName(string serverUrl, string username, string password,
        CancellationToken ct = default)
    {
        try
        {
            var result = await SendAsync<AuthenticationDto>(HttpMethod.Post, serverUrl, "Users/AuthenticateByName",
                null, false, new { Username = username, Pw = password }, ct);
            if (string.IsNullOrWhiteSpace(result.AccessToken) || result.User is null || string.IsNullOrWhiteSpace(result.User.Id))
                throw new JellyfinException(JellyfinErrorKind.InvalidResponse, "Jellyfin did not return a signed-in user.");
            return new(result.AccessToken, MapUser(result.User), result.ServerId);
        }
        catch (JellyfinException ex) when (ex.Kind == JellyfinErrorKind.Unauthorized)
        {
            throw new JellyfinException(JellyfinErrorKind.Unauthorized,
                "Jellyfin rejected the sign-in. Check the account.", ex.StatusCode, ex);
        }
    }

    public async Task<ImmutableArray<JellyfinUser>> GetUsers(string serverUrl, string token, CancellationToken ct = default)
    {
        var users = await SendAsync<UserDto[]>(HttpMethod.Get, serverUrl, "Users?isDisabled=false",
            token, true, null, ct);
        return [.. users.Select(MapUser)];
    }

    public async Task<JellyfinUser?> GetCurrentUser(string serverUrl, string token, CancellationToken ct = default)
    {
        try
        {
            return MapUser(await SendAsync<UserDto>(HttpMethod.Get, serverUrl, "Users/Me", token, true, null, ct));
        }
        catch (JellyfinException ex) when (ex.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            return null;
        }
    }

    public async Task<JellyfinUser?> GetUser(string serverUrl, string token, string userId, CancellationToken ct = default)
    {
        try
        {
            return MapUser(await SendAsync<UserDto>(HttpMethod.Get, serverUrl,
                "Users/" + Uri.EscapeDataString(userId), token, true, null, ct));
        }
        catch (JellyfinException ex) when (ex.StatusCode == HttpStatusCode.NotFound) { return null; }
    }

    public async Task<ImmutableArray<JellyfinVirtualFolder>> GetVirtualFolders(string serverUrl, string token,
        CancellationToken ct = default)
    {
        var folders = await SendAsync<VirtualFolderDto[]>(HttpMethod.Get, serverUrl, "Library/VirtualFolders", token, true, null, ct);
        return [.. folders.Select(folder => new JellyfinVirtualFolder(folder.Name, folder.CollectionType,
            folder.Locations.IsDefault ? [] : folder.Locations, folder.ItemId))];
    }

    public Task AddVirtualFolder(string serverUrl, string token, string name, string collectionType, string path,
        CancellationToken ct = default) =>
        SendNoContentAsync(HttpMethod.Post, serverUrl,
            "Library/VirtualFolders?" + Query(("name", name), ("collectionType", collectionType), ("refreshLibrary", "false")),
            token, true, new { LibraryOptions = new { PathInfos = new[] { new { Path = path } } } }, ct);

    public Task AddVirtualFolderPath(string serverUrl, string token, string name, string path, CancellationToken ct = default) =>
        SendNoContentAsync(HttpMethod.Post, serverUrl, "Library/VirtualFolders/Paths?refreshLibrary=false", token, true,
            new { Name = name, PathInfo = new { Path = path } }, ct);

    public Task RemoveVirtualFolderPath(string serverUrl, string token, string name, string path,
        CancellationToken ct = default) =>
        SendNoContentAsync(HttpMethod.Delete, serverUrl,
            "Library/VirtualFolders/Paths?" + Query(("name", name), ("path", path), ("refreshLibrary", "true")),
            token, true, null, ct);

    public Task RefreshLibrary(string serverUrl, string token, CancellationToken ct = default) =>
        SendNoContentAsync(HttpMethod.Post, serverUrl, "Library/Refresh", token, true, null, ct);

    public Task ReportMediaUpdated(string serverUrl, string token, IEnumerable<JellyfinMediaUpdate> updates,
        CancellationToken ct = default) =>
        SendNoContentAsync(HttpMethod.Post, serverUrl, "Library/Media/Updated", token, true,
            new { Updates = updates.Select(update => new { Path = update.Path, UpdateType = update.UpdateType }).ToArray() }, ct);

    public async Task<JellyfinItemsResult> GetItems(string serverUrl, string token, JellyfinItemQuery query,
        CancellationToken ct = default)
    {
        var parameters = new List<(string, string?)>
        {
            ("userId", query.UserId), ("recursive", query.Recursive?.ToString().ToLowerInvariant()),
            ("includeItemTypes", Join(query.IncludeItemTypes)), ("filters", Join(query.Filters)),
            ("sortBy", Join(query.SortBy)), ("sortOrder", Join(query.SortOrder)), ("fields", Join(query.Fields)),
            ("parentId", query.ParentId), ("limit", query.Limit?.ToString()), ("startIndex", query.StartIndex?.ToString()),
            ("enableUserData", query.EnableUserData?.ToString().ToLowerInvariant()), ("ids", Join(query.Ids)),
        };
        var dto = await SendAsync<ItemQueryResultDto>(HttpMethod.Get, serverUrl,
            "Items?" + Query(parameters.ToArray()), token, true, null, ct);
        return new(dto.Items.IsDefault ? [] : dto.Items, dto.TotalRecordCount);
    }

    public async Task<JellyfinItemsResult> GetNextUp(string serverUrl, string token, string userId,
        int? limit = null, int? startIndex = null, IEnumerable<string>? fields = null, CancellationToken ct = default)
    {
        var dto = await SendAsync<ItemQueryResultDto>(HttpMethod.Get, serverUrl, "Shows/NextUp?" + Query(
            ("userId", userId), ("limit", limit?.ToString()), ("startIndex", startIndex?.ToString()),
            ("fields", fields is null ? null : string.Join(',', fields)), ("enableUserData", "true")),
            token, true, null, ct);
        return new(dto.Items.IsDefault ? [] : dto.Items, dto.TotalRecordCount);
    }

    public async Task<ImmutableArray<JellyfinSession>> GetSessions(string serverUrl, string token,
        int activeWithinSeconds, CancellationToken ct = default)
    {
        var sessions = await SendAsync<SessionDto[]>(HttpMethod.Get, serverUrl,
            "Sessions?activeWithinSeconds=" + activeWithinSeconds, token, true, null, ct);
        return [.. sessions.Select(session => new JellyfinSession(session.UserId, session.NowPlayingItem))];
    }

    public async Task<ImmutableArray<JellyfinDirectoryEntry>> GetDirectoryContents(string serverUrl, string token,
        string path, CancellationToken ct = default)
    {
        var items = await SendAsync<DirectoryEntryDto[]>(HttpMethod.Get, serverUrl,
            "Environment/DirectoryContents?" + Query(("path", path), ("includeDirectories", "true")),
            token, true, null, ct);
        return [.. items.Select(item => new JellyfinDirectoryEntry(item.Name, item.Path, item.Type))];
    }

    public async Task<ImmutableArray<JellyfinRemoteSubtitle>> RemoteSearchSubtitles(string serverUrl, string token,
        string itemId, string language, CancellationToken ct = default)
    {
        var items = await SendAsync<SubtitleDto[]>(HttpMethod.Get, serverUrl,
            $"Items/{Uri.EscapeDataString(itemId)}/RemoteSearch/Subtitles/{Uri.EscapeDataString(language)}",
            token, true, null, ct);
        return [.. items.Select(item => new JellyfinRemoteSubtitle(item.Id, item.Name, item.DownloadCount,
            item.IsForced, item.ThreeLetterISOLanguageName, item.IsHearingImpaired))];
    }

    public async Task<bool> HasSubtitleProvider(string serverUrl, string token, CancellationToken ct = default)
    {
        try
        {
            var providers = await SendAsync<JsonElement>(HttpMethod.Get, serverUrl,
                "Providers/Subtitles/Subtitles", token, true, null, ct);
            if (providers.ValueKind == JsonValueKind.Array) return providers.GetArrayLength() > 0;
            return providers.ValueKind == JsonValueKind.Object &&
                providers.TryGetProperty("Items", out var items) && items.ValueKind == JsonValueKind.Array &&
                items.GetArrayLength() > 0;
        }
        catch (JellyfinException ex) when (ex.Kind == JellyfinErrorKind.NotFound)
        {
            var plugins = await SendAsync<PluginDto[]>(HttpMethod.Get, serverUrl, "Plugins", token, true, null, ct);
            return plugins.Any(plugin => plugin.Name is { } name &&
                new string(name.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray())
                    .Contains("opensubtitles", StringComparison.Ordinal));
        }
    }

    public Task DownloadRemoteSubtitle(string serverUrl, string token, string itemId, string subtitleId,
        CancellationToken ct = default) =>
        SendNoContentAsync(HttpMethod.Post, serverUrl,
            $"Items/{Uri.EscapeDataString(itemId)}/RemoteSearch/Subtitles/{Uri.EscapeDataString(subtitleId)}",
            token, true, null, ct);

    public Task ApplyRemoteSearch(string serverUrl, string token, string itemId, object body,
        bool replaceAllImages = false, CancellationToken ct = default) =>
        SendNoContentAsync(HttpMethod.Post, serverUrl,
            $"Items/RemoteSearch/Apply/{Uri.EscapeDataString(itemId)}?replaceAllImages={replaceAllImages.ToString().ToLowerInvariant()}",
            token, true, body, ct);

    private async Task<T> SendAsync<T>(HttpMethod method, string serverUrl, string path, string? token,
        bool authenticated, object? body, CancellationToken ct)
    {
        using var request = CreateRequest(method, serverUrl, path, token, authenticated, body);
        HttpResponseMessage response;
        try { response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new JellyfinException(JellyfinErrorKind.Unreachable,
                "Jellyfin did not answer. Check it is running and the address is right.");
        }
        catch (HttpRequestException ex)
        {
            throw new JellyfinException(JellyfinErrorKind.Unreachable,
                "Jellyfin did not answer. Check it is running and the address is right.", null, ex);
        }
        using (response)
        {
            if (!response.IsSuccessStatusCode) throw MapError(response.StatusCode);
            try
            {
                await using var stream = await response.Content.ReadAsStreamAsync(ct);
                return await JsonSerializer.DeserializeAsync<T>(stream, Json, ct)
                    ?? throw new JsonException("Jellyfin returned an empty response.");
            }
            catch (JsonException ex)
            {
                throw new JellyfinException(JellyfinErrorKind.InvalidResponse,
                    "Jellyfin returned a response TorrentFlow could not read.", response.StatusCode, ex);
            }
        }
    }

    private async Task SendNoContentAsync(HttpMethod method, string serverUrl, string path, string? token,
        bool authenticated, object? body, CancellationToken ct)
    {
        using var request = CreateRequest(method, serverUrl, path, token, authenticated, body);
        HttpResponseMessage response;
        try { response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new JellyfinException(JellyfinErrorKind.Unreachable,
                "Jellyfin did not answer. Check it is running and the address is right.");
        }
        catch (HttpRequestException ex)
        {
            throw new JellyfinException(JellyfinErrorKind.Unreachable,
                "Jellyfin did not answer. Check it is running and the address is right.", null, ex);
        }
        using (response)
            if (!response.IsSuccessStatusCode) throw MapError(response.StatusCode);
    }

    private HttpRequestMessage CreateRequest(HttpMethod method, string serverUrl, string path, string? token,
        bool authenticated, object? body)
    {
        var baseUrl = ValidateUrl(serverUrl);
        var request = new HttpRequestMessage(method, baseUrl + "/" + path.TrimStart('/'));
        request.Headers.TryAddWithoutValidation("Authorization", Authorization(token, authenticated));
        if (body is not null) request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        return request;
    }

    private string Authorization(string? token, bool authenticated)
    {
        var value = $"MediaBrowser Client=\"TorrentFlow\", Device=\"TorrentFlow\", DeviceId=\"{deviceId}\", Version=\"{version}\"";
        if (authenticated && !string.IsNullOrWhiteSpace(token))
            value += $", Token=\"{token.Replace("\\", "\\\\").Replace("\"", "\\\"")}\"";
        return value;
    }

    private static JellyfinException MapError(HttpStatusCode status) => status switch
    {
        HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => new(JellyfinErrorKind.Unauthorized,
            "Jellyfin did not allow this request. Check the account and its permissions.", status),
        HttpStatusCode.NotFound => new(JellyfinErrorKind.NotFound,
            "Jellyfin could not find the requested item or folder.", status),
        _ => new(JellyfinErrorKind.Rejected,
            "Jellyfin could not complete that request. Check the server settings and try again.", status),
    };

    private static string ValidateUrl(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") ||
            !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            throw new JellyfinException(JellyfinErrorKind.Rejected, "Enter an HTTP or HTTPS Jellyfin server address.");
        return uri.AbsoluteUri.TrimEnd('/');
    }

    private static JellyfinUser MapUser(UserDto user) =>
        new(user.Id ?? "", user.Name, user.Policy?.IsAdministrator == true, user.Policy?.IsDisabled == true);
    private static string? Join(ImmutableArray<string> values) => values.IsDefaultOrEmpty ? null : string.Join(',', values);
    private static string Query(params (string Name, string? Value)[] parameters) => string.Join('&',
        parameters.Where(pair => pair.Value is not null)
            .Select(pair => Uri.EscapeDataString(pair.Name) + "=" + Uri.EscapeDataString(pair.Value!)));

    private sealed record SystemInfoDto(string? ServerName, string? Id, string? Version);
    private sealed record AuthenticationDto(string? AccessToken, string? ServerId, UserDto? User);
    private sealed record UserDto(string? Id, string? Name, UserPolicyDto? Policy);
    private sealed record UserPolicyDto(bool IsAdministrator, bool IsDisabled);
    private sealed record VirtualFolderDto(string? Name, string? CollectionType, ImmutableArray<string> Locations, string? ItemId);
    private sealed record ItemQueryResultDto(ImmutableArray<JellyfinItemDto> Items, int TotalRecordCount);
    private sealed record SessionDto(string? UserId, JellyfinItemDto? NowPlayingItem);
    private sealed record DirectoryEntryDto(string? Name, string? Path, string? Type);
    private sealed record SubtitleDto(string? Id, string? Name, int? DownloadCount, bool? IsForced,
        string? ThreeLetterISOLanguageName, bool? IsHearingImpaired);
    private sealed record PluginDto(string? Name);
}
