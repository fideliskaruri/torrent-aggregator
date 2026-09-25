using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Media.Features.Subtitles;

namespace TorrentFlow.Media;

public static class SubtitlesFeatureRegistration
{
    public static IServiceCollection AddSubtitlesFeature(this IServiceCollection services)
    {
        services.AddScoped(provider => new SubtitlesService(
            provider.GetRequiredService<Core.Contracts.Engine.ITorrentEngine>(),
            provider.GetRequiredService<Data.TorrentFlowDbContext>(),
            provider.GetRequiredService<SubtitleExtraction>()));
        services.AddSingleton<SubtitleExtraction>();
        return services;
    }
}
