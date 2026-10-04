using System.Text.Json;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Library.Jellyfin;
using TorrentFlow.Store;

namespace TorrentFlow.Api;

internal static class JellyfinEndpoints
{
    internal static readonly JellyfinWatchState Adapter = new();
    private static readonly SemaphoreSlim Gate = new(1, 1);
    internal static IResult TitleJson(object value)
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var node = JsonSerializer.SerializeToNode(value, options)!.AsObject();
        foreach (var key in new[] { "watchState", "jellyfinNextUp" })
            if (node[key] is null) node.Remove(key);
        foreach (var episode in node["episodes"]!.AsArray())
            if (episode!["watchState"] is null) episode.AsObject().Remove("watchState");
        return Results.Json(node, options);
    }
    internal static void MapJellyfin(this RouteGroupBuilder group, string directory)
    {
        group.MapGet("/jellyfin", async (HttpContext h, CancellationToken ct) =>
            Results.Json(Public(await Settings(h, ct))));
        group.MapPut("/jellyfin", async (HttpContext h, JsonElement body, CancellationToken ct) =>
        {
            await Gate.WaitAsync(ct);
            try
            {
                var store = Store(h);
                var row = (await store.ReadAsync<SettingRow>(AccessState.Query("jellyfin"), ct)).Single();
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
                var settings = new JellyfinSettings(server, credential, user);
                await Save(store, row, settings, ct);
                return Results.Json(Public(settings));
            }
            finally { Gate.Release(); }
        }).WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(8192));
        group.MapDelete("/jellyfin", async (HttpContext h, CancellationToken ct) =>
        {
            await Gate.WaitAsync(ct);
            try
            {
                var store = Store(h);
                var row = (await store.ReadAsync<SettingRow>(AccessState.Query("jellyfin"), ct)).Single();
                var empty = new JellyfinSettings(null, null, null);
                await Save(store, row, empty, ct);
                return Results.Json(Public(empty));
            }
            finally { Gate.Release(); }
        });
        group.MapPost("/jellyfin/test", async (HttpContext h, JsonElement body, CancellationToken ct) =>
        {
            var saved = await Settings(h, ct);
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
    internal static async Task<JellyfinTitleState?> ReadTitle(HttpContext h, WorkSnapshot work,
        System.Collections.Immutable.ImmutableArray<MediaFileRow> files, CancellationToken ct)
    {
        var settings = await Settings(h, ct);
        return await Adapter.ReadAsync(settings, SecretFiles.Read(HostPaths.DataDirectory(
            h.RequestServices.GetRequiredService<IConfiguration>()), settings.Credential), work, files, ct);
    }
    internal static async Task<System.Collections.Immutable.ImmutableDictionary<string, JellyfinTitleState>>
        ReadLibrary(HttpContext h, IEnumerable<WorkSnapshot> works, ILibraryRepository inventory, CancellationToken ct)
    {
        var settings = await Settings(h, ct);
        return await LibraryRead.WatchAsync(Adapter, settings, SecretFiles.Read(HostPaths.DataDirectory(
            h.RequestServices.GetRequiredService<IConfiguration>()), settings.Credential), works, inventory, ct);
    }
    private static IStore Store(HttpContext h) => h.RequestServices.GetRequiredService<IStore>();
    private static async Task<JellyfinSettings> Settings(HttpContext h, CancellationToken ct) =>
        SettingsCatalog.Read<JellyfinSettings>((await Store(h).ReadAsync<SettingRow>(AccessState.Query("jellyfin"), ct)).Single());
    private static object Public(JellyfinSettings settings) => new
    {
        settings.ServerUrl, settings.UserId, configured = settings.Credential is not null,
    };
    private static async Task Save(IStore store, SettingRow row, JellyfinSettings settings, CancellationToken ct)
    {
        var next = row with { Value = JsonSerializer.SerializeToElement(settings),
            Revision = row.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
        if (!(await AccessState.CommitAsync(store, next, row.Revision, null, ct)).Applied)
            throw new InvalidOperationException("Settings changed. Try again.");
        Adapter.Invalidate();
    }
}
