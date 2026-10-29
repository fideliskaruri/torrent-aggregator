using TorrentFlow.Domain;
using TorrentFlow.Library;

namespace TorrentFlow.Api;

internal static class LibraryModule
{
    internal static IServiceCollection AddLibrary(this IServiceCollection services) =>
        services.AddSingleton<IStorageStatus, StorageStatus>()
            .AddScoped<LibraryPlacement>()
            .AddScoped<ILibraryPlacement>(sp => sp.GetRequiredService<LibraryPlacement>())
            .AddScoped<MediaImport>().AddSingleton<ImportJobs>()
            .AddHostedService<StorageWatcher>();

    internal static Task MapLibraryAsync(this WebApplication app)
    {
        app.MapImports();
        app.MapLibraryActions();
        return Task.CompletedTask;
    }
}
