using TorrentFlow.Domain;
using TorrentFlow.Library;

namespace TorrentFlow.Api;

internal static class DevLibrary
{
    internal static IServiceCollection AddDevLibrary(this IServiceCollection services) =>
        services.AddScoped<LibraryPlacement>()
            .AddScoped<ILibraryPlacement>(sp => sp.GetRequiredService<LibraryPlacement>())
            .AddScoped<MediaImport>().AddSingleton<ImportJobs>();

    internal static Task MapDevLibraryAsync(this WebApplication app)
    {
        app.MapImports();
        app.MapLibraryActions();
        return Task.CompletedTask;
    }
}
