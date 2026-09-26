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

    public virtual DbSet<GrabJob> GrabJobs { get; set; }

    public virtual DbSet<MediaProbe> MediaProbes { get; set; }

    public virtual DbSet<MediaRequest> MediaRequests { get; set; }

    public virtual DbSet<PlaybackProgress> PlaybackProgresses { get; set; }

    public virtual DbSet<RunLock> RunLocks { get; set; }

    public virtual DbSet<SearchCache> SearchCaches { get; set; }

    public virtual DbSet<SwarmMeasurement> SwarmMeasurements { get; set; }

    public virtual DbSet<User> Users { get; set; }

    public virtual DbSet<WatchListItem> WatchListItems { get; set; }

    public virtual DbSet<Work> Works { get; set; }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<AcquisitionTarget>(entity =>
        {
            entity.ToTable("AcquisitionTarget");

            entity.HasIndex(e => new { e.UserId, e.InfoHash }, "AcquisitionTarget_userId_infoHash_idx");

            entity.HasIndex(e => new { e.UserId, e.Status }, "AcquisitionTarget_userId_status_idx");

            entity.HasIndex(e => new { e.UserId, e.TargetKey }, "AcquisitionTarget_userId_targetKey_key").IsUnique();

            entity.HasIndex(e => new { e.UserId, e.WorkKey, e.Scope }, "AcquisitionTarget_userId_workKey_scope_idx");

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
            entity.Property(e => e.Rank).HasColumnName("rank");
            entity.Property(e => e.Rating).HasColumnName("rating");
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

        modelBuilder.Entity<PlaybackProgress>(entity =>
        {
            entity.ToTable("PlaybackProgress");

            entity.HasIndex(e => new { e.UserId, e.CompletedAt }, "PlaybackProgress_userId_completedAt_idx");

            entity.HasIndex(e => new { e.UserId, e.InfoHash, e.FilePath }, "PlaybackProgress_userId_infoHash_filePath_key").IsUnique();

            entity.HasIndex(e => new { e.UserId, e.UpdatedAt }, "PlaybackProgress_userId_updatedAt_idx");

            entity.HasIndex(e => e.WorkId, "PlaybackProgress_workId_idx");

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.CompletedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("completedAt");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.DurationSec).HasColumnName("durationSec");
            entity.Property(e => e.Episode).HasColumnName("episode");
            entity.Property(e => e.FilePath).HasColumnName("filePath");
            entity.Property(e => e.InfoHash).HasColumnName("infoHash");
            entity.Property(e => e.PositionSec).HasColumnName("positionSec");
            entity.Property(e => e.PosterUrl).HasColumnName("posterUrl");
            entity.Property(e => e.Season).HasColumnName("season");
            entity.Property(e => e.Title).HasColumnName("title");
            entity.Property(e => e.UpdatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("updatedAt");
            entity.Property(e => e.UserId).HasColumnName("userId");
            entity.Property(e => e.WatchListItemId).HasColumnName("watchListItemId");
            entity.Property(e => e.WorkId).HasColumnName("workId");

            entity.HasOne(d => d.User).WithMany(p => p.PlaybackProgresses).HasForeignKey(d => d.UserId);

            entity.HasOne(d => d.Work).WithMany(p => p.PlaybackProgresses)
                .HasForeignKey(d => d.WorkId)
                .OnDelete(DeleteBehavior.SetNull);
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

        modelBuilder.Entity<SwarmMeasurement>(entity =>
        {
            entity.ToTable("SwarmMeasurement");

            entity.HasIndex(e => e.ExpiresAt, "SwarmMeasurement_expiresAt_idx");

            entity.HasIndex(e => e.InfoHash, "SwarmMeasurement_infoHash_key").IsUnique();

            entity.Property(e => e.Id).HasColumnName("id");
            entity.Property(e => e.BytesReceived)
                .HasColumnType("BIGINT")
                .HasColumnName("bytesReceived");
            entity.Property(e => e.CreatedAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("createdAt");
            entity.Property(e => e.EffectiveBps).HasColumnName("effectiveBps");
            entity.Property(e => e.ElapsedMs).HasColumnName("elapsedMs");
            entity.Property(e => e.ExpiresAt)
                .HasColumnType("DATETIME")
                .HasColumnName("expiresAt");
            entity.Property(e => e.InfoHash).HasColumnName("infoHash");
            entity.Property(e => e.MeasuredAt)
                .HasDefaultValueSql("CURRENT_TIMESTAMP")
                .HasColumnType("DATETIME")
                .HasColumnName("measuredAt");
            entity.Property(e => e.Name).HasColumnName("name");
            entity.Property(e => e.PeersConnected).HasColumnName("peersConnected");
            entity.Property(e => e.PeersUnchoked).HasColumnName("peersUnchoked");
            entity.Property(e => e.RequiredBps).HasColumnName("requiredBps");
            entity.Property(e => e.UpdatedAt)
                .HasColumnType("DATETIME")
                .HasColumnName("updatedAt");
            entity.Property(e => e.Verdict).HasColumnName("verdict");
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
            entity.Property(e => e.LatestReleaseAt)
                .HasColumnType("DATETIME")
                .HasColumnName("latestReleaseAt");
            entity.Property(e => e.LatestReleaseMagnet).HasColumnName("latestReleaseMagnet");
            entity.Property(e => e.LatestReleaseTitle).HasColumnName("latestReleaseTitle");
            entity.Property(e => e.MediaType).HasColumnName("mediaType");
            entity.Property(e => e.MonitorMode)
                .HasDefaultValue("ongoing")
                .HasColumnName("monitorMode");
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

        OnModelCreatingPartial(modelBuilder);
    }

    partial void OnModelCreatingPartial(ModelBuilder modelBuilder);
}
