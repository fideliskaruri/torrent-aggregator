using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Api.Desktop;

public sealed class DesktopSettingsStore(IDbContextFactory<TorrentFlowDbContext> contexts)
{
    private readonly Lock gate = new();
    private DesktopSettings current = new(false, true, null, null);
    public DesktopSettings Current { get { lock (gate) return current; } }

    public async Task InitializeAsync(CancellationToken ct = default)
    {
        await using var db = await contexts.CreateDbContextAsync(ct);
        var row = await db.Settings.AsNoTracking().SingleAsync(s => s.Id == "desktop", ct);
        lock (gate) current = SettingsCatalog.Read<DesktopSettings>(row);
    }

    public DesktopSettings Update(Func<DesktopSettings, DesktopSettings> change)
    {
        lock (gate)
        {
            using var db = contexts.CreateDbContext();
            var row = db.Settings.Single(s => s.Id == "desktop");
            var next = change(SettingsCatalog.Read<DesktopSettings>(row));
            var replacement = row with { Value = JsonSerializer.SerializeToElement(next, AccessState.Json),
                Revision = row.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
            SettingsCatalog.Validate(replacement);
            db.Entry(row).CurrentValues.SetValues(replacement);
            try { db.SaveChanges(); }
            catch (DbUpdateConcurrencyException) { throw new IOException("Desktop settings changed while saving. Try again."); }
            return current = next;
        }
    }
}
