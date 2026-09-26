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
                o.DataDirectory = configuration["TorrentFlow:DataDirectory"]
                    ?? throw new InvalidOperationException("The host must resolve TorrentFlow:DataDirectory before registering the engine.");
                // The env var name the TypeScript engine used keeps working for probes and scripts.
                if (Environment.GetEnvironmentVariable(EngineOptions.MaxActiveEnvVar) is { Length: > 0 } raw)
                    o.MaxActiveDownloads = DownloadQueue.ParseMaxActive(raw);
            })
            .ValidateDataAnnotations()
            .ValidateOnStart();
        services.AddOptions<ExternalClientOptions>()
            .Bind(configuration.GetSection(ExternalClientOptions.Section));

        services.TryAddSingleton(TimeProvider.System);
        services.AddHttpClient(TorrentEngineService.HttpClientName, c =>
        {
            c.Timeout = TimeSpan.FromSeconds(30);
            c.DefaultRequestHeaders.UserAgent.ParseAdd("TorrentFlow/1.0");
        });
        services.AddHttpClient(TrackerListRefreshService.HttpClientName, c =>
        {
            c.Timeout = TimeSpan.FromSeconds(10);
            c.DefaultRequestHeaders.UserAgent.ParseAdd("TorrentFlow/1.0");
        });
        services.AddHostedService<TrackerListRefreshService>();
        services.AddSingleton<ClientSettingsStore>();
        services.AddSingleton<SecretProtector>();
        services.AddExternalClients();
        services.AddSingleton<StorageBudget>();
        services.AddSingleton<DownloadLimits>();
        services.AddSingleton<MonoTorrentBackend>();
        services.AddSingleton<ITorrentBackend>(sp => sp.GetRequiredService<MonoTorrentBackend>());
        services.AddContentLayout(configuration);
        services.AddSingleton<TorrentEngineService>();
        services.AddSingleton<DownloadRecoveryService>();
        services.AddSingleton<ITorrentEngine>(sp => sp.GetRequiredService<TorrentEngineService>());
        services.AddSingleton<RetentionSweeper>();
        services.AddHostedService<EngineMonitorService>();
        return services;
    }
}
