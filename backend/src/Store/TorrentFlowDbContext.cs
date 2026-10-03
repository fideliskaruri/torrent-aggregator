using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

internal sealed class TorrentFlowDbContext(DbContextOptions<TorrentFlowDbContext> options) : DbContext(options)
{
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        foreach (var table in Schema.Tables)
        {
            var entity = modelBuilder.SharedTypeEntity<Dictionary<string, object>>(table.Name);
            entity.ToTable(table.Name);
            foreach (var column in table.Columns)
            {
                var property = entity.IndexerProperty(column.StorageType, column.Name).IsRequired(!column.Nullable);
                if (column.Name is "version" or "revision") property.IsConcurrencyToken();
                var type = Nullable.GetUnderlyingType(column.Property.PropertyType) ?? column.Property.PropertyType;
                string? check = column.Json ? $"json_valid(\"{column.Name}\")"
                    : type.IsEnum ? $"\"{column.Name}\" IN ({string.Join(",", Enum.GetNames(type).Select(n => $"'{n.ToLowerInvariant()}'"))})"
                    : type == typeof(bool) ? $"\"{column.Name}\" IN (0,1)"
                    : type == typeof(int) || type == typeof(long) || type == typeof(double)
                        ? column.Name is "rank" or "priority" ? null : $"\"{column.Name}\" >= 0"
                    : null;
                if (check is not null)
                    entity.ToTable(table.Name, t => t.HasCheckConstraint($"CK_{table.Name}_{column.Name}", check));
            }
            entity.HasKey(table.Key);
            foreach (var index in Schema.Indexes.Where(i => i.Table == table.Name && !i.Expression))
                entity.HasIndex(index.Columns.Split(','), index.Name).IsUnique(index.Unique).HasFilter(index.Filter);
            foreach (var fk in Schema.ForeignKeys.Where(f => f.Table == table.Name))
                entity.HasOne(fk.Principal).WithMany().HasForeignKey(fk.Column)
                    .OnDelete(fk.Cascade ? DeleteBehavior.Cascade : DeleteBehavior.Restrict);
        }
        modelBuilder.SharedTypeEntity<Dictionary<string, object>>("Work")
            .ToTable("Work", t => t.HasCheckConstraint("CK_Work_rating", "rating IS NULL OR rating <= 10"));
        modelBuilder.SharedTypeEntity<Dictionary<string, object>>("WorkLink")
            .ToTable("WorkLink", t => t.HasCheckConstraint("CK_WorkLink_confidence", "confidence <= 1"));
        modelBuilder.SharedTypeEntity<Dictionary<string, object>>("WorkName")
            .ToTable("WorkName", t => t.HasCheckConstraint("CK_WorkName_nonblank", "length(trim(value)) > 0 AND length(trim(normalizedValue)) > 0"));
        modelBuilder.SharedTypeEntity<Dictionary<string, object>>("Release")
            .ToTable("Release", t => t.HasCheckConstraint("CK_Release_hash", "length(hash) IN (40,64) AND hash NOT GLOB '*[^0-9a-f]*'"));
        modelBuilder.SharedTypeEntity<Dictionary<string, object>>("Target")
            .ToTable("Target", t => t.HasCheckConstraint("CK_Target_replacementMode", "(kind='acquire' AND replacementMode IS NULL) OR (kind='replace' AND replacementMode IS NOT NULL)"));
        modelBuilder.SharedTypeEntity<Dictionary<string, object>>("WorkFolder")
            .ToTable("WorkFolder", t => t.HasCheckConstraint("CK_WorkFolder_shape",
                "(rootId IS NOT NULL AND relativeItemFolder IS NOT NULL AND externalItemFolder IS NULL) OR (rootId IS NULL AND relativeItemFolder IS NULL AND externalItemFolder IS NOT NULL)"));
        modelBuilder.SharedTypeEntity<Dictionary<string, object>>("MediaFile")
            .ToTable("MediaFile", t => t.HasCheckConstraint("CK_MediaFile_role", "role IN ('video','subtitle','audio')"));
        modelBuilder.SharedTypeEntity<Dictionary<string, object>>("AutoApproveRule")
            .ToTable("AutoApproveRule", t => t.HasCheckConstraint("CK_AutoApproveRule_email", "length(normalizedEmail) BETWEEN 1 AND 320"));
        modelBuilder.SharedTypeEntity<Dictionary<string, object>>("Notification")
            .ToTable("Notification", t => t.HasCheckConstraint("CK_Notification_length", "length(title) <= 200 AND (body IS NULL OR length(body) <= 500)"));
        modelBuilder.SharedTypeEntity<Dictionary<string, object>>("Setting")
            .ToTable("Setting", t => t.HasCheckConstraint("CK_Setting_section",
                "section IN ('engine','sources','metadata','remoteAccess','desktop','quality','requests','scheduler','jellyfin','migration') AND schemaVersion=1"));
    }
}

internal sealed class StoreDesignFactory : IDesignTimeDbContextFactory<TorrentFlowDbContext>
{
    public TorrentFlowDbContext CreateDbContext(string[] args) =>
        new(new DbContextOptionsBuilder<TorrentFlowDbContext>().UseSqlite("Data Source=:memory:").Options);
}
