using System;
using System.Collections.Generic;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Data;

public partial class TorrentFlowDbContext : DbContext
{
    public TorrentFlowDbContext(DbContextOptions<TorrentFlowDbContext> options)
        : base(options)
    {
    }

    public virtual DbSet<AcquisitionTarget> AcquisitionTargets { get; set; }

    public virtual DbSet<AutoRule> AutoRules { get; set; }

    public virtual DbSet<CachedMetadatum> CachedMetadata { get; set; }

    public virtual DbSet<CatalogEntry> CatalogEntries { get; set; }

    public virtual DbSet<ClientSetting> ClientSettings { get; set; }

    public virtual DbSet<DownloadHistory> DownloadHistories { get; set; }

    public virtual DbSet<EngineTorrent> EngineTorrents { get; set; }

    public DbSet<ReleaseAttempt> ReleaseAttempts { get; set; }

    public DbSet<ReleaseBlock> ReleaseBlocks { get; set; }

    public DbSet<EngineDeletion> EngineDeletions { get; set; }

    public virtual DbSet<GrabJob> GrabJobs { get; set; }

    public virtual DbSet<MediaProbe> MediaProbes { get; set; }

    public virtual DbSet<ReleaseHint> ReleaseHints { get; set; }

    public virtual DbSet<MediaRequest> MediaRequests { get; set; }

    public virtual DbSet<RequestAutoApproveRule> RequestAutoApproveRules { get; set; }

    public virtual DbSet<Notification> Notifications { get; set; }

    public virtual DbSet<PushSubscription> PushSubscriptions { get; set; }

    public virtual DbSet<RunLock> RunLocks { get; set; }

    public virtual DbSet<SearchCache> SearchCaches { get; set; }

    public virtual DbSet<User> Users { get; set; }

    public virtual DbSet<WatchListItem> WatchListItems { get; set; }

    public virtual DbSet<Work> Works { get; set; }

    public virtual DbSet<WorkLink> WorkLinks { get; set; }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<ReleaseAttempt>(entity =>
        {
            entity.ToTable("ReleaseAttempt");
            entity.HasKey(e => new { e.UserId, e.WorkKey, e.Scope, e.Hash });
        });

        // No foreign keys: a block outlives the download and the title it was made for.
        modelBuilder.Entity<ReleaseBlock>(entity =>
        {
            entity.ToTable("ReleaseBlock");
            entity.HasKey(e => new { e.UserId, e.Hash });
            entity.HasIndex(e => new { e.UserId, e.WorkKey, e.Scope });
        });

        modelBuilder.Entity<EngineDeletion>(entity =>
        {
            entity.ToTable("EngineDeletion");
            entity.HasKey(e => new { e.UserId, e.Hash });
        });

        modelBuilder.Entity<AcquisitionTarget>(entity =>
        {
            entity.ToTable("AcquisitionTarget");

            entity.HasIndex(e => new { e.UserId, e.InfoHash }, "AcquisitionTarget_userId_infoHash_idx");

            entity.HasIndex(e => new { e.UserId, e.Status }, "AcquisitionTarget_userId_status_idx");

            entity.HasIndex(e => new { e.UserId, e.TargetKey }, "AcquisitionTarget_userId_targetKey_key").IsUnique();

            entity.HasIndex(e => new { e.UserId, e.WorkKey, e.Scope }, "AcquisitionTarget_userId_workKey_scope_idx");

            entity.HasIndex(e => new { e.UserId, e.RunId }, "AcquisitionTarget_userId_runId_idx");

            entity.HasIndex(e => e.WorkId, "AcquisitionTarget_workId_idx");

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.Episode).HasColumnName("episode");
            entity.Property(e => e.Error).HasColumnName("error");
            entity.Property(e => e.FilePath).HasColumnName("filePath");
            entity.Property(e => e.InfoHash).HasColumnName("infoHash");
            entity.Property(e => e.FileIndex).HasColumnName("fileIndex");
            entity.Property(e => e.RealMisses).HasDefaultValue(0).HasColumnName("realMisses");
            entity.Property(e => e.RunId).HasColumnName("runId");
            entity.Property(e => e.ClickedAt).HasColumnName("clickedAt");
            entity.Property(e => e.RunHash).HasColumnName("runHash");
            entity.Property(e => e.PreferredResolution).HasColumnName("preferredResolution");
            entity.Property(e => e.Progress).HasColumnName("progress");
            entity.Property(e => e.Scope).HasColumnName("scope");
            entity.Property(e => e.Season).HasColumnName("season");
            entity.Property(e => e.Status)
                .HasDefaultValue("queued")
                .HasColumnName("status");
            entity.Property(e => e.TargetKey).HasColumnName("targetKey");
            entity.Property(e => e.UpdatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("updatedAt");
            entity.Property(e => e.UserId).HasColumnName("userId");
            entity.Property(e => e.WorkId).HasColumnName("workId");
            entity.Property(e => e.WorkKey).HasColumnName("workKey");

            entity.HasOne(d => d.User).WithMany(p => p.AcquisitionTargets).HasForeignKey(d => d.UserId);

            entity.HasOne(d => d.Work).WithMany(p => p.AcquisitionTargets)
                .HasForeignKey(d => d.WorkId)
                .OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<AutoRule>(entity =>
        {
            entity.ToTable("AutoRule");

            entity.HasIndex(e => new { e.UserId, e.Enabled }, "AutoRule_userId_enabled_idx");

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.Category)
                .HasDefaultValue("all")
                .HasColumnName("category");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.Enabled)
                .IsRequired()
                .HasDefaultValueSql("true")
                .HasColumnType("BOOLEAN")
                .HasColumnName("enabled");
            entity.Property(e => e.LastMatchMagnet).HasColumnName("lastMatchMagnet");
            entity.Property(e => e.LastMatchTitle).HasColumnName("lastMatchTitle");
            entity.Property(e => e.LastRunAt)
                .HasColumnType("DATETIME")
                .HasColumnName("lastRunAt");
            entity.Property(e => e.MatchCount).HasColumnName("matchCount");
            entity.Property(e => e.MaxSizeBytes)
                .HasColumnType("BIGINT")
                .HasColumnName("maxSizeBytes");
            entity.Property(e => e.MinSeeders)
                .HasDefaultValue(10)
                .HasColumnName("minSeeders");
            entity.Property(e => e.Name).HasColumnName("name");
            entity.Property(e => e.Query).HasColumnName("query");
            entity.Property(e => e.Resolution).HasColumnName("resolution");
            entity.Property(e => e.Sources).HasColumnName("sources");
            entity.Property(e => e.UpdatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("updatedAt");
            entity.Property(e => e.UserId).HasColumnName("userId");

            entity.HasOne(d => d.User).WithMany(p => p.AutoRules).HasForeignKey(d => d.UserId);
        });

        modelBuilder.Entity<CachedMetadatum>(entity =>
        {
            entity.HasIndex(e => e.CacheKey, "CachedMetadata_cacheKey_key").IsUnique();

            entity.HasIndex(e => e.ExpiresAt, "CachedMetadata_expiresAt_idx");

            entity.HasIndex(e => new { e.Source, e.ExternalId }, "CachedMetadata_source_externalId_idx");

            entity.HasIndex(e => e.UpdatedAt, "CachedMetadata_updatedAt_idx");

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.BackdropUrl).HasColumnName("backdropUrl");
            entity.Property(e => e.CacheKey).HasColumnName("cacheKey");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.ExpiresAt)
                .HasColumnType("DATETIME")
                .HasColumnName("expiresAt");
            entity.Property(e => e.ExternalId).HasColumnName("externalId");
            entity.Property(e => e.Genres).HasColumnName("genres");
            entity.Property(e => e.MediaType).HasColumnName("mediaType");
            entity.Property(e => e.PosterUrl).HasColumnName("posterUrl");
            entity.Property(e => e.Rating).HasColumnName("rating");
            entity.Property(e => e.RawJson).HasColumnName("rawJson");
            entity.Property(e => e.ReleaseDate)
                .HasColumnType("DATETIME")
                .HasColumnName("releaseDate");
            entity.Property(e => e.Source).HasColumnName("source");
            entity.Property(e => e.Synopsis).HasColumnName("synopsis");
            entity.Property(e => e.Title).HasColumnName("title");
            entity.Property(e => e.UpdatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("updatedAt");
            entity.Property(e => e.Year).HasColumnName("year");
        });

        modelBuilder.Entity<CatalogEntry>(entity =>
        {
            entity.ToTable("CatalogEntry");

            entity.HasIndex(e => e.RefreshedAt, "CatalogEntry_refreshedAt_idx");

            entity.HasIndex(e => new { e.Source, e.Rank }, "CatalogEntry_source_rank_idx");

            entity.HasIndex(e => new { e.Source, e.SeedTitle, e.Rank, e.Title }, "CatalogEntry_source_seedTitle_rank_title_idx");

            entity.HasIndex(e => e.WorkId, "CatalogEntry_workId_idx");

            entity.HasIndex(e => new { e.WorkKey, e.Source, e.SeedTitle }, "CatalogEntry_workKey_source_seedTitle_key").IsUnique();

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.BackdropUrl).HasColumnName("backdropUrl");
            entity.Property(e => e.BestRelease).HasColumnName("bestRelease");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.MediaType).HasColumnName("mediaType");
            entity.Property(e => e.Overview).HasColumnName("overview");
            entity.Property(e => e.PosterUrl).HasColumnName("posterUrl");
            entity.Property(e => e.Provider).HasColumnName("provider");
            entity.Property(e => e.ProviderId).HasColumnName("providerId");
            entity.Property(e => e.Rank).HasColumnName("rank");
            entity.Property(e => e.Rating).HasColumnName("rating");
            entity.Property(e => e.RatingSource).HasColumnName("ratingSource");
            entity.Property(e => e.RefreshedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("refreshedAt");
            entity.Property(e => e.ReleaseDate)
                .HasColumnType("DATETIME")
                .HasColumnName("releaseDate");
            entity.Property(e => e.SeedTitle).HasColumnName("seedTitle");
            entity.Property(e => e.Seeders).HasColumnName("seeders");
            entity.Property(e => e.Source).HasColumnName("source");
            entity.Property(e => e.Title).HasColumnName("title");
            entity.Property(e => e.WorkId).HasColumnName("workId");
            entity.Property(e => e.WorkKey).HasColumnName("workKey");
            entity.Property(e => e.Year).HasColumnName("year");

            entity.HasOne(d => d.Work).WithMany(p => p.CatalogEntries)
                .HasForeignKey(d => d.WorkId)
                .OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<ClientSetting>(entity =>
        {
            entity.HasIndex(e => e.UserId, "ClientSettings_userId_key").IsUnique();

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.AutomationIntervalMinutes).HasColumnName("automationIntervalMinutes");
            entity.Property(e => e.BaseDownloadPath).HasColumnName("baseDownloadPath");
            entity.Property(e => e.MaxActiveDownloads).HasColumnName("maxActiveDownloads");
            entity.Property(e => e.DownloadWindows).HasColumnName("downloadWindows");
            entity.Property(e => e.Categories).HasColumnName("categories");
            entity.Property(e => e.Category).HasColumnName("category");
            entity.Property(e => e.ClientType)
                .HasDefaultValue("builtin")
                .HasColumnName("clientType");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.DefaultRetentionPolicy)
                .HasDefaultValue("EPHEMERAL")
                .HasColumnName("defaultRetentionPolicy");
            entity.Property(e => e.ExternalClientType).HasColumnName("externalClientType");
            entity.Property(e => e.Host)
                .HasDefaultValue("http://127.0.0.1:8080")
                .HasColumnName("host");
            entity.Property(e => e.MaxStorageBytes)
                .HasColumnType("BIGINT")
                .HasColumnName("maxStorageBytes");
            entity.Property(e => e.Password).HasColumnName("password");
            entity.Property(e => e.PathRules).HasColumnName("pathRules");
            entity.Property(e => e.PreProbeScope).HasColumnName("preProbeScope");
            entity.Property(e => e.PreferredResolution).HasColumnName("preferredResolution");
            entity.Property(e => e.SavePath).HasColumnName("savePath");
            entity.Property(e => e.StorageCapConfigured)
                .HasColumnType("BOOLEAN")
                .HasColumnName("storageCapConfigured");
            entity.Property(e => e.UpdatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("updatedAt");
            entity.Property(e => e.UserId).HasColumnName("userId");
            entity.Property(e => e.Username).HasColumnName("username");
            entity.Property(e => e.VerboseDiagnostics)
                .HasColumnType("BOOLEAN")
                .HasColumnName("verboseDiagnostics");
            entity.Property(e => e.AudioLanguage).HasColumnName("audioLanguage");

            entity.HasOne(d => d.User).WithOne(p => p.ClientSetting).HasForeignKey<ClientSetting>(d => d.UserId);
        });

        modelBuilder.Entity<DownloadHistory>(entity =>
        {
            entity.ToTable("DownloadHistory");

            entity.HasIndex(e => new { e.UserId, e.CreatedAt }, "DownloadHistory_userId_createdAt_idx");

            entity.HasIndex(e => new { e.UserId, e.Status }, "DownloadHistory_userId_status_idx");

            entity.HasIndex(e => e.WorkId, "DownloadHistory_workId_idx");

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.Category).HasColumnName("category");
            entity.Property(e => e.ClientType).HasColumnName("clientType");
            entity.Property(e => e.Context).HasColumnName("context");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.InfoHash).HasColumnName("infoHash");
            entity.Property(e => e.Magnet).HasColumnName("magnet");
            entity.Property(e => e.Message).HasColumnName("message");
            entity.Property(e => e.Retention).HasColumnName("retention");
            entity.Property(e => e.SavePath).HasColumnName("savePath");
            entity.Property(e => e.SendKind).HasColumnName("sendKind");
            entity.Property(e => e.Source).HasColumnName("source");
            entity.Property(e => e.Status).HasColumnName("status");
            entity.Property(e => e.Title).HasColumnName("title");
            entity.Property(e => e.TorrentUrl).HasColumnName("torrentUrl");
            entity.Property(e => e.UserId).HasColumnName("userId");
            entity.Property(e => e.WorkId).HasColumnName("workId");

            entity.HasOne(d => d.User).WithMany(p => p.DownloadHistories).HasForeignKey(d => d.UserId);

            entity.HasOne(d => d.Work).WithMany(p => p.DownloadHistories)
                .HasForeignKey(d => d.WorkId)
                .OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<EngineTorrent>(entity =>
        {
            entity.ToTable("EngineTorrent");

            entity.HasIndex(e => new { e.UserId, e.Hash }, "EngineTorrent_userId_hash_key").IsUnique();

            entity.HasIndex(e => new { e.UserId, e.Origin, e.LastUsedAt }, "EngineTorrent_userId_origin_lastUsedAt_idx");

            entity.HasIndex(e => new { e.UserId, e.Status }, "EngineTorrent_userId_status_idx");

            entity.HasIndex(e => e.WorkId, "EngineTorrent_workId_idx");

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.Category).HasColumnName("category");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.Error).HasColumnName("error");
            entity.Property(e => e.EvictFrom).HasColumnName("evictFrom");
            entity.Property(e => e.EvictLease).HasColumnName("evictLease");
            entity.Property(e => e.ForcedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("forcedAt");
            entity.Property(e => e.ForcedReason).HasColumnName("forcedReason");
            entity.Property(e => e.LibraryCheckedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("libraryCheckedAt");
            entity.Property(e => e.Hash).HasColumnName("hash");
            entity.Property(e => e.LastUsedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("lastUsedAt");
            entity.Property(e => e.Magnet).HasColumnName("magnet");
            entity.Property(e => e.Name).HasColumnName("name");
            entity.Property(e => e.Origin)
                .HasDefaultValue("user")
                .HasColumnName("origin");
            entity.Property(e => e.Progress).HasColumnName("progress");
            entity.Property(e => e.QueueKey).HasColumnName("queueKey");
            entity.Property(e => e.Lane).HasColumnName("lane");
            entity.Property(e => e.SelectedFilesJson).HasColumnName("selectedFilesJson");
            entity.Property(e => e.LanguageCheckJson).HasColumnName("languageCheckJson");
            entity.Property(e => e.StagePath).HasColumnName("stagePath");
            entity.Property(e => e.Promotion).HasColumnName("promotion");
            entity.Property(e => e.PromotionReason).HasColumnName("promotionReason");
            entity.Property(e => e.Provenance).HasColumnName("provenance");
            entity.Property(e => e.Legacy).HasColumnName("legacy");
            entity.Property(e => e.SavePath).HasColumnName("savePath");
            entity.Property(e => e.SizeBytes)
                .HasColumnType("BIGINT")
                .HasColumnName("sizeBytes");
            entity.Property(e => e.Status)
                .HasDefaultValue("downloading")
                .HasColumnName("status");
            entity.Property(e => e.TorrentUrl).HasColumnName("torrentUrl");
            entity.Property(e => e.UpdatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("updatedAt");
            entity.Property(e => e.UserId).HasColumnName("userId");
            entity.Property(e => e.VerifiedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("verifiedAt");
            entity.Property(e => e.VerifiedBitfield).HasColumnName("verifiedBitfield");
            entity.Property(e => e.VerifiedFilesJson).HasColumnName("verifiedFilesJson");
            entity.Property(e => e.WorkId).HasColumnName("workId");

            entity.HasOne(d => d.User).WithMany(p => p.EngineTorrents).HasForeignKey(d => d.UserId);

            entity.HasOne(d => d.Work).WithMany(p => p.EngineTorrents)
                .HasForeignKey(d => d.WorkId)
                .OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<GrabJob>(entity =>
        {
            entity.ToTable("GrabJob");

            entity.HasIndex(e => new { e.UserId, e.CreatedAt }, "GrabJob_userId_createdAt_idx");

            entity.HasIndex(e => new { e.UserId, e.Status }, "GrabJob_userId_status_idx");

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.Category).HasColumnName("category");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.ExternalId).HasColumnName("externalId");
            entity.Property(e => e.InfoHash).HasColumnName("infoHash");
            entity.Property(e => e.Kind).HasColumnName("kind");
            entity.Property(e => e.Magnet).HasColumnName("magnet");
            entity.Property(e => e.Message).HasColumnName("message");
            entity.Property(e => e.Query).HasColumnName("query");
            entity.Property(e => e.Retention).HasColumnName("retention");
            entity.Property(e => e.Rung).HasColumnName("rung");
            entity.Property(e => e.Language).HasColumnName("language");
            entity.Property(e => e.SavePath).HasColumnName("savePath");
            entity.Property(e => e.Source).HasColumnName("source");
            entity.Property(e => e.Status).HasColumnName("status");
            entity.Property(e => e.Title).HasColumnName("title");
            entity.Property(e => e.UpdatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("updatedAt");
            entity.Property(e => e.UserId).HasColumnName("userId");

            entity.HasOne(d => d.User).WithMany(p => p.GrabJobs).HasForeignKey(d => d.UserId);
        });

        modelBuilder.Entity<ReleaseHint>(entity =>
        {
            entity.ToTable("ReleaseHint");

            entity.HasIndex(e => new { e.Source, e.Key }, "ReleaseHint_source_key_key").IsUnique();

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.Source).HasColumnName("source");
            entity.Property(e => e.Key).HasColumnName("key");
            entity.Property(e => e.State).HasColumnName("state");
            entity.Property(e => e.FilesJson).HasColumnName("filesJson");
            entity.Property(e => e.Attempts).HasColumnName("attempts");
            entity.Property(e => e.FetchedAt).HasColumnType("DATETIME").HasColumnName("fetchedAt");
            entity.Property(e => e.RetryAt).HasColumnType("DATETIME").HasColumnName("retryAt");
            entity.Property(e => e.Host).HasColumnName("host");
        });

        modelBuilder.Entity<MediaProbe>(entity =>
        {
            entity.ToTable("MediaProbe");

            entity.HasIndex(e => new { e.InfoHash, e.FilePath }, "MediaProbe_infoHash_filePath_key").IsUnique();

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.AudioChannels).HasColumnName("audioChannels");
            entity.Property(e => e.AudioCodec).HasColumnName("audioCodec");
            entity.Property(e => e.AudioLayout).HasColumnName("audioLayout");
            entity.Property(e => e.BitRateBps).HasColumnName("bitRateBps");
            entity.Property(e => e.ColorTransfer).HasColumnName("colorTransfer");
            entity.Property(e => e.Container).HasColumnName("container");
            entity.Property(e => e.DurationSec).HasColumnName("durationSec");
            entity.Property(e => e.FilePath).HasColumnName("filePath");
            entity.Property(e => e.Height).HasColumnName("height");
            entity.Property(e => e.InfoHash).HasColumnName("infoHash");
            entity.Property(e => e.ProbeVersion).HasColumnName("probeVersion");
            entity.Property(e => e.ProbedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("probedAt");
            entity.Property(e => e.StreamsJson).HasColumnName("streamsJson");
            entity.Property(e => e.UpdatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("updatedAt");
            entity.Property(e => e.VideoCodec).HasColumnName("videoCodec");
            entity.Property(e => e.VideoProfile).HasColumnName("videoProfile");
            entity.Property(e => e.Width).HasColumnName("width");
        });

        modelBuilder.Entity<RunLock>(entity =>
        {
            entity.ToTable("RunLock");

            entity.HasIndex(e => e.AcquiredAt, "RunLock_acquiredAt_idx");

            entity.HasIndex(e => new { e.UserId, e.Scope }, "RunLock_userId_scope_key").IsUnique();

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.AcquiredAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("acquiredAt");
            entity.Property(e => e.Scope).HasColumnName("scope");
            entity.Property(e => e.UserId).HasColumnName("userId");
        });

        modelBuilder.Entity<SearchCache>(entity =>
        {
            entity.ToTable("SearchCache");

            entity.HasIndex(e => e.CacheKey, "SearchCache_cacheKey_key").IsUnique();

            entity.HasIndex(e => e.ExpiresAt, "SearchCache_expiresAt_idx");

            entity.HasIndex(e => new { e.NormalizedQuery, e.ExpiresAt }, "SearchCache_normalizedQuery_expiresAt_idx");

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CacheKey).HasColumnName("cacheKey");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.ExpiresAt)
                .HasColumnType("DATETIME")
                .HasColumnName("expiresAt");
            entity.Property(e => e.NormalizedQuery).HasColumnName("normalizedQuery");
            entity.Property(e => e.Payload).HasColumnName("payload");
        });

        modelBuilder.Entity<MediaRequest>(entity =>
        {
            entity.ToTable("MediaRequest");

            entity.HasIndex(e => new { e.RequestedByUserId, e.Status }, "MediaRequest_requestedByUserId_status_idx");

            entity.HasIndex(e => new { e.Status, e.CreatedAt }, "MediaRequest_status_createdAt_idx");

            entity.HasIndex(e => e.WorkKey, "MediaRequest_workKey_idx");

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.RequestedByUserId).HasColumnName("requestedByUserId");
            entity.Property(e => e.Provider).HasColumnName("provider");
            entity.Property(e => e.ProviderId).HasColumnName("providerId");
            entity.Property(e => e.WorkKey).HasColumnName("workKey");
            entity.Property(e => e.MediaType).HasColumnName("mediaType");
            entity.Property(e => e.Title).HasColumnName("title");
            entity.Property(e => e.Year).HasColumnName("year");
            entity.Property(e => e.PosterUrl).HasColumnName("posterUrl");
            entity.Property(e => e.Scope).HasColumnName("scope");
            entity.Property(e => e.Seasons).HasColumnName("seasons");
            entity.Property(e => e.Note).HasColumnName("note");
            entity.Property(e => e.Status)
                .HasDefaultValue("pending")
                .HasColumnName("status");
            entity.Property(e => e.DecisionReason).HasColumnName("decisionReason");
            entity.Property(e => e.DecidedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("decidedAt");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.UpdatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("updatedAt");
            entity.Property(e => e.WatchListItemId).HasColumnName("watchListItemId");
            entity.Property(e => e.AcquisitionTargetId).HasColumnName("acquisitionTargetId");
            entity.Property(e => e.GrabbedHashes).HasColumnName("grabbedHashes");

            entity.HasOne(d => d.RequestedBy).WithMany(p => p.MediaRequests)
                .HasForeignKey(d => d.RequestedByUserId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne<WatchListItem>().WithMany()
                .HasForeignKey(d => d.WatchListItemId)
                .OnDelete(DeleteBehavior.SetNull);

            entity.HasOne<AcquisitionTarget>().WithMany()
                .HasForeignKey(d => d.AcquisitionTargetId)
                .OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<RequestAutoApproveRule>(entity =>
        {
            entity.ToTable("RequestAutoApproveRule");

            entity.HasIndex(e => e.Email, "RequestAutoApproveRule_email_key").IsUnique();

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.Email).HasColumnName("email");
            entity.Property(e => e.Mode).HasColumnName("mode");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.UpdatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("updatedAt");
        });

        modelBuilder.Entity<Notification>(entity =>
        {
            entity.ToTable("Notification");

            entity.HasIndex(e => new { e.RecipientUserId, e.CreatedAt }, "Notification_recipientUserId_createdAt_idx");

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.RecipientUserId).HasColumnName("recipientUserId");
            entity.Property(e => e.Kind).HasColumnName("kind");
            entity.Property(e => e.Title).HasColumnName("title");
            entity.Property(e => e.Body).HasColumnName("body");
            entity.Property(e => e.Link).HasColumnName("link");
            entity.Property(e => e.CreatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.ReadAt)
                .HasColumnType("DATETIME")
                .HasColumnName("readAt");
        });

        modelBuilder.Entity<PushSubscription>(entity =>
        {
            entity.ToTable("PushSubscription");

            entity.HasIndex(e => e.Endpoint, "PushSubscription_endpoint_key").IsUnique();

            entity.HasIndex(e => e.UserId, "PushSubscription_userId_idx");

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.UserId).HasColumnName("userId");
            entity.Property(e => e.Endpoint).HasColumnName("endpoint");
            entity.Property(e => e.P256dh).HasColumnName("p256dh");
            entity.Property(e => e.Auth).HasColumnName("auth");
            entity.Property(e => e.CreatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
        });

        modelBuilder.Entity<User>(entity =>
        {
            entity.ToTable("User");

            entity.HasIndex(e => e.Email, "User_email_key").IsUnique();

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.Email).HasColumnName("email");
            entity.Property(e => e.Image).HasColumnName("image");
            entity.Property(e => e.Name).HasColumnName("name");
            entity.Property(e => e.UpdatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("updatedAt");
        });

        modelBuilder.Entity<WatchListItem>(entity =>
        {
            entity.ToTable("WatchListItem");

            entity.HasIndex(e => e.UserId, "WatchListItem_userId_idx");

            entity.HasIndex(e => new { e.UserId, e.MediaType, e.ExternalId }, "WatchListItem_userId_mediaType_externalId_key").IsUnique();

            entity.HasIndex(e => e.WorkId, "WatchListItem_workId_idx");

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.CursorEpisode).HasColumnName("cursorEpisode");
            entity.Property(e => e.CursorMisses).HasColumnName("cursorMisses");
            entity.Property(e => e.CursorSeason).HasColumnName("cursorSeason");
            entity.Property(e => e.ExternalId).HasColumnName("externalId");
            entity.Property(e => e.FromEpisode)
                .HasDefaultValue(1)
                .HasColumnName("fromEpisode");
            entity.Property(e => e.FromSeason).HasColumnName("fromSeason");
            entity.Property(e => e.LastChecked)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("lastChecked");
            entity.Property(e => e.LastEpisode).HasColumnName("lastEpisode");
            entity.Property(e => e.NextCheckAt).HasColumnType("DATETIME").HasColumnName("nextCheckAt");
            entity.Property(e => e.NextCheckReason).HasColumnName("nextCheckReason");
            entity.HasIndex(e => new { e.UserId, e.NextCheckAt }, "WatchListItem_userId_nextCheckAt_idx");
            entity.Property(e => e.LatestReleaseAt)
                .HasColumnType("DATETIME")
                .HasColumnName("latestReleaseAt");
            entity.Property(e => e.LatestReleaseMagnet).HasColumnName("latestReleaseMagnet");
            entity.Property(e => e.LatestReleaseTitle).HasColumnName("latestReleaseTitle");
            entity.Property(e => e.MediaType).HasColumnName("mediaType");
            entity.Property(e => e.MonitorMode)
                .HasDefaultValue("ongoing")
                .HasColumnName("monitorMode");
            entity.Property(e => e.NewEpisodesSince).HasColumnType("DATETIME").HasColumnName("newEpisodesSince");
            entity.Property(e => e.Monitored)
                .IsRequired()
                .HasDefaultValueSql("true")
                .HasColumnType("BOOLEAN")
                .HasColumnName("monitored");
            entity.Property(e => e.NextEpisodeHint).HasColumnName("nextEpisodeHint");
            entity.Property(e => e.PosterUrl).HasColumnName("posterUrl");
            entity.Property(e => e.PreferredResolution).HasColumnName("preferredResolution");
            entity.Property(e => e.Rating).HasColumnName("rating");
            entity.Property(e => e.SeederWaitSince)
                .HasColumnType("DATETIME")
                .HasColumnName("seederWaitSince");
            entity.Property(e => e.Status)
                .HasDefaultValue("watching")
                .HasColumnName("status");
            entity.Property(e => e.Synopsis).HasColumnName("synopsis");
            entity.Property(e => e.Title).HasColumnName("title");
            entity.Property(e => e.UpdatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("updatedAt");
            entity.Property(e => e.UserId).HasColumnName("userId");
            entity.Property(e => e.WorkId).HasColumnName("workId");

            entity.HasOne(d => d.User).WithMany(p => p.WatchListItems).HasForeignKey(d => d.UserId);

            entity.HasOne(d => d.Work).WithMany(p => p.WatchListItems)
                .HasForeignKey(d => d.WorkId)
                .OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<Work>(entity =>
        {
            entity.ToTable("Work");

            entity.HasIndex(e => e.MediaType, "Work_mediaType_idx");

            entity.HasIndex(e => new { e.Provider, e.ProviderId, e.MediaType }, "Work_provider_providerId_mediaType_key").IsUnique();

            entity.HasIndex(e => e.WorkKey, "Work_workKey_key").IsUnique();

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.AliasesJson).HasColumnName("aliasesJson");
            entity.Property(e => e.NamesJson).HasColumnName("namesJson");
            entity.Property(e => e.IdsJson).HasColumnName("idsJson");
            entity.Property(e => e.Format).HasColumnName("format").HasConversion<string>();
            entity.Property(e => e.OriginalLanguage).HasColumnName("originalLanguage");
            entity.Property(e => e.NamesRefreshedAt).HasColumnName("namesRefreshedAt");
            entity.Property(e => e.LinksVersion).HasColumnName("linksVersion");
            entity.Property(e => e.CanonicalTitle).HasColumnName("canonicalTitle");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.MediaType).HasColumnName("mediaType");
            entity.Property(e => e.PosterUrl).HasColumnName("posterUrl");
            entity.Property(e => e.Provider).HasColumnName("provider");
            entity.Property(e => e.ProviderId).HasColumnName("providerId");
            entity.Property(e => e.UpdatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("updatedAt");
            entity.Property(e => e.WorkKey).HasColumnName("workKey");
            entity.Property(e => e.Year).HasColumnName("year");
        });

        modelBuilder.Entity<WorkLink>(entity =>
        {
            entity.ToTable("WorkLink");

            entity.HasIndex(e => new { e.WorkId, e.Provider, e.ExternalId }, "WorkLink_workId_provider_externalId_key").IsUnique();

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.WorkId).HasColumnName("workId");
            entity.Property(e => e.Provider).HasColumnName("provider");
            entity.Property(e => e.ExternalId).HasColumnName("externalId");
            entity.Property(e => e.MediaType).HasColumnName("mediaType");
            entity.Property(e => e.Season).HasColumnName("season");
            entity.Property(e => e.Source).HasColumnName("source");
            entity.Property(e => e.MappingVersion).HasColumnName("mappingVersion");
            entity.Property(e => e.Confidence).HasColumnName("confidence");
            entity.Property(e => e.Verified).HasColumnName("verified");
            entity.Property(e => e.Rejected).HasColumnName("rejected");
            entity.Property(e => e.NamesJson).HasColumnName("namesJson");
            entity.Property(e => e.CreatedAt).HasColumnType("DATETIME").HasColumnName("createdAt");
            entity.Property(e => e.UpdatedAt).HasColumnType("DATETIME").HasColumnName("updatedAt");

            entity.HasOne(d => d.Work).WithMany(p => p.Links).HasForeignKey(d => d.WorkId).OnDelete(DeleteBehavior.Cascade);
        });

        OnModelCreatingPartial(modelBuilder);
    }

    partial void OnModelCreatingPartial(ModelBuilder modelBuilder);
}
