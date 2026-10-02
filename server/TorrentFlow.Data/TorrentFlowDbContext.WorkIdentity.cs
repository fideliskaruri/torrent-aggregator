using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Data;

/// <summary>Notes a saved change to any work's identity (<see cref="WorkIdentities.Version"/>) for caches that read every work.</summary>
public partial class TorrentFlowDbContext
{
    public override int SaveChanges(bool acceptAllChangesOnSuccess)
    {
        var identity = TouchesWorkIdentity();
        var saved = base.SaveChanges(acceptAllChangesOnSuccess);
        if (identity) WorkIdentities.Changed();
        return saved;
    }

    public override async Task<int> SaveChangesAsync(bool acceptAllChangesOnSuccess, CancellationToken cancellationToken = default)
    {
        var identity = TouchesWorkIdentity();
        var saved = await base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
        if (identity) WorkIdentities.Changed();
        return saved;
    }

    /// <summary>A work added, removed or re-keyed, or its canonical ids (rebuilt from its links) changed.</summary>
    private bool TouchesWorkIdentity() =>
        ChangeTracker.Entries<Work>().Any(e => e.State is EntityState.Added or EntityState.Deleted ||
            e.State == EntityState.Modified && (e.Property(w => w.WorkKey).IsModified || e.Property(w => w.IdsJson).IsModified));
}
