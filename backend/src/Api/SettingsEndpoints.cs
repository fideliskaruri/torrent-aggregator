using System.Collections.Immutable;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Metadata;
using TorrentFlow.Sources;
using TorrentFlow.Store;

namespace TorrentFlow.Api;

internal static class SettingsEndpoints
{
    internal static async Task MapSettingsAsync(this WebApplication app)
    {
        var service = new SettingsApi(app.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>(),
            HostPaths.DataDirectory(app.Configuration));
        await service.InitializeAsync(CancellationToken.None);
        var group = app.MapGroup("/api/settings").AddEndpointFilter(async (context, next) =>
        {
            if (AccessIdentity.Actor(context.HttpContext).Role != UserRole.Owner ||
                context.HttpContext.Request.Headers["Sec-Fetch-Site"].ToString().ToLowerInvariant() is not ("" or "none" or "same-origin"))
                return Results.StatusCode(403);
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            try { return await next(context); }
            catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or JsonException or KeyNotFoundException or FormatException)
            { return Results.BadRequest(new { error = "Invalid settings. Check the key, URLs, priority and timeout." }); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            { return Results.Json(new { error = "Could not save settings. Check access to the data directory." }, statusCode: 503); }
        });
        group.MapJellyfin(HostPaths.DataDirectory(app.Configuration),
            app.Services.GetRequiredService<TorrentFlow.Library.Jellyfin.JellyfinClient>(),
            app.Services.GetRequiredService<JellyfinLibrarySync>());
        group.MapGet("/tmdb", async (CancellationToken ct) => Results.Json(await service.TmdbAsync(null, false, ct)));
        group.MapPut("/tmdb", async (JsonElement body, CancellationToken ct) =>
            Results.Json(await service.TmdbAsync(body.GetProperty("apiKey").GetString() ??
                throw new ArgumentException("Enter a usable TMDB key."), false, ct)))
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(8192));
        group.MapDelete("/tmdb", async (CancellationToken ct) => Results.Json(await service.TmdbAsync(null, true, ct)));
        group.MapPost("/tmdb/test", async (JsonElement body, CancellationToken ct) =>
        {
            var result = await service.TestTmdbAsync(body.TryGetProperty("apiKey", out var key) ? key.GetString() : null, ct);
            return Results.Json(result, statusCode: result.HttpStatus);
        }).WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(8192));
        group.MapGet("/sources", async (CancellationToken ct) => Results.Json(await service.SourcesAsync(null, null, false, ct)));
        group.MapPut("/sources/{id}", async (string id, JsonElement body, CancellationToken ct) =>
            Results.Json(await service.SourcesAsync(id, body, false, ct)))
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(32768));
        group.MapDelete("/sources/{id}", async (string id, CancellationToken ct) =>
            Results.Json(await service.SourcesAsync(id, null, true, ct)));
        group.MapPost("/sources/{id}/test", async (string id, CancellationToken ct) =>
            await service.TestSourceAsync(id, ct));
    }
}

internal sealed class SettingsApi(IDbContextFactory<TorrentFlowDbContext> contexts, string dataDirectory)
{
    internal sealed record TmdbTestResult(bool Ok, string Status, string Message,
        [property: JsonIgnore] int HttpStatus = 200);
    private readonly SemaphoreSlim gate = new(1, 1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
        { Converters = { new JsonStringEnumConverter() } };
    private static bool Accepts(string? key) => TmdbCredentialSettings.Accepts(key);
    private static string Hint(string? key) => key is { Length: >= 4 } ? "••••" + key[^4..] : "";
    internal async Task InitializeAsync(CancellationToken ct)
    {
        await using var db = await contexts.CreateDbContextAsync(ct);
        var row = await db.Settings.SingleAsync(s => s.Id == "metadata", ct);
        var metadata = SettingsCatalog.Read<MetadataSettings>(row);
        var sources = metadata.Sources;
        var missing = SourceSettingsContract.MetadataDefaults(metadata.EnabledProviders)
            .Where(s => !sources.Any(existing => existing.Id == s.Id)).ToArray();
        if (missing.Length > 0) await Save(db, row, metadata with { Sources = sources.AddRange(missing) }, ct);
    }
    private static async Task Save<T>(TorrentFlowDbContext db, SettingRow row, T value, CancellationToken ct)
    {
        var next = row with { Value = JsonSerializer.SerializeToElement(value, Json),
            Revision = row.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
        SettingsCatalog.Validate(next);
        db.Entry(row).CurrentValues.SetValues(next);
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateConcurrencyException) { throw new InvalidOperationException("Settings changed. Try again."); }
    }

    internal async Task<object> TmdbAsync(string? key, bool remove, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(ct);
            var row = await db.Settings.SingleAsync(s => s.Id == "metadata", ct);
            var settings = SettingsCatalog.Read<MetadataSettings>(row);
            if (key is not null || remove)
            {
                if (!remove && !Accepts(key)) throw new ArgumentException("Enter a usable TMDB key.");
                settings = settings with
                {
                    TmdbCredential = remove ? null : SecretFiles.Save(dataDirectory, TmdbCredentialSettings.Normalize(key)),
                    Sources = remove ? settings.Sources : settings.Sources.Select(s => s.Id == "tmdb" ? s with { Enabled = true } : s).ToImmutableArray(),
                };
                await Save(db, row, settings, ct);
            }
            var saved = SecretFiles.Read(dataDirectory, settings.TmdbCredential);
            var effective = saved ?? Environment.GetEnvironmentVariable("TMDB_API_KEY")?.Trim();
            if (settings.Sources.FirstOrDefault(s => s.Id == "tmdb") is { Enabled: false }) effective = null;
            return new { configured = Accepts(effective), hint = Hint(effective),
                source = saved is not null ? "settings" : Accepts(effective) ? "environment" : "none" };
        }
        finally { gate.Release(); }
    }

    internal async Task<TmdbTestResult> TestTmdbAsync(string? key, CancellationToken ct)
    {
        if (key is null)
        {
            await using var db = await contexts.CreateDbContextAsync(ct);
            var settings = SettingsCatalog.Read<MetadataSettings>(
                await db.Settings.AsNoTracking().SingleAsync(s => s.Id == "metadata", ct));
            key = SecretFiles.Read(dataDirectory, settings.TmdbCredential) ?? Environment.GetEnvironmentVariable("TMDB_API_KEY");
            if (settings.Sources.FirstOrDefault(s => s.Id == "tmdb") is { Enabled: false }) key = null;
        }
        if (!Accepts(key)) return new(false, "invalid", "Enter a usable TMDB API key.", 400);
        key = TmdbCredentialSettings.Normalize(key);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            using var client = new HttpClient();
            using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.themoviedb.org/3/configuration");
            if (key!.Length == 32) request.RequestUri = new("https://api.themoviedb.org/3/configuration?api_key=" + Uri.EscapeDataString(key));
            else request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            using var response = await client.SendAsync(request, timeout.Token);
            var status = response.IsSuccessStatusCode ? "ok" : (int)response.StatusCode is 401 or 403 ? "invalid" : "unavailable";
            return new(status == "ok", status, status == "ok" ? "TMDB accepted this key." : "TMDB did not accept the key or could not be reached. Check your key and connection.");
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException)
        { return new(false, "unavailable", "Could not reach TMDB. Check your network and try again."); }
    }

    internal async Task<object> SourcesAsync(string? id, JsonElement? body, bool remove, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(ct);
            var row = await db.Settings.SingleAsync(s => s.Id == "sources", ct);
            var settings = SettingsCatalog.Read<ImmutableArray<SourceSettings>>(row);
            var metadataRow = await db.Settings.SingleAsync(s => s.Id == "metadata", ct);
            var metadata = SettingsCatalog.Read<MetadataSettings>(metadataRow);
            settings = settings.AddRange(metadata.Sources);
            if (id is not null)
            {
                var existing = settings.FirstOrDefault(s => s.Id == id);
                if (remove)
                {
                    if (existing is not null && !SourceSettingsContract.Custom(existing))
                        throw new ArgumentException("Disable built-in sources instead of removing them.");
                    settings = [.. settings.Where(s => s.Id != id)];
                }
                else
                {
                    var input = body!.Value;
                    SecretReference? credential = existing?.Credential;
                    var updated = SourceSettingsContract.Update(existing, id, input, credential);
                    if (input.TryGetProperty("credential", out var secret))
                    {
                        if (id == "tmdb" && secret.ValueKind != JsonValueKind.Null && !Accepts(secret.GetString()))
                            throw new ArgumentException("Enter a usable TMDB key.");
                        var text = secret.ValueKind == JsonValueKind.Null ? null : secret.GetString();
                        if (text is { Length: > 4096 } || text?.Any(char.IsControl) == true)
                            throw new ArgumentException("Enter a usable API key.");
                        credential = string.IsNullOrWhiteSpace(text) ? null : SecretFiles.Save(dataDirectory,
                            id == "tmdb" ? TmdbCredentialSettings.Normalize(text) : text);
                        updated = updated with { Credential = credential };
                    }
                    if (id == "tmdb" && input.TryGetProperty("credential", out _))
                    {
                        metadata = metadata with { TmdbCredential = credential };
                        updated = updated with { Credential = null };
                    }
                    settings = [.. settings.Where(s => s.Id != id), updated];
                }
                if (metadata.Sources.Any(s => s.Id == id))
                    await Save(db, metadataRow, metadata with
                        { Sources = [.. settings.Where(s => s.Kind == "metadata")] }, ct);
                else
                    await Save(db, row, settings.Where(s => s.Kind != "metadata").ToImmutableArray(), ct);
            }
            return new { sources = settings.OrderBy(s => s.Priority).Select(s => new
            {
                s.Id, kind = s.Kind == "metadata" ? "metadata" : "torrent", s.Type, s.Categories, s.Enabled,
                active = s.Enabled && (s.Type != "tmdb" || Accepts(SecretFiles.Read(dataDirectory, metadata.TmdbCredential) ??
                    Environment.GetEnvironmentVariable("TMDB_API_KEY"))),
                s.Priority, baseUrl = SourceSettingsContract.Endpoint(s), s.Mirrors, s.Options,
                timeoutMs = s.TimeoutMilliseconds, custom = SourceSettingsContract.Custom(s),
                credential = new { configured = s.Type == "tmdb" ? Accepts(SecretFiles.Read(dataDirectory, metadata.TmdbCredential) ??
                    Environment.GetEnvironmentVariable("TMDB_API_KEY")) : s.Credential is not null,
                    hint = Hint(s.Type == "tmdb" ? SecretFiles.Read(dataDirectory, metadata.TmdbCredential) ??
                    Environment.GetEnvironmentVariable("TMDB_API_KEY") : SecretFiles.Read(dataDirectory, s.Credential)) },
            }), error = (string?)null };
        }
        finally { gate.Release(); }
    }

    internal async Task<IResult> TestSourceAsync(string id, CancellationToken ct)
    {
        await using var db = await contexts.CreateDbContextAsync(ct);
        var settings = SettingsCatalog.Read<ImmutableArray<SourceSettings>>(
            await db.Settings.AsNoTracking().SingleAsync(s => s.Id == "sources", ct));
        var metadata = SettingsCatalog.Read<MetadataSettings>(
            await db.Settings.AsNoTracking().SingleAsync(s => s.Id == "metadata", ct));
        settings = settings.AddRange(metadata.Sources);
        var source = settings.FirstOrDefault(s => s.Id == id);
        if (source is null) return Results.NotFound(new { error = "Source not found." });
        var reference = source.Type == "tmdb"
            ? metadata.TmdbCredential : source.Credential;
        var credential = SecretFiles.Read(dataDirectory, reference) ??
            (source.Type == "tmdb" ? Environment.GetEnvironmentVariable("TMDB_API_KEY") : null);
        return Results.Ok(await SourceSettingsHealth.TestAsync(source, credential, ct));
    }
}
