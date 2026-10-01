using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace TorrentFlow.Engine.Layout;

public static class LayoutModule
{
    /// <summary>Registers completed-download finalisation: the built-in media check and the content layout.</summary>
    public static IServiceCollection AddContentLayout(this IServiceCollection services)
    {
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<CompletedMediaValidator>();
        services.AddSingleton<CompletedLayoutFinalizer>();
        return services;
    }
}