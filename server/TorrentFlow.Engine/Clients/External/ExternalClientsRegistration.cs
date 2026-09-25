using Microsoft.Extensions.DependencyInjection;

namespace TorrentFlow.Engine.Clients.External;

public static class ExternalClientsRegistration
{
    public static IServiceCollection AddExternalClients(this IServiceCollection services)
    {
        services.AddHttpClient<QBittorrentClient>(c => c.Timeout = TimeSpan.FromSeconds(15))
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false });
        services.AddHttpClient<TransmissionClient>(c => c.Timeout = TimeSpan.FromSeconds(12))
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false });
        services.AddScoped<ExternalClientRegistry>();
        return services;
    }
}
