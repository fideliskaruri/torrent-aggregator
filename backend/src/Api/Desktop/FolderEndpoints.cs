using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Library;

namespace TorrentFlow.Api.Desktop;

public static class FolderEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    { DefaultIgnoreCondition = JsonIgnoreCondition.Never };

    public static IServiceCollection AddLocalFiles(this IServiceCollection services) =>
        services.AddScoped<ILocalFiles>(sp => new LocalFiles(sp.GetRequiredService<ILibraryRepository>(),
            sp.GetRequiredService<IStore>()));

    public static void MapLocalFiles(this WebApplication app)
    {
        app.MapGet("/api/settings/browse-folders", (string? path, ILocalFiles files) => Reply(files.Browse(path)));
        app.MapPost("/api/settings/open-folder", async (HttpContext http, ILocalFiles files) =>
        {
            if (AccessIdentity.InContainer) return Results.Json(new {
                error = "Folder opening is unavailable in a container. Open the mapped media folder on your computer instead.",
                openFolderDisabled = true }, statusCode: 409);
            var body = await ReadAsync(http);
            if (body is null) return InvalidJson();
            foreach (var (field, max) in new[] { ("path", 4096), ("category", 100) })
            {
                if (!body.Value.TryGetProperty(field, out var value) || value.ValueKind == JsonValueKind.Null) continue;
                if (value.ValueKind != JsonValueKind.String) return Results.BadRequest(new { error = $"{field} must be a string", field });
                if (value.GetString()!.Trim().Length > max) return Results.BadRequest(new { error = $"{field} must be at most {max} characters", field });
            }
            if (body.Value.TryGetProperty("reveal", out var reveal) && reveal.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                return Results.BadRequest(new { error = "reveal must be a boolean", field = "reveal" });
            return Reply(await files.OpenFolderAsync(Str(body.Value, "path"), Str(body.Value, "category"),
                reveal.ValueKind != JsonValueKind.False, http.RequestAborted));
        });
        app.MapPost("/api/downloads/{transferId}/open", async (string transferId, HttpContext http, ILocalFiles files) =>
        {
            if (AccessIdentity.InContainer) return Results.Json(new { ok = false, reason = "container",
                error = "Files can't be opened while TorrentFlow runs in a container.",
                message = "Open the mapped media folder on your computer instead.", openFolderDisabled = true }, statusCode: 409);
            var mode = "open";
            if (http.Request.ContentLength != 0)
            {
                var body = await ReadAsync(http);
                if (body is null) return InvalidJson();
                if (body.Value.TryGetProperty("mode", out var value) && value.ValueKind != JsonValueKind.Null)
                {
                    mode = value.ValueKind == JsonValueKind.String ? value.GetString()!.Trim().ToLowerInvariant() : "";
                    if (mode is not ("open" or "reveal"))
                        return Results.BadRequest(new { ok = false, reason = "invalid-mode", field = "mode",
                            error = "mode must be \"open\" or \"reveal\"", message = "Choose open or show in folder." });
                }
            }
            return Reply(await files.OpenDownloadAsync(transferId, mode, http.RequestAborted));
        });
    }

    private static IResult Reply(LocalFileResult result) => Results.Json(result.Body, Json, statusCode: result.Error switch
    {
        null => 200, LocalFileError.Invalid => 400, LocalFileError.Forbidden => 403,
        LocalFileError.Missing => 404, LocalFileError.Conflict => 409, LocalFileError.Gone => 410,
        LocalFileError.TooLarge => 413, _ => 500,
    });
    private static string? Str(JsonElement body, string name) =>
        body.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static IResult InvalidJson() => Results.BadRequest(new { error = "Invalid JSON body" });
    private static async Task<JsonElement?> ReadAsync(HttpContext http)
    {
        if (http.Request.ContentLength > 16384) return null;
        try
        {
            using var doc = await JsonDocument.ParseAsync(http.Request.Body, cancellationToken: http.RequestAborted);
            return doc.RootElement.ValueKind == JsonValueKind.Object ? doc.RootElement.Clone() : null;
        }
        catch (JsonException) { return null; }
    }
}
