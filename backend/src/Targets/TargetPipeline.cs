using System.Collections.Immutable;
using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

public sealed record AcquireInput(string WorkKey, int? Season = null, int? Episode = null,
    int? Quality = null);
public sealed record TargetActionReply(bool Accepted, int Queued, int Owned,
    ImmutableArray<string> TargetIds, string Message);
public sealed record TargetSnapshot(ImmutableArray<TargetRow> Targets,
    ImmutableArray<DownloadRow> Downloads, ImmutableArray<EngineSnapshot> Live,
    ImmutableArray<AttemptRow> History, ImmutableArray<ScopeIntentRow> Scopes)
{
    public ImmutableArray<EngineQueueOrder> Queue { get; init; } = [];
    public ImmutableArray<RawIntentRow> RawIntents { get; init; } = [];
}

public sealed partial class TargetPipeline(IServiceScopeFactory scopes, DiscoveryPlan discovery,
    IEngine engine, RawDownloads rawDownloads, ILogger<TargetPipeline> logger)
{
    private readonly SemaphoreSlim stateGate = new(1, 1);
    private readonly ConcurrentDictionary<string, Task> flights = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> cancellations = new();
    private readonly TargetTransfers transfers = new(scopes, engine, logger);
    private int maximumScopes = 8;
    private bool schedulerDisabled;

    public static IServiceCollection AddTargets(IServiceCollection services, IConfiguration configuration)
    {
        services.AddSingleton<ProbeRegistry>();
        services.AddHostedService(sp => sp.GetRequiredService<ProbeRegistry>());
        services.AddSingleton<DiscoveryPlan>();
        services.AddSingleton<ExternalIdentity>();
        services.AddSingleton<RawDownloads>();
        services.AddSingleton<TargetPipeline>(sp => new(sp.GetRequiredService<IServiceScopeFactory>(),
            sp.GetRequiredService<DiscoveryPlan>(),             sp.GetRequiredService<IEngine>(),
            sp.GetRequiredService<RawDownloads>(),
            sp.GetRequiredService<ILogger<TargetPipeline>>())
        {
            maximumScopes = Math.Clamp(configuration.GetValue("TorrentFlow:Targets:MaximumScopes", 8), 1, 8),
            schedulerDisabled = configuration.GetValue<bool>("TorrentFlow:Scheduler:Disabled"),
        });
        services.AddHostedService<PipelineWorker>();
        return services;
    }
}
