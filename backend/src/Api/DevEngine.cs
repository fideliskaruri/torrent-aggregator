using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Library;
using TorrentFlow.Store;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class DevEngine
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
        { Converters = { new JsonStringEnumConverter() } };

    internal static IServiceCollection AddDevEngine(this IServiceCollection services, string directory)
    {
        services.AddSingleton(sp => new MonoTorrentEngine(directory,
            message => sp.GetRequiredService<ILogger<MonoTorrentEngine>>().LogInformation("{EngineMessage}", message),
            maximumProbePieceBytes: sp.GetRequiredService<IConfiguration>()
                .GetValue("TorrentFlow:Engine:ProbeMaxPieceBytes", 32 * 1024 * 1024),
            probeDiskBudgetBytes: sp.GetRequiredService<IConfiguration>()
                .GetValue<long>("TorrentFlow:Engine:ProbeDiskBytes", 40L * 1024 * 1024),
            fileState: new FilingFileState(sp.GetRequiredService<IServiceScopeFactory>())));
        services.AddSingleton<IEngine>(sp => sp.GetRequiredService<MonoTorrentEngine>());
        services.AddSingleton<RawDownloads>();
        services.AddHostedService<EngineHost>();
        return services;
    }

    private sealed class FilingFileState(IServiceScopeFactory scopes) : IEngineFileState
    {
        public async Task<ImmutableArray<EngineRecoveryFiles>> ReadAsync(CancellationToken ct)
        {
            await using var scope = scopes.CreateAsyncScope();
            var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
            return await DownloadFiling.RecoveryAsync(repository, ct);
        }
    }

    private sealed class EngineHost(MonoTorrentEngine engine, RawDownloads downloads,
        IDbContextFactory<TorrentFlowDbContext> contexts, IHostEnvironment environment, ILogger<EngineHost> logger) : BackgroundService
    {
        private bool initialized;
        public override async Task StartAsync(CancellationToken ct)
        {
            EngineSettings settings;
            await using (var db = await contexts.CreateDbContextAsync(ct))
                settings = SettingsCatalog.Read<EngineSettings>(await db.Settings.AsNoTracking().SingleAsync(s => s.Id == "engine", ct));
            await engine.InitializeAsync(settings, async (port, token) =>
            {
                for (var attempt = 0; attempt < 3; attempt++)
                {
                    await using var db = await contexts.CreateDbContextAsync(token);
                    var old = await db.Settings.SingleAsync(s => s.Id == "engine", token);
                    var value = SettingsCatalog.Read<EngineSettings>(old) with { ListenPort = port };
                    var next = old with { Value = JsonSerializer.SerializeToElement(value, Json),
                        Revision = old.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
                    SettingsCatalog.Validate(next);
                    db.Entry(old).CurrentValues.SetValues(next);
                    try { await db.SaveChangesAsync(token); return; }
                    catch (DbUpdateConcurrencyException) { }
                }
                throw new InvalidOperationException("Engine listen port settings changed repeatedly. Restart to retry.");
            }, environment.IsDevelopment(), ct);
            await downloads.RecoverAsync(ct);
            initialized = true;
            await base.StartAsync(ct);
        }

        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
            var ticks = 0;
            try
            {
                while (await timer.WaitForNextTickAsync(stoppingToken))
                    try
                    {
                        await downloads.TickAsync(stoppingToken);
                        if (++ticks % 20 == 0) await engine.TickAsync(environment.IsDevelopment(), stoppingToken);
                    }
                    catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
                    { logger.LogError(ex, "Engine tick failed; the next tick will retry."); }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        }

        public override async Task StopAsync(CancellationToken ct)
        {
            await base.StopAsync(ct);
            if (initialized && environment.IsDevelopment()) await engine.SaveDevStateAsync(CancellationToken.None);
            await engine.DisposeAsync();
        }
    }
}
