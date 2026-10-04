using System.Text.Json;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Api.Desktop;

public sealed class DesktopSettingsStore(IServiceScopeFactory scopes)
{
    private readonly Lock gate = new();
    private DesktopSettings current = new(false, true, null, null);
    public DesktopSettings Current { get { lock (gate) return current; } }

    public async Task InitializeAsync(CancellationToken ct = default)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<IStore>();
        var row = (await store.ReadAsync<SettingRow>(AccessState.Query("desktop"), ct)).Single();
        lock (gate) current = SettingsCatalog.Read<DesktopSettings>(row);
    }

    public DesktopSettings Update(Func<DesktopSettings, DesktopSettings> change)
    {
        lock (gate)
        {
            using var scope = scopes.CreateScope();
            var store = scope.ServiceProvider.GetRequiredService<IStore>();
            var row = store.ReadAsync<SettingRow>(AccessState.Query("desktop"), CancellationToken.None).GetAwaiter().GetResult().Single();
            var next = change(SettingsCatalog.Read<DesktopSettings>(row));
            var replacement = row with { Value = JsonSerializer.SerializeToElement(next, AccessState.Json),
                Revision = row.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
            if (!AccessState.CommitAsync(store, replacement, row.Revision, null, CancellationToken.None).GetAwaiter().GetResult().Applied)
                throw new IOException("Desktop settings changed while saving. Try again.");
            return current = next;
        }
    }
}
