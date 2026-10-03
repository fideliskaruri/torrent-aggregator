using System.Collections.Immutable;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Store;

namespace TorrentFlow.Api;

internal static class DevLibrary
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    internal static IServiceCollection AddDevLibrary(this IServiceCollection services) =>
        services.AddScoped<ILibraryPlacement, LibraryPlacement>()
            .AddSingleton<DevFiling>().AddHostedService<DevFilingHost>();

    internal static async Task MapDevLibraryAsync(this WebApplication app)
    {
        // The old settings are read-only migration input; no auto-enrollment or old-drive writes.
        if (app.Configuration["TorrentFlow:Library:LegacyDatabase"] is { Length: > 0 } legacy)
        {
            await using var scope = app.Services.CreateAsyncScope();
            var settings = await LibraryRepository.ReadLegacySettingsAsync(legacy, CancellationToken.None);
            if (settings is not null)
            {
                var result = await scope.ServiceProvider.GetRequiredService<ILibraryPlacement>().SeedAsync(settings, CancellationToken.None);
                if (result.Failure is { } failure) app.Logger.LogWarning("Library settings seed: {Reason}", failure.Message);
            }
        }
        if (!app.Environment.IsDevelopment()) return;
        DevFiling.Map(app);
        var group = app.MapGroup("/api/dev/library").AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var actor = AccessIdentity.Actor(http);
            if (actor.Role != UserRole.Owner || !actor.TrustedLocal ||
                http.Connection.RemoteIpAddress is not { } ip || !IPAddress.IsLoopback(ip))
                return Results.StatusCode(403);
            try { return await next(context); }
            catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException)
            { return Results.BadRequest(new { error = "invalid_library_input", message = ex.Message }); }
        });
        group.MapGet("/roots", async (ILibraryPlacement library, CancellationToken ct) =>
            Results.Json(new { roots = await library.RootsAsync(ct) }, Json));
        group.MapPost("/roots", async (LibraryRootInput input, ILibraryPlacement library, CancellationToken ct) =>
            Reply(await library.AddRootAsync(input, ct)));
        group.MapPost("/roots/{id}/check", async (string id, ILibraryPlacement library, CancellationToken ct) =>
            Reply(await library.CheckRootAsync(id, ct)));
        group.MapPut("/roots/{id}", async (string id, LibraryRootConfiguration input, ILibraryPlacement library, CancellationToken ct) =>
            Reply(await library.ConfigureRootAsync(id, input, ct)));
        group.MapDelete("/roots/{id}", async (string id, ILibraryPlacement library, CancellationToken ct) =>
            Reply(await library.RemoveRootAsync(id, ct)));
        group.MapPost("/place", async (PlacementInput input, ILibraryPlacement library, CancellationToken ct) =>
            Results.Json(await library.PlaceAsync(input, ct), Json));
        group.MapGet("/owned/{workId}", async (string workId, string? episodeId, bool? film,
            ILibraryPlacement library, CancellationToken ct) =>
            Results.Json(new { items = (await library.OwnedAsync(new(workId,
                episodeId is null ? [] : [episodeId], film == true), ct)).Select(LibraryPlacement.PublicOwned) }, Json));
        group.MapPost("/media", async (MediaFileRow input, ILibraryPlacement library, CancellationToken ct) =>
        {
            var failure = await library.RecordAsync(input, null, ct);
            return Results.Json(new { recorded = failure is null, failure }, Json, statusCode: failure is null ? 200 : 409);
        });
        group.MapPost("/prune", async (ILibraryPlacement library, CancellationToken ct) =>
            Results.Json(new { dropped = await library.PruneMissingAsync(DateTimeOffset.UtcNow, ct) }));
        group.MapPost("/catalog", async (WorkSnapshot input, IServiceProvider services, CancellationToken ct) =>
        {
            var key = Guid.NewGuid().ToString("N");
            var now = DateTimeOffset.UtcNow;
            var receipt = new AttemptRow($"commit:library-proof:{key}", null, null, null, null, AttemptKind.LegacyEvent,
                now, now, "applied", "library-proof", null, null, null, null, null, null, null);
            var rows = new List<StoreRow> { input.Work };
            rows.AddRange(input.Names); rows.AddRange(input.Seasons); rows.AddRange(input.Episodes);
            rows.Add(receipt);
            var result = await services.GetRequiredKeyedService<IStore>("metadata").CommitAsync(new(key,
                StoreOwner.Metadata, [.. rows.Select(r => new RowWrite(r, null, null))], []), ct);
            return Results.Json(result, Json);
        });
        group.MapPost("/names", (LibraryNameInput input) =>
        {
            var folder = Path.Combine(LibraryPaths.KindFolder(input.Folders ?? LibraryPaths.DefaultFolders, input.Kind),
                LibraryPaths.ItemFolder(input.Title, input.WorkId, input.Year, input.Kind is LibraryKind.Movies or LibraryKind.AnimeMovies));
            if (input.Kind is LibraryKind.TV or LibraryKind.Anime) folder = Path.Combine(folder, $"Season {input.Season ?? 1:00}");
            var finalFolder = LibraryPaths.Within(input.RootPath, folder);
            return Results.Json(new { folder = finalFolder,
                path = LibraryPaths.Within(finalFolder, LibraryPaths.SafeLeaf(input.FileName)) });
        });
    }

    private static IResult Reply(LibraryRootResult result) =>
        Results.Json(result, Json, statusCode: result.Failure is null ? 200 : 409);
    private sealed record LibraryNameInput(string RootPath, string WorkId, string Title, int? Year,
        LibraryKind Kind, int? Season, string FileName, LibraryFolders? Folders);
}
