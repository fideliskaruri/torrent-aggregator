using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Library.Jellyfin;

namespace TorrentFlow.Api;

internal static class LibraryModule
{
    internal static IServiceCollection AddLibrary(this IServiceCollection services, string dataDirectory) =>
        services.AddSingleton<IStorageStatus, StorageStatus>()
            .AddScoped<LibraryPlacement>()
            .AddScoped<ILibraryPlacement>(sp => sp.GetRequiredService<LibraryPlacement>())
            .AddScoped<MediaImport>().AddSingleton<ImportJobs>()
            .AddSingleton(sp => new JellyfinLibrarySync(sp.GetRequiredService<IServiceScopeFactory>(),
                sp.GetRequiredService<JellyfinClient>(), dataDirectory,
                sp.GetRequiredService<Microsoft.Extensions.Logging.ILogger<JellyfinLibrarySync>>()))
            .AddHostedService(sp => sp.GetRequiredService<JellyfinLibrarySync>())
            .AddHostedService<StorageWatcher>()
            .AddHostedService(sp => new JellyfinJobWorker(sp.GetRequiredService<IServiceScopeFactory>(),
                sp.GetRequiredService<JellyfinClient>(), dataDirectory,
                sp.GetRequiredService<Microsoft.Extensions.Logging.ILogger<JellyfinJobWorker>>()));

    internal static Task MapLibraryAsync(this WebApplication app)
    {
        app.MapImports(app.Services.GetRequiredService<JellyfinLibrarySync>());
        app.MapLibraryActions();
        return Task.CompletedTask;
    }
}
