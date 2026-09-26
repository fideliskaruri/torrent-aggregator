using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Library.Features.Activity;
using TorrentFlow.Library.Features.Automation;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Progress;
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
        services.AddSingleton<AutomationService>();
        services.AddSingleton<TitleService>();
        services.AddSingleton<ILibraryDownloadRecovery, LibraryDownloadRecovery>();
        services.TryAddSingleton<ILibraryPlaybackObserver, DefaultPlaybackObserver>();
        services.TryAddSingleton<ILibraryArtworkResolver, DefaultArtworkResolver>();
        services.TryAddSingleton<ILibraryAnimeLookup, DefaultAnimeLookup>();
        services.AddSingleton<EpisodeSearchIdentity>();
        services.AddSingleton<PlaybackNotifications>();
        services.AddHostedService(sp => sp.GetRequiredService<PlaybackNotifications>());
        services.AddHostedService<AutomationScheduler>();
        return services;
    }
}
