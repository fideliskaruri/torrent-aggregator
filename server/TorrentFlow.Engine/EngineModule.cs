using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Clients.External;
using TorrentFlow.Engine.Layout;
using TorrentFlow.Engine.Queue;
using TorrentFlow.Engine.Settings;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine;

public static class EngineModule
{
    /// <summary>Registers the Engine module's services. Controllers in this assembly are discovered by the API host.</summary>
    public static IServiceCollection AddEngineModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<EngineOptions>()
            .Bind(configuration.GetSection(EngineOptions.Section))
            .PostConfigure<IHostEnvironment>((o, env) =>
            {
                if (string.IsNullOrWhiteSpace(o.DataDirectory))
                    o.DataDirectory = configuration["TorrentFlow:DataDirectory"] ?? Path.Combine(env.ContentRootPath, "data");
                // The env var name the TypeScript engine used keeps working for probes and scripts.
                if (Environment.GetEnvironmentVariable(EngineOptions.MaxActiveEnvVar) is { Length: > 0 } raw)
                    o.MaxActiveDownloads = DownloadQueue.ParseMaxActive(raw);
            })
            .ValidateDataAnnotations()
            .ValidateOnStart();

        services.TryAddSingleton(TimeProvider.System);
        services.AddHttpClient(TorrentEngineService.HttpClientName, c =>
        {
            c.Timeout = TimeSpan.FromSeconds(30);
            c.DefaultRequestHeaders.UserAgent.ParseAdd("TorrentFlow/1.0");
        });
        services.AddSingleton<ClientSettingsStore>();
        services.AddSingleton<SecretProtector>();
        services.AddExternalClients();
        services.AddSingleton<StorageBudget>();
        services.AddSingleton<MonoTorrentBackend>();
        services.AddSingleton<ITorrentBackend>(sp => sp.GetRequiredService<MonoTorrentBackend>());
        services.AddContentLayout(configuration);
        services.AddSingleton<TorrentEngineService>();
        services.AddSingleton<ITorrentEngine>(sp => sp.GetRequiredService<TorrentEngineService>());
        services.AddSingleton<RetentionSweeper>();
        services.AddHostedService<EngineMonitorService>();
        return services;
    }
}
