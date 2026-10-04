using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;

namespace TorrentFlow.Requests;

public static class Module
{
    public static IServiceCollection AddRequests(this IServiceCollection services)
    {
        services.AddScoped<RequestService>();
        services.AddSingleton<AutomationRepository>();
        services.AddSingleton<Hunter>();
        services.AddHostedService<RequestReconciler>();
        services.AddHostedService<HunterScheduler>();
        services.AddHostedService<NotificationWorker>();
        return services;
    }
}
