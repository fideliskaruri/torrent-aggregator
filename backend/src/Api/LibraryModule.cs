using TorrentFlow.Domain;
using TorrentFlow.Library;

namespace TorrentFlow.Api;

internal static class LibraryModule
{
    internal static IServiceCollection AddLibrary(this IServiceCollection services) =>
        services.AddScoped<ILibraryPlacement, LibraryPlacement>()
            .AddScoped<MediaImport>().AddSingleton<ImportJobs>();

    internal static Task MapLibraryAsync(this WebApplication app)
    {
        app.MapImports();
        app.MapLibraryActions();
        return Task.CompletedTask;
    }
}
