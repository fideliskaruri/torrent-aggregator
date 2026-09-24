using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace TorrentFlow.Data;

public static class DataServiceCollectionExtensions
{
    public static IServiceCollection AddTorrentFlowData(this IServiceCollection services, string connectionString)
    {
        services.AddDbContextFactory<TorrentFlowDbContext>(o => o.UseSqlite(connectionString));
        services.AddScoped(sp => sp.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContext());
        services.AddSingleton<DatabaseInitializer>();
        return services;
    }
}
