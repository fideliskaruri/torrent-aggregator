using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;

namespace TorrentFlow.Engine.Layout;

public static class LayoutModule
{
    /// <summary>Registers completed-download finalisation: optional ffprobe validation and the content layout.</summary>
    public static IServiceCollection AddContentLayout(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<LayoutMediaOptions>()
            .Bind(configuration.GetSection(LayoutMediaOptions.Section))
            .PostConfigure<IHostEnvironment>((o, env) =>
            {
                // The Next.js app resolved ffprobe-static under its own cwd; the repo root is an ancestor of both.
                o.SearchRoots.Add(env.ContentRootPath);
                if (configuration["TorrentFlow:DataDirectory"] is { Length: > 0 } data) o.SearchRoots.Add(data);
            });
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<FfprobeLocator>();
        services.AddSingleton<CompletedMediaValidator>();
        services.AddSingleton<CompletedLayoutFinalizer>();
        return services;
    }
}
