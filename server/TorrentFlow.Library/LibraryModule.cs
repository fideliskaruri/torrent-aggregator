using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Library.Features.Activity;
using TorrentFlow.Library.Features.Automation;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Titles;
using TorrentFlow.Library.Features.Storage;

namespace TorrentFlow.Library;

public static class LibraryModule
{
    /// <summary>Registers the Library module's services. Controllers in this assembly are discovered by the API host.</summary>
    public static IServiceCollection AddLibraryModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddSingleton<LibraryExceptionFilter>();
        services.Configure<Microsoft.AspNetCore.Mvc.JsonOptions>(options => options.JsonSerializerOptions.Converters.Add(new LibraryDateConverter()));
        services.AddSingleton<ActivityService>();
        services.AddSingleton<GrabService>();
        services.AddMemoryCache();
        services.AddSingleton<ReleaseSwapService>();
        services.AddSingleton<ReleasePicker>();
        services.AddSingleton<WantedQueue>();
        services.AddHostedService(sp => sp.GetRequiredService<WantedQueue>());
        services.AddSingleton<AutomationService>();
        services.AddOptions<AutomationOptions>().Bind(configuration.GetSection("TorrentFlow:Library"))
            .ValidateDataAnnotations().ValidateOnStart();
        services.AddSingleton<AutomationWake>();
        services.TryAddSingleton<TorrentFlow.Core.Contracts.Metadata.IAirDateLookup, TorrentFlow.Core.Contracts.Metadata.UnknownAirDateLookup>();
        services.AddSingleton<TitleService>();
        services.AddSingleton<WorkNamesRefresh>();
        services.AddHostedService<WorkAnimeBackfill>();
        services.AddHostedService<WorkIdsBackfill>();
        services.AddSingleton<ILibraryDownloadRecovery, LibraryDownloadRecovery>();
        services.TryAddSingleton<ILibraryArtworkResolver, DefaultArtworkResolver>();
        services.TryAddSingleton<ILibraryAnimeLookup, DefaultAnimeLookup>();
        services.TryAddSingleton<ISeasonShapeLookup, DefaultSeasonShapeLookup>();
        services.AddSingleton<EpisodeSearchIdentity>();
        services.AddSingleton<AnimeEpisodeMappings>();
        services.AddSingleton<AnimeNumberingReconciler>();
        services.AddHostedService(sp => sp.GetRequiredService<AnimeNumberingReconciler>());
        services.AddHostedService<AutomationScheduler>();
        services.AddHostedService<Features.Watchlist.DownloadedToLibrary>();
        return services;
    }
}
