using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Library.Jellyfin;
using TorrentFlow.Store;

namespace TorrentFlow.Api;

internal static class JellyfinEndpoints
{
    internal sealed record JellyfinTitleRead(JellyfinTitleState? State, object? Playback);
    internal static JellyfinWatchState Adapter { get; private set; } = null!;
    private static JellyfinClient Client { get; set; } = null!;
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static readonly SemaphoreSlim StatusGate = new(1, 1);
    private static CachedStatus? statusCache;

    internal static IResult TitleJson(object value)
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var node = JsonSerializer.SerializeToNode(value, options)!.AsObject();
        foreach (var key in new[] { "watchState", "jellyfinNextUp" })
            if (node[key] is null) node.Remove(key);
        foreach (var episode in node["episodes"]!.AsArray())
        {
            if (episode!["watchState"] is null) episode.AsObject().Remove("watchState");
            if (episode["jellyfinItemId"] is null) episode.AsObject().Remove("jellyfinItemId");
        }
        return Results.Json(node, options);
    }

    internal static void MapJellyfin(this RouteGroupBuilder group, string directory,
        JellyfinClient client, JellyfinWatchState adapter)
    {
        Client = client;
        Adapter = adapter;
        group.MapGet("/jellyfin", async (TorrentFlowDbContext db, CancellationToken ct) =>
            await Status(db, directory, ct));
        group.MapPut("/jellyfin", async (TorrentFlowDbContext db, JsonElement body, CancellationToken ct) =>
        {
            await Gate.WaitAsync(ct);
            try
            {
                var row = await db.Settings.SingleAsync(setting => setting.Id == "jellyfin", ct);
                var old = SettingsCatalog.Read<JellyfinSettings>(row);
                var server = JellyfinWatchState.ValidateUrl(body.GetProperty("serverUrl").GetString());
                var user = body.GetProperty("userId").GetString()?.Trim();
                if (string.IsNullOrWhiteSpace(user) || user.Length > 200 || user.Any(char.IsControl))
                    throw new ArgumentException("Choose a Jellyfin user.");
                var credential = old.Credential;
                if (body.TryGetProperty("apiKey", out var input))
                {
                    var key = input.GetString()?.Trim();
                    if (string.IsNullOrWhiteSpace(key) || key.Length > 4096 || key.Any(char.IsControl))
                        throw new ArgumentException("Enter a usable Jellyfin API key.");
                    credential = SecretFiles.Save(directory, key);
                }
                if (credential is null) throw new ArgumentException("Enter a Jellyfin API key.");
                var userMappings = old.UserMappings;
                if (userMappings.IsEmpty)
                {
                    var owner = await db.Users.AsNoTracking().SingleAsync(item => item.Role == UserRole.Owner, ct);
                    userMappings = [new JellyfinUserMapping(owner.Id, user)];
                }
                var settings = old with { ServerUrl = server, Credential = credential, UserId = user, UserMappings = userMappings };
                await Save(db, row, settings, ct);
                return await Status(db, directory, ct);
            }
            finally { Gate.Release(); }
        }).WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(8192));
        group.MapDelete("/jellyfin", async (TorrentFlowDbContext db, CancellationToken ct) =>
        {
            await Gate.WaitAsync(ct);
            try
            {
                var row = await db.Settings.SingleAsync(setting => setting.Id == "jellyfin", ct);
                await Save(db, row, new JellyfinSettings(null, null, null), ct);
                return await Status(db, directory, ct);
            }
            finally { Gate.Release(); }
        });
        group.MapPost("/jellyfin/signin", async (TorrentFlowDbContext db, JsonElement body, CancellationToken ct) =>
        {
            var server = JellyfinWatchState.ValidateUrl(body.TryGetProperty("serverUrl", out var serverValue) ?
                serverValue.GetString() : null);
            var username = body.TryGetProperty("username", out var usernameValue) ? usernameValue.GetString()?.Trim() : null;
            var password = body.TryGetProperty("password", out var passwordValue) ? passwordValue.GetString() : null;
            if (string.IsNullOrWhiteSpace(username) || username.Length > 200 || username.Any(char.IsControl) ||
                string.IsNullOrEmpty(password) || password.Length > 4096 || password.Any(char.IsControl))
                return Results.BadRequest(new { message = "Enter your Jellyfin username and password." });
            try
            {
                var authentication = await Client.AuthenticateByName(server, username, password, ct);
                var row = await db.Settings.SingleAsync(setting => setting.Id == "jellyfin", ct);
                var old = SettingsCatalog.Read<JellyfinSettings>(row);
                var owner = await db.Users.AsNoTracking().SingleAsync(user => user.Role == UserRole.Owner, ct);
                var settings = old with
                {
                    ServerUrl = server,
                    Credential = SecretFiles.Save(directory, authentication.AccessToken),
                    UserId = authentication.User.Id,
                    ServerId = authentication.ServerId,
                    UserMappings = old.UserMappings.IsEmpty
                        ? [new JellyfinUserMapping(owner.Id, authentication.User.Id)]
                        : old.UserMappings,
                };
                await Save(db, row, settings, ct);
                return await Status(db, directory, ct);
            }
            catch (JellyfinException ex)
            {
                return Results.Json(new { message = ex.Message }, statusCode: ex.Kind == JellyfinErrorKind.Unauthorized ? 401 : 503);
            }
        }).WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(8192));
        group.MapGet("/jellyfin/users", async (TorrentFlowDbContext db, CancellationToken ct) =>
        {
            var settings = await Settings(db, ct);
            var token = SecretFiles.Read(directory, settings.Credential);
            try
            {
                var user = await CurrentUser(settings, token, ct);
                if (user?.IsAdmin != true)
                    return Results.Json(new { message = "Sign in with a Jellyfin admin account to choose watch users." }, statusCode: 403);
                var users = await Client.GetUsers(settings.ServerUrl!, token!, ct);
                return Results.Json(users.Where(item => !item.IsDisabled)
                    .Select(item => new { id = item.Id, name = item.Name, isAdmin = item.IsAdmin }));
            }
            catch (JellyfinException ex)
            {
                return Results.Json(new { message = ex.Message }, statusCode: ex.Kind == JellyfinErrorKind.Unauthorized ? 403 : 503);
            }
        });
        group.MapPatch("/jellyfin/options", async (TorrentFlowDbContext db, JsonElement body, CancellationToken ct) =>
        {
            try
            {
                var row = await db.Settings.SingleAsync(setting => setting.Id == "jellyfin", ct);
                var existing = SettingsCatalog.Read<JellyfinSettings>(row);
                var settings = existing with
                {
                    PublicUrl = body.TryGetProperty("publicUrl", out _) ? OptionalString(body, "publicUrl") : existing.PublicUrl,
                    PathMappings = body.TryGetProperty("pathMappings", out _) ? ReadMappings(body) : existing.PathMappings,
                    WatchUserIds = body.TryGetProperty("watchUserIds", out _) ? ReadStringArray(body, "watchUserIds") : existing.WatchUserIds,
                    UserMappings = body.TryGetProperty("userMappings", out _) ? ReadUserMappings(body) : existing.UserMappings,
                    SyncLibraries = body.TryGetProperty("syncLibraries", out _) ? RequiredBoolean(body, "syncLibraries") : existing.SyncLibraries,
                    SuggestNextEpisodes = body.TryGetProperty("suggestNextEpisodes", out _)
                        ? RequiredInteger(body, "suggestNextEpisodes") : existing.SuggestNextEpisodes,
                    SubtitleLanguages = body.TryGetProperty("subtitleLanguages", out _)
                        ? ReadStringArray(body, "subtitleLanguages")
                            .Select(language => language.Trim().ToLowerInvariant()).ToImmutableArray()
                        : existing.SubtitleLanguages,
                };
                var validation = row with { Value = JsonSerializer.SerializeToElement(settings) };
                SettingsCatalog.Validate(validation);
                await Save(db, row, settings, ct);
                return await Status(db, directory, ct);
            }
            catch (Exception ex) when (ex is ArgumentException or JsonException or InvalidOperationException or KeyNotFoundException)
            {
                return Results.BadRequest(new { message = ex.Message });
            }
        }).WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(16384));
        group.MapGet("/jellyfin/mappings/suggest", async (TorrentFlowDbContext db, CancellationToken ct) =>
        {
            var settings = await Settings(db, ct);
            var token = SecretFiles.Read(directory, settings.Credential);
            if (settings.ServerUrl is null || token is null)
                return Results.Json(new { message = "Connect to Jellyfin before suggesting folder paths." }, statusCode: 400);
            try
            {
                if (!await IsAdmin(settings, token, ct))
                    return Results.Json(new { message = "Sign in with a Jellyfin admin account to find your folders in Jellyfin." }, statusCode: 403);
                var folders = await Client.GetVirtualFolders(settings.ServerUrl, token, ct);
                var locations = folders.SelectMany(folder => folder.Locations).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
                var roots = await db.StorageRoots.AsNoTracking().OrderBy(root => root.Priority).ToArrayAsync(ct);
                var mapper = new JellyfinPathMapper(settings.PathMappings);
                var result = new List<object>();
                foreach (var root in roots)
                {
                    var mappedPath = mapper.ToJellyfin(root.Path);
                    var exact = locations.FirstOrDefault(location => SamePath(location, mappedPath ?? root.Path));
                    if (exact is not null)
                    {
                        result.Add(new { rootId = root.Id, localPath = root.Path, suggestedJellyfinPath = exact, verified = true });
                        continue;
                    }
                    if (mappedPath is not null && await DirectoryReadable(Client, settings.ServerUrl, token, mappedPath, ct))
                    {
                        result.Add(new { rootId = root.Id, localPath = root.Path, suggestedJellyfinPath = mappedPath, verified = true });
                        continue;
                    }
                    var candidate = locations.Select(location => (Location: location, Score: TrailingFolderMatches(root.Path, location)))
                        .Where(match => match.Score > 0).OrderByDescending(match => match.Score)
                        .Select(match => match.Location).FirstOrDefault();
                    var verified = false;
                    if (candidate is not null)
                    {
                        try { verified = await DirectoryReadable(Client, settings.ServerUrl, token, candidate, ct); }
                        catch (JellyfinException) { }
                    }
                    result.Add(new { rootId = root.Id, localPath = root.Path, suggestedJellyfinPath = candidate, verified });
                }
                return Results.Json(result);
            }
            catch (JellyfinException ex) { return Results.Json(new { message = ex.Message }, statusCode: ex.Kind == JellyfinErrorKind.Unauthorized ? 403 : 503); }
        });
        group.MapPost("/jellyfin/mappings/verify", async (TorrentFlowDbContext db, JsonElement body, CancellationToken ct) =>
        {
            var localPath = OptionalString(body, "localPath");
            var jellyfinPath = OptionalString(body, "jellyfinPath");
            if (string.IsNullOrWhiteSpace(localPath) || string.IsNullOrWhiteSpace(jellyfinPath))
                return Results.BadRequest(new { ok = false, message = "Enter both folder paths." });
            var settings = await Settings(db, ct);
            var token = SecretFiles.Read(directory, settings.Credential);
            if (settings.ServerUrl is null || token is null)
                return Results.Json(new { ok = false, message = "Connect to Jellyfin before checking a folder." }, statusCode: 400);
            try
            {
                if (!await IsAdmin(settings, token, ct))
                    return Results.Json(new { ok = false, message = "Sign in with a Jellyfin admin account to check folder paths." }, statusCode: 403);
                var mapper = new JellyfinPathMapper([new JellyfinPathMapping(localPath, jellyfinPath)]);
                var mapped = mapper.ToJellyfin(localPath);
                var exists = mapped is not null && await DirectoryReadable(Client, settings.ServerUrl, token, mapped, ct);
                return Results.Json(new
                {
                    ok = exists,
                    message = exists ? "Jellyfin can see this folder." : "Jellyfin could not find this folder. Check the path and try again.",
                });
            }
            catch (JellyfinException ex)
            {
                if (ex.Kind == JellyfinErrorKind.NotFound)
                    return Results.Json(new { ok = false, message = "Jellyfin could not find this folder. Check the path and try again." });
                return Results.Json(new { ok = false, message = ex.Message }, statusCode: ex.Kind == JellyfinErrorKind.Unauthorized ? 403 : 503);
            }
        }).WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(8192));
        group.MapPost("/jellyfin/test", async (TorrentFlowDbContext db, JsonElement body, CancellationToken ct) =>
        {
            var saved = await Settings(db, ct);
            var settings = saved with
            {
                ServerUrl = body.TryGetProperty("serverUrl", out var server) ? JellyfinWatchState.ValidateUrl(server.GetString()) : saved.ServerUrl,
                UserId = body.TryGetProperty("userId", out var user) ? user.GetString() : saved.UserId,
            };
            var key = body.TryGetProperty("apiKey", out var input) ? input.GetString() : SecretFiles.Read(directory, saved.Credential);
            var ok = await Adapter.TestAsync(settings, key, ct);
            return Results.Json(new { ok, status = ok ? "ok" : "unavailable", message = ok ?
                "Connected to Jellyfin." : "Could not connect to Jellyfin. Check the server URL, API key and user." });
        }).WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(8192));
    }

    internal static async Task<JellyfinTitleRead> ReadTitle(HttpContext h, TorrentFlowDbContext db, WorkSnapshot work,
        ImmutableArray<MediaFileRow> files, CancellationToken ct)
    {
        var settings = await Settings(db, ct);
        JellyfinTitleState? state;
        try
        {
            state = await Adapter.ReadAsync(settings, SecretFiles.Read(HostPaths.DataDirectory(
                h.RequestServices.GetRequiredService<IConfiguration>()), settings.Credential), work, files, ct);
        }
        catch (Exception ex) when (ex is JellyfinException or OperationCanceledException or JsonException or
                                   ArgumentException or IOException or UnauthorizedAccessException)
        {
            return new(null, null);
        }
        var itemId = work.Work.Kind switch
        {
            WorkKind.Film => state?.FilmItemId,
            WorkKind.Series => state?.SeriesItemId,
            _ => null,
        };
        var publicUrl = settings.PublicUrl ?? settings.ServerUrl;
        var playback = itemId is null || publicUrl is null ? null : new
        {
            itemId,
            playUrl = $"{publicUrl.TrimEnd('/')}/web/#/details?id={Uri.EscapeDataString(itemId)}&serverId={Uri.EscapeDataString(settings.ServerId ?? "")}",
        };
        return new(state, playback);
    }

    internal static async Task<ImmutableDictionary<string, JellyfinTitleState>>
        ReadLibrary(HttpContext h, TorrentFlowDbContext db, IEnumerable<WorkSnapshot> works, ILibraryRepository inventory, CancellationToken ct)
    {
        var settings = await Settings(db, ct);
        return await LibraryRead.WatchAsync(Adapter, settings, SecretFiles.Read(HostPaths.DataDirectory(
            h.RequestServices.GetRequiredService<IConfiguration>()), settings.Credential), works, inventory, ct);
    }

    internal static async Task<JellyfinBatchRead> ReadCleanup(HttpContext h, TorrentFlowDbContext db,
        IEnumerable<(WorkSnapshot Work, ImmutableArray<MediaFileRow> Files)> works, CancellationToken ct)
    {
        var settings = await Settings(db, ct);
        var key = SecretFiles.Read(HostPaths.DataDirectory(
            h.RequestServices.GetRequiredService<IConfiguration>()), settings.Credential);
        var input = works.ToArray();
        var userIds = settings.WatchUserIds.IsEmpty
            ? settings.UserId is null ? [] : [settings.UserId]
            : settings.WatchUserIds.Distinct(StringComparer.Ordinal).ToArray();
        if (settings.ServerUrl is null || string.IsNullOrWhiteSpace(key) || userIds.Length == 0)
            return new("off", ImmutableDictionary<string, JellyfinTitleState>.Empty);

        var reads = new List<JellyfinBatchRead>(userIds.Length);
        foreach (var userId in userIds)
        {
            var read = await Adapter.ReadBatchWithStatusAsync(settings, key, input, ct, userId);
            if (read.Status != "ok") return read;
            reads.Add(read);
        }

        var combined = ImmutableDictionary.CreateBuilder<string, JellyfinTitleState>();
        foreach (var (work, _) in input)
        {
            var states = reads.Select(read => read.Items.GetValueOrDefault(work.Work.Id)).ToArray();
            if (states.Any(state => state is null)) continue;
            var first = states[0]!;
            var film = work.Work.Kind == WorkKind.Film && states.All(state => state!.Film?.Watched == true)
                ? new JellyfinProgress(true, null, states.Select(state => state!.Film!.LastPlayedAt)
                    .OfType<DateTimeOffset>().Select(value => (DateTimeOffset?)value).Max())
                : null;
            var episodes = ImmutableDictionary.CreateBuilder<string, JellyfinProgress>();
            foreach (var episode in work.Episodes)
                if (states.All(state => state!.Episodes.TryGetValue(episode.Id, out var progress) && progress.Watched))
                {
                    var lastPlayed = states.Select(state => state!.Episodes[episode.Id].LastPlayedAt)
                        .OfType<DateTimeOffset>().Select(value => (DateTimeOffset?)value).Max();
                    episodes[episode.Id] = new(true, null, lastPlayed);
                }
            combined[work.Work.Id] = first with { Film = film, Episodes = episodes.ToImmutable() };
        }
        return new("ok", combined.ToImmutable());
    }

    private static async Task<IResult> Status(TorrentFlowDbContext db, string directory, CancellationToken ct)
    {
        var settings = await Settings(db, ct);
        var credential = SecretFiles.Read(directory, settings.Credential);
        var connection = await CheckConnection(settings, credential, ct);
        var userName = connection.User?.Name;
        var isAdmin = connection.User?.IsAdmin ?? false;
        var people = await db.Users.AsNoTracking().OrderBy(user => user.Role == UserRole.Owner ? 0 : 1)
            .ThenBy(user => user.Name).Select(user => new { id = user.Id, name = user.Name, owner = user.Role == UserRole.Owner })
            .ToArrayAsync(ct);
        return Results.Json(new
        {
            people,
            settings.ServerUrl,
            settings.UserId,
            configured = settings.Credential is not null,
            userName,
            isAdmin,
            settings.ServerId,
            serverName = connection.ServerName,
            publicUrl = settings.PublicUrl ?? settings.ServerUrl,
            pathMappings = settings.PathMappings,
            watchUserIds = settings.WatchUserIds,
            userMappings = settings.UserMappings,
            syncLibraries = settings.SyncLibraries,
            suggestNextEpisodes = settings.SuggestNextEpisodes,
            subtitleLanguages = settings.SubtitleLanguages,
            connection = connection.State,
            message = connection.State switch
            {
                "ok" => "Connected to Jellyfin.",
                "unreachable" => "Jellyfin did not answer. Check it is running and the address is right.",
                "unauthorized" => "Jellyfin did not allow this request. Check the account and its permissions.",
                _ => "Connect to Jellyfin to use this feature.",
            },
        });
    }

    private static async Task<ConnectionStatus> CheckConnection(JellyfinSettings settings, string? token, CancellationToken ct)
    {
        if (settings.ServerUrl is null || token is null)
            return new("notConfigured", null, null);
        var key = settings.ServerUrl + "|" + settings.Credential?.FileId + "|" + settings.Credential?.Revision;
        var cached = statusCache;
        if (cached is not null && cached.Key == key && cached.ExpiresAt > DateTimeOffset.UtcNow)
            return cached.Status;
        await StatusGate.WaitAsync(ct);
        try
        {
            cached = statusCache;
            if (cached is not null && cached.Key == key && cached.ExpiresAt > DateTimeOffset.UtcNow)
                return cached.Status;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromMilliseconds(1500));
            ConnectionStatus status;
            try
            {
                var publicInfo = await Client.GetPublicSystemInfo(settings.ServerUrl, timeout.Token);
                var user = await CurrentUser(settings, token, timeout.Token);
                var serverName = publicInfo.TryGetProperty("ServerName", out var name) ? name.GetString() : null;
                status = new("ok", user, serverName);
            }
            catch (JellyfinException ex)
            {
                status = new(ex.Kind == JellyfinErrorKind.Unauthorized ? "unauthorized" : "unreachable", null, null);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                status = new("unreachable", null, null);
            }
            statusCache = new CachedStatus(key, status, DateTimeOffset.UtcNow.AddSeconds(30));
            return status;
        }
        finally { StatusGate.Release(); }
    }

    private static async Task<JellyfinUser?> CurrentUser(JellyfinSettings settings, string? token, CancellationToken ct)
    {
        if (settings.ServerUrl is null || token is null) return null;
        var user = await Client.GetCurrentUser(settings.ServerUrl, token, ct);
        return user ?? (settings.UserId is null ? null : await Client.GetUser(settings.ServerUrl, token, settings.UserId, ct));
    }

    private static async Task<bool> DirectoryReadable(JellyfinClient client, string server, string token,
        string path, CancellationToken ct)
    {
        await client.GetDirectoryContents(server, token, path, ct);
        return true;
    }

    private static async Task<bool> IsAdmin(JellyfinSettings settings, string token, CancellationToken ct) =>
        (await CurrentUser(settings, token, ct))?.IsAdmin == true;

    private static bool SamePath(string first, string second) => JellyfinPathMapper.PathsEqual(first, second);

    private static string Leaf(string path) => path.TrimEnd('\\', '/').Split(['\\', '/']).LastOrDefault() ?? "";

    private static int TrailingFolderMatches(string first, string second)
    {
        var left = first.TrimEnd('\\', '/').Split(['\\', '/'], StringSplitOptions.RemoveEmptyEntries);
        var right = second.TrimEnd('\\', '/').Split(['\\', '/'], StringSplitOptions.RemoveEmptyEntries);
        var count = 0;
        while (count < left.Length && count < right.Length &&
            string.Equals(left[^(count + 1)], right[^(count + 1)], StringComparison.OrdinalIgnoreCase)) count++;
        return count;
    }

    private static string? OptionalString(JsonElement body, string name) =>
        body.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null ? value.GetString()?.Trim() : null;

    private static ImmutableArray<JellyfinPathMapping> ReadMappings(JsonElement body)
    {
        if (!body.TryGetProperty("pathMappings", out var mappings) || mappings.ValueKind != JsonValueKind.Array)
            throw new ArgumentException("Send a list of folder path mappings.");
        return [.. mappings.EnumerateArray().Select(mapping => new JellyfinPathMapping(
            mapping.GetProperty("from").GetString()?.Trim() ?? "",
            mapping.GetProperty("to").GetString()?.Trim() ?? ""))];
    }

    private static ImmutableArray<string> ReadStringArray(JsonElement body, string name)
    {
        if (!body.TryGetProperty(name, out var values) || values.ValueKind != JsonValueKind.Array)
            throw new ArgumentException($"Send a list for {name}.");
        return [.. values.EnumerateArray().Select(value =>
            value.ValueKind == JsonValueKind.String ? value.GetString()?.Trim() ?? "" :
            throw new ArgumentException($"Every {name} entry must be text."))];
    }

    private static ImmutableArray<JellyfinUserMapping> ReadUserMappings(JsonElement body)
    {
        if (!body.TryGetProperty("userMappings", out var mappings) || mappings.ValueKind != JsonValueKind.Array)
            throw new ArgumentException("Send a list of TorrentFlow and Jellyfin user mappings.");
        return [.. mappings.EnumerateArray().Select(mapping => new JellyfinUserMapping(
            mapping.GetProperty("torrentFlowUserId").GetString()?.Trim() ?? "",
            mapping.GetProperty("jellyfinUserId").GetString()?.Trim() ?? ""))];
    }

    private static bool RequiredBoolean(JsonElement body, string name) =>
        body.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? value.GetBoolean() : throw new ArgumentException($"Choose whether {name} is on or off.");

    private static int RequiredInteger(JsonElement body, string name) =>
        body.TryGetProperty(name, out var value) && value.TryGetInt32(out var result)
            ? result : throw new ArgumentException($"Choose a whole number for {name}.");

    private static async Task<JellyfinSettings> Settings(TorrentFlowDbContext db, CancellationToken ct) =>
        SettingsCatalog.Read<JellyfinSettings>(await db.Settings.AsNoTracking().SingleAsync(setting => setting.Id == "jellyfin", ct));

    private static async Task Save(TorrentFlowDbContext db, SettingRow row, JellyfinSettings settings, CancellationToken ct)
    {
        var next = row with { Value = JsonSerializer.SerializeToElement(settings),
            Revision = row.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
        SettingsCatalog.Validate(next);
        db.Entry(row).CurrentValues.SetValues(next);
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateConcurrencyException) { throw new InvalidOperationException("Settings changed. Try again."); }
        Adapter.Invalidate();
        statusCache = null;
    }

    private sealed record ConnectionStatus(string State, JellyfinUser? User, string? ServerName);
    private sealed record CachedStatus(string Key, ConnectionStatus Status, DateTimeOffset ExpiresAt);
}
