using System.Globalization;
using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

public sealed class TorrentFlowDbContext(DbContextOptions<TorrentFlowDbContext> options) : DbContext(options)
{
    public DbSet<WorkRow> Works => Set<WorkRow>();
    public DbSet<WorkNameRow> WorkNames => Set<WorkNameRow>();
    public DbSet<WorkLinkRow> WorkLinks => Set<WorkLinkRow>();
    public DbSet<SeasonRow> Seasons => Set<SeasonRow>();
    public DbSet<EpisodeRow> Episodes => Set<EpisodeRow>();
    public DbSet<MetadataCacheRow> MetadataCaches => Set<MetadataCacheRow>();
    public DbSet<WorkPreferenceRow> WorkPreferences => Set<WorkPreferenceRow>();
    public DbSet<TargetRow> Targets => Set<TargetRow>();
    public DbSet<ScopeIntentRow> ScopeIntents => Set<ScopeIntentRow>();
    public DbSet<RawIntentRow> RawIntents => Set<RawIntentRow>();
    public DbSet<RequestRow> Requests => Set<RequestRow>();
    public DbSet<RequestItemRow> RequestItems => Set<RequestItemRow>();
    public DbSet<FollowRow> Follows => Set<FollowRow>();
    public DbSet<WatchItemRow> WatchItems => Set<WatchItemRow>();
    public DbSet<AutoRuleRow> AutoRules => Set<AutoRuleRow>();
    public DbSet<ReleaseRow> Releases => Set<ReleaseRow>();
    public DbSet<ReleaseObservationRow> ReleaseObservations => Set<ReleaseObservationRow>();
    public DbSet<VerdictRow> Verdicts => Set<VerdictRow>();
    public DbSet<AttemptRow> Attempts => Set<AttemptRow>();
    public DbSet<BlockRow> Blocks => Set<BlockRow>();
    public DbSet<SearchCacheRow> SearchCaches => Set<SearchCacheRow>();
    public DbSet<DownloadRow> Downloads => Set<DownloadRow>();
    public DbSet<DownloadTargetRow> DownloadTargets => Set<DownloadTargetRow>();
    public DbSet<DownloadFileRow> DownloadFiles => Set<DownloadFileRow>();
    public DbSet<StorageRootRow> StorageRoots => Set<StorageRootRow>();
    public DbSet<WorkFolderRow> WorkFolders => Set<WorkFolderRow>();
    public DbSet<MediaFileRow> MediaFiles => Set<MediaFileRow>();
    public DbSet<FileOperationRow> FileOperations => Set<FileOperationRow>();
    public DbSet<FilePathClaimRow> FilePathClaims => Set<FilePathClaimRow>();
    public DbSet<UserRow> Users => Set<UserRow>();
    public DbSet<NotificationRow> Notifications => Set<NotificationRow>();
    public DbSet<SettingRow> Settings => Set<SettingRow>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Ignore<StoreRow>();
        modelBuilder.Entity<WorkRow>().ToTable("Work", table =>
        {
            table.HasCheckConstraint("CK_Work_kind", "\"kind\" IN ('unknown','film','series')");
            table.HasCheckConstraint("CK_Work_format", "\"format\" IN ('unknown','movie','series','special')");
            table.HasCheckConstraint("CK_Work_anime", "\"anime\" IN (0,1)");
            table.HasCheckConstraint("CK_Work_year", "\"year\" >= 0");
            table.HasCheckConstraint("CK_Work_runtimeMinutes", "\"runtimeMinutes\" >= 0");
            table.HasCheckConstraint("CK_Work_genresJson", "json_valid(\"genresJson\")");
            table.HasCheckConstraint("CK_Work_releasePrecision", "\"releasePrecision\" IN ('unknown','day','instant')");
            table.HasCheckConstraint("CK_Work_version", "\"version\" >= 0");
            table.HasCheckConstraint("CK_Work_rating", "rating IS NULL OR rating <= 10");
        });
        var work = modelBuilder.Entity<WorkRow>();
        work.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("Work", null));
        work.Property(row => row.Id).IsRequired();
        work.Property(row => row.WorkKey).HasColumnName("workKey").IsRequired(true);
        work.Property(row => row.Kind).HasColumnName("kind").IsRequired(true).HasConversion(EnumStringConverter<WorkKind>());
        work.Property(row => row.Format).HasColumnName("format").IsRequired(true).HasConversion(EnumStringConverter<WorkFormat>());
        work.Property(row => row.Anime).HasColumnName("anime").IsRequired(false);
        work.Property(row => row.Year).HasColumnName("year").IsRequired(false);
        work.Property(row => row.OriginalLanguage).HasColumnName("originalLanguage").IsRequired(false);
        work.Property(row => row.RuntimeMinutes).HasColumnName("runtimeMinutes").IsRequired(false);
        work.Property(row => row.PosterUrl).HasColumnName("posterUrl").IsRequired(false);
        work.Property(row => row.BackdropUrl).HasColumnName("backdropUrl").IsRequired(false);
        work.Property(row => row.Synopsis).HasColumnName("synopsis").IsRequired(false);
        work.Property(row => row.Rating).HasColumnName("rating").IsRequired(false);
        work.Property(row => row.RatingSource).HasColumnName("ratingSource").IsRequired(false);
        work.Property(row => row.Genres).HasColumnName("genresJson").IsRequired(true).HasConversion(JsonValueConverter<ImmutableArray<string>>());
        work.Property(row => row.Genres).Metadata.SetValueComparer(JsonValueComparer<ImmutableArray<string>>());
        work.Property(row => row.TheatricalAt).HasColumnName("theatricalAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        work.Property(row => row.DigitalAt).HasColumnName("digitalAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        work.Property(row => row.PhysicalAt).HasColumnName("physicalAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        work.Property(row => row.ReleasePrecision).HasColumnName("releasePrecision").IsRequired(true).HasConversion(EnumStringConverter<DatePrecision>());
        work.Property(row => row.ProviderStatus).HasColumnName("providerStatus").IsRequired(false);
        work.Property(row => row.NumberingVersion).HasColumnName("numberingVersion").IsRequired(false);
        work.Property(row => row.RefreshedAt).HasColumnName("refreshedAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        work.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        work.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        work.Property(row => row.Version).HasColumnName("version").IsRequired(true);
        work.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<WorkNameRow>().ToTable("WorkName", table =>
        {
            table.HasCheckConstraint("CK_WorkName_label", "\"label\" IN ('english','romaji','synonym','native','original')");
            table.HasCheckConstraint("CK_WorkName_ordinal", "\"ordinal\" >= 0");
            table.HasCheckConstraint("CK_WorkName_authoritative", "\"authoritative\" IN (0,1)");
            table.HasCheckConstraint("CK_WorkName_nonblank", "length(trim(value)) > 0 AND length(trim(normalizedValue)) > 0");
        });
        var workName = modelBuilder.Entity<WorkNameRow>();
        workName.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("WorkName", null));
        workName.Property(row => row.Id).IsRequired();
        workName.Property(row => row.WorkId).HasColumnName("workId").IsRequired(true);
        workName.Property(row => row.Value).HasColumnName("value").IsRequired(true);
        workName.Property(row => row.NormalizedValue).HasColumnName("normalizedValue").IsRequired(true);
        workName.Property(row => row.Label).HasColumnName("label").IsRequired(true).HasConversion(EnumStringConverter<NameLabel>());
        workName.Property(row => row.LinkId).HasColumnName("linkId").IsRequired(false);
        workName.Property(row => row.Ordinal).HasColumnName("ordinal").IsRequired(true);
        workName.Property(row => row.Authoritative).HasColumnName("authoritative").IsRequired(true);
        workName.Property(row => row.RefreshedAt).HasColumnName("refreshedAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        modelBuilder.Entity<WorkLinkRow>().ToTable("WorkLink", table =>
        {
            table.HasCheckConstraint("CK_WorkLink_status", "\"status\" IN ('verified','suggested','rejected')");
            table.HasCheckConstraint("CK_WorkLink_isPrimary", "\"isPrimary\" IN (0,1)");
            table.HasCheckConstraint("CK_WorkLink_confidence", "confidence <= 1");
        });
        var workLink = modelBuilder.Entity<WorkLinkRow>();
        workLink.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("WorkLink", null));
        workLink.Property(row => row.Id).IsRequired();
        workLink.Property(row => row.WorkId).HasColumnName("workId").IsRequired(true);
        workLink.Property(row => row.Provider).HasColumnName("provider").IsRequired(true);
        workLink.Property(row => row.ExternalId).HasColumnName("externalId").IsRequired(true);
        workLink.Property(row => row.ProviderKind).HasColumnName("providerKind").IsRequired(false);
        workLink.Property(row => row.SeasonId).HasColumnName("seasonId").IsRequired(false);
        workLink.Property(row => row.Source).HasColumnName("source").IsRequired(true);
        workLink.Property(row => row.MappingVersion).HasColumnName("mappingVersion").IsRequired(false);
        workLink.Property(row => row.Confidence).HasColumnName("confidence").IsRequired(true);
        workLink.Property(row => row.Status).HasColumnName("status").IsRequired(true).HasConversion(EnumStringConverter<LinkStatus>());
        workLink.Property(row => row.IsPrimary).HasColumnName("isPrimary").IsRequired(true);
        workLink.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        workLink.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        modelBuilder.Entity<SeasonRow>().ToTable("Season", table =>
        {
            table.HasCheckConstraint("CK_Season_number", "\"number\" >= 0");
            table.HasCheckConstraint("CK_Season_mappingStatus", "\"mappingStatus\" IN ('confirmed','provisional','unavailable')");
            table.HasCheckConstraint("CK_Season_expectedEpisodeCount", "\"expectedEpisodeCount\" >= 0");
            table.HasCheckConstraint("CK_Season_version", "\"version\" >= 0");
        });
        var season = modelBuilder.Entity<SeasonRow>();
        season.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("Season", null));
        season.Property(row => row.Id).IsRequired();
        season.Property(row => row.WorkId).HasColumnName("workId").IsRequired(true);
        season.Property(row => row.Number).HasColumnName("number").IsRequired(true);
        season.Property(row => row.Title).HasColumnName("title").IsRequired(false);
        season.Property(row => row.Overview).HasColumnName("overview").IsRequired(false);
        season.Property(row => row.PosterUrl).HasColumnName("posterUrl").IsRequired(false);
        season.Property(row => row.MappingStatus).HasColumnName("mappingStatus").IsRequired(true).HasConversion(EnumStringConverter<MappingStatus>());
        season.Property(row => row.ProviderEntryId).HasColumnName("providerEntryId").IsRequired(false);
        season.Property(row => row.ExpectedEpisodeCount).HasColumnName("expectedEpisodeCount").IsRequired(false);
        season.Property(row => row.RefreshedAt).HasColumnName("refreshedAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        season.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        season.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        season.Property(row => row.Version).HasColumnName("version").IsRequired(true);
        season.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<EpisodeRow>().ToTable("Episode", table =>
        {
            table.HasCheckConstraint("CK_Episode_number", "\"number\" >= 0");
            table.HasCheckConstraint("CK_Episode_absoluteNumber", "\"absoluteNumber\" >= 0");
            table.HasCheckConstraint("CK_Episode_airPrecision", "\"airPrecision\" IN ('unknown','day','instant')");
            table.HasCheckConstraint("CK_Episode_runtimeMinutes", "\"runtimeMinutes\" >= 0");
            table.HasCheckConstraint("CK_Episode_mappingStatus", "\"mappingStatus\" IN ('confirmed','provisional','unavailable')");
            table.HasCheckConstraint("CK_Episode_version", "\"version\" >= 0");
        });
        var episode = modelBuilder.Entity<EpisodeRow>();
        episode.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("Episode", null));
        episode.Property(row => row.Id).IsRequired();
        episode.Property(row => row.SeasonId).HasColumnName("seasonId").IsRequired(true);
        episode.Property(row => row.Number).HasColumnName("number").IsRequired(true);
        episode.Property(row => row.AbsoluteNumber).HasColumnName("absoluteNumber").IsRequired(false);
        episode.Property(row => row.Provider).HasColumnName("provider").IsRequired(false);
        episode.Property(row => row.ProviderEpisodeId).HasColumnName("providerEpisodeId").IsRequired(false);
        episode.Property(row => row.Title).HasColumnName("title").IsRequired(false);
        episode.Property(row => row.Synopsis).HasColumnName("synopsis").IsRequired(false);
        episode.Property(row => row.StillUrl).HasColumnName("stillUrl").IsRequired(false);
        episode.Property(row => row.AirAt).HasColumnName("airAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        episode.Property(row => row.AirPrecision).HasColumnName("airPrecision").IsRequired(true).HasConversion(EnumStringConverter<DatePrecision>());
        episode.Property(row => row.RuntimeMinutes).HasColumnName("runtimeMinutes").IsRequired(false);
        episode.Property(row => row.MappingStatus).HasColumnName("mappingStatus").IsRequired(true).HasConversion(EnumStringConverter<MappingStatus>());
        episode.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        episode.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        episode.Property(row => row.Version).HasColumnName("version").IsRequired(true);
        episode.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<MetadataCacheRow>().ToTable("MetadataCache", table =>
        {
            table.HasCheckConstraint("CK_MetadataCache_kind", "\"kind\" IN ('providerdetail','titlesearch','browserail','fribbmap','jellyfinstate')");
            table.HasCheckConstraint("CK_MetadataCache_payloadJson", "json_valid(\"payloadJson\")");
            table.HasCheckConstraint("CK_MetadataCache_complete", "\"complete\" IN (0,1)");
        });
        var metadataCache = modelBuilder.Entity<MetadataCacheRow>();
        metadataCache.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("MetadataCache", null));
        metadataCache.Property(row => row.Id).IsRequired();
        metadataCache.Property(row => row.Kind).HasColumnName("kind").IsRequired(true).HasConversion(EnumStringConverter<CacheKind>());
        metadataCache.Property(row => row.CacheKey).HasColumnName("cacheKey").IsRequired(true);
        metadataCache.Property(row => row.Payload).HasColumnName("payloadJson").IsRequired(true).HasConversion(JsonValueConverter<JsonElement>());
        metadataCache.Property(row => row.Payload).Metadata.SetValueComparer(JsonValueComparer<JsonElement>());
        metadataCache.Property(row => row.FetchedAt).HasColumnName("fetchedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        metadataCache.Property(row => row.ExpiresAt).HasColumnName("expiresAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        metadataCache.Property(row => row.Etag).HasColumnName("etag").IsRequired(false);
        metadataCache.Property(row => row.LastModified).HasColumnName("lastModified").IsRequired(false);
        metadataCache.Property(row => row.Complete).HasColumnName("complete").IsRequired(true);
        metadataCache.Property(row => row.Provider).HasColumnName("provider").IsRequired(false);
        modelBuilder.Entity<WorkPreferenceRow>().ToTable("WorkPreference", table =>
        {
            table.HasCheckConstraint("CK_WorkPreference_resolutionFloor", "\"resolutionFloor\" >= 0");
            table.HasCheckConstraint("CK_WorkPreference_preferredResolution", "\"preferredResolution\" >= 0");
            table.HasCheckConstraint("CK_WorkPreference_maxBytesPerItem", "\"maxBytesPerItem\" >= 0");
            table.HasCheckConstraint("CK_WorkPreference_version", "\"version\" >= 0");
        });
        var workPreference = modelBuilder.Entity<WorkPreferenceRow>();
        workPreference.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("WorkPreference", null));
        workPreference.Property(row => row.Id).IsRequired();
        workPreference.Property(row => row.WorkId).HasColumnName("workId").IsRequired(true);
        workPreference.Property(row => row.ResolutionFloor).HasColumnName("resolutionFloor").IsRequired(false);
        workPreference.Property(row => row.PreferredResolution).HasColumnName("preferredResolution").IsRequired(false);
        workPreference.Property(row => row.AudioLanguage).HasColumnName("audioLanguage").IsRequired(false);
        workPreference.Property(row => row.MaxBytesPerItem).HasColumnName("maxBytesPerItem").IsRequired(false);
        workPreference.Property(row => row.StorageRootOverrideId).HasColumnName("storageRootOverrideId").IsRequired(false);
        workPreference.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        workPreference.Property(row => row.Version).HasColumnName("version").IsRequired(true);
        workPreference.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<TargetRow>().ToTable("Target", table =>
        {
            table.HasCheckConstraint("CK_Target_kind", "\"kind\" IN ('acquire','replace')");
            table.HasCheckConstraint("CK_Target_state", "\"state\" IN ('wanted','finding','checking','planning','fetching','filing','done','waiting','paused','removed')");
            table.HasCheckConstraint("CK_Target_resumeState", "\"resumeState\" IN ('wanted','finding','checking','planning','fetching','filing','done','waiting','paused','removed')");
            table.HasCheckConstraint("CK_Target_reasonCode", "\"reasonCode\" IN ('notreleased','metadataunavailable','noresults','rejectedcandidates','nohealthyrelease','sourcecooldown','sourcefailure','waitingforseeders','downloadcap','downloadwindow','nodrivespace','driveoffline','filebusy','mappinguncertain','ownerpickrequired','recoverymissing')");
            table.HasCheckConstraint("CK_Target_resolutionFloor", "\"resolutionFloor\" >= 0");
            table.HasCheckConstraint("CK_Target_preferredResolution", "\"preferredResolution\" >= 0");
            table.HasCheckConstraint("CK_Target_maxBytes", "\"maxBytes\" >= 0");
            table.HasCheckConstraint("CK_Target_ownerRanked", "\"ownerRanked\" IN (0,1)");
            table.HasCheckConstraint("CK_Target_origin", "\"origin\" IN ('owner','request','rule','follow','upgrade','hunter')");
            table.HasCheckConstraint("CK_Target_substantiveMisses", "\"substantiveMisses\" >= 0");
            table.HasCheckConstraint("CK_Target_policyRevision", "\"policyRevision\" >= 0");
            table.HasCheckConstraint("CK_Target_version", "\"version\" >= 0");
            table.HasCheckConstraint("CK_Target_priority", "\"priority\" IN ('now','ownerrank','freshrelease','request','backcatalogue','upgradewatch')");
            table.HasCheckConstraint("CK_Target_minListedSeeders", "\"minListedSeeders\" >= 0");
            table.HasCheckConstraint("CK_Target_replacementMode", "(kind='acquire' AND replacementMode IS NULL) OR (kind='replace' AND replacementMode IS NOT NULL)");
        });
        var target = modelBuilder.Entity<TargetRow>();
        target.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("Target", null));
        target.Property(row => row.Id).IsRequired();
        target.Property(row => row.WorkId).HasColumnName("workId").IsRequired(true);
        target.Property(row => row.EpisodeId).HasColumnName("episodeId").IsRequired(false);
        target.Property(row => row.Kind).HasColumnName("kind").IsRequired(true).HasConversion(EnumStringConverter<TargetKind>());
        target.Property(row => row.State).HasColumnName("state").IsRequired(true).HasConversion(EnumStringConverter<TargetState>());
        target.Property(row => row.ResumeState).HasColumnName("resumeState").IsRequired(false).HasConversion(NullableEnumStringConverter<TargetState>());
        target.Property(row => row.ReasonCode).HasColumnName("reasonCode").IsRequired(false).HasConversion(NullableEnumStringConverter<WaitReason>());
        target.Property(row => row.ReasonText).HasColumnName("reasonText").IsRequired(false);
        target.Property(row => row.NextTryAt).HasColumnName("nextTryAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        target.Property(row => row.ExpectedAt).HasColumnName("expectedAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        target.Property(row => row.ResolutionFloor).HasColumnName("resolutionFloor").IsRequired(false);
        target.Property(row => row.PreferredResolution).HasColumnName("preferredResolution").IsRequired(false);
        target.Property(row => row.AudioLanguage).HasColumnName("audioLanguage").IsRequired(false);
        target.Property(row => row.MaxBytes).HasColumnName("maxBytes").IsRequired(false);
        target.Property(row => row.OwnerRanked).HasColumnName("ownerRanked").IsRequired(true);
        target.Property(row => row.Rank).HasColumnName("rank").IsRequired(true);
        target.Property(row => row.NowAt).HasColumnName("nowAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        target.Property(row => row.CreatedBy).HasColumnName("createdBy").IsRequired(true);
        target.Property(row => row.Origin).HasColumnName("origin").IsRequired(true).HasConversion(EnumStringConverter<IntentOrigin>());
        target.Property(row => row.AutoRuleId).HasColumnName("autoRuleId").IsRequired(false);
        target.Property(row => row.ChosenReleaseHash).HasColumnName("chosenReleaseHash").IsRequired(false);
        target.Property(row => row.ReplaceMediaFileId).HasColumnName("replaceMediaFileId").IsRequired(false);
        target.Property(row => row.ReplacementMode).HasColumnName("replacementMode").IsRequired(false).HasConversion(NullableEnumStringConverter<ReplacementMode>());
        target.Property(row => row.BatchId).HasColumnName("batchId").IsRequired(false);
        target.Property(row => row.ClickedAt).HasColumnName("clickedAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        target.Property(row => row.SubstantiveMisses).HasColumnName("substantiveMisses").IsRequired(true);
        target.Property(row => row.HelpNotifiedAt).HasColumnName("helpNotifiedAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        target.Property(row => row.PolicyRevision).HasColumnName("policyRevision").IsRequired(true);
        target.Property(row => row.LeaseUntil).HasColumnName("leaseUntil").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        target.Property(row => row.LeaseToken).HasColumnName("leaseToken").IsRequired(false);
        target.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        target.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        target.Property(row => row.Version).HasColumnName("version").IsRequired(true);
        target.Property(row => row.Version).IsConcurrencyToken();
        target.Property(row => row.Priority).HasColumnName("priority").IsRequired(true).HasConversion(EnumStringConverter<TargetPriority>());
        target.Property(row => row.MinListedSeeders).HasColumnName("minListedSeeders").IsRequired(false);
        target.Property(row => row.PickedReleaseHash).HasColumnName("pickedReleaseHash").IsRequired(false);
        modelBuilder.Entity<ScopeIntentRow>().ToTable("ScopeIntent", table =>
        {
            table.HasCheckConstraint("CK_ScopeIntent_scope", "\"scope\" IN ('film','episodes','seasons','series')");
            table.HasCheckConstraint("CK_ScopeIntent_scopeJson", "json_valid(\"scopeJson\")");
            table.HasCheckConstraint("CK_ScopeIntent_policyJson", "json_valid(\"policyJson\")");
            table.HasCheckConstraint("CK_ScopeIntent_now", "\"now\" IN (0,1)");
            table.HasCheckConstraint("CK_ScopeIntent_state", "\"state\" IN ('pending','materialized','cancelled')");
            table.HasCheckConstraint("CK_ScopeIntent_version", "\"version\" >= 0");
        });
        var scopeIntent = modelBuilder.Entity<ScopeIntentRow>();
        scopeIntent.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("ScopeIntent", null));
        scopeIntent.Property(row => row.Id).IsRequired();
        scopeIntent.Property(row => row.ActorUserId).HasColumnName("actorUserId").IsRequired(true);
        scopeIntent.Property(row => row.WorkId).HasColumnName("workId").IsRequired(true);
        scopeIntent.Property(row => row.Scope).HasColumnName("scope").IsRequired(true).HasConversion(EnumStringConverter<RequestScope>());
        scopeIntent.Property(row => row.ScopeData).HasColumnName("scopeJson").IsRequired(true).HasConversion(JsonValueConverter<RequestScopeData>());
        scopeIntent.Property(row => row.ScopeData).Metadata.SetValueComparer(JsonValueComparer<RequestScopeData>());
        scopeIntent.Property(row => row.Policy).HasColumnName("policyJson").IsRequired(true).HasConversion(JsonValueConverter<Policy>());
        scopeIntent.Property(row => row.Policy).Metadata.SetValueComparer(JsonValueComparer<Policy>());
        scopeIntent.Property(row => row.Now).HasColumnName("now").IsRequired(true);
        scopeIntent.Property(row => row.BatchId).HasColumnName("batchId").IsRequired(true);
        scopeIntent.Property(row => row.State).HasColumnName("state").IsRequired(true).HasConversion(EnumStringConverter<ScopeIntentState>());
        scopeIntent.Property(row => row.NextTryAt).HasColumnName("nextTryAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        scopeIntent.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        scopeIntent.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        scopeIntent.Property(row => row.Version).HasColumnName("version").IsRequired(true);
        scopeIntent.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<RawIntentRow>().ToTable("RawIntent", table =>
        {
            table.HasCheckConstraint("CK_RawIntent_selectedFilesJson", "json_valid(\"selectedFilesJson\")");
            table.HasCheckConstraint("CK_RawIntent_explicitKind", "\"explicitKind\" IN ('movies','tv','anime','animemovies')");
            table.HasCheckConstraint("CK_RawIntent_state", "\"state\" IN ('wanted','checking','planning','fetching','filing','review','done','waiting','paused','removed')");
            table.HasCheckConstraint("CK_RawIntent_resumeState", "\"resumeState\" IN ('wanted','checking','planning','fetching','filing','review','done','waiting','paused','removed')");
            table.HasCheckConstraint("CK_RawIntent_reasonCode", "\"reasonCode\" IN ('notreleased','metadataunavailable','noresults','rejectedcandidates','nohealthyrelease','sourcecooldown','sourcefailure','waitingforseeders','downloadcap','downloadwindow','nodrivespace','driveoffline','filebusy','mappinguncertain','ownerpickrequired','recoverymissing')");
            table.HasCheckConstraint("CK_RawIntent_ownerRanked", "\"ownerRanked\" IN (0,1)");
            table.HasCheckConstraint("CK_RawIntent_version", "\"version\" >= 0");
        });
        var rawIntent = modelBuilder.Entity<RawIntentRow>();
        rawIntent.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("RawIntent", null));
        rawIntent.Property(row => row.Id).IsRequired();
        rawIntent.Property(row => row.ActorUserId).HasColumnName("actorUserId").IsRequired(true);
        rawIntent.Property(row => row.ReleaseHash).HasColumnName("releaseHash").IsRequired(true);
        rawIntent.Property(row => row.DownloadId).HasColumnName("downloadId").IsRequired(false);
        rawIntent.Property(row => row.SelectedFiles).HasColumnName("selectedFilesJson").IsRequired(true).HasConversion(JsonValueConverter<ImmutableArray<int>>());
        rawIntent.Property(row => row.SelectedFiles).Metadata.SetValueComparer(JsonValueComparer<ImmutableArray<int>>());
        rawIntent.Property(row => row.RootId).HasColumnName("rootId").IsRequired(false);
        rawIntent.Property(row => row.ExplicitDirectory).HasColumnName("explicitDirectory").IsRequired(false);
        rawIntent.Property(row => row.ExplicitKind).HasColumnName("explicitKind").IsRequired(false).HasConversion(NullableEnumStringConverter<LibraryKind>());
        rawIntent.Property(row => row.State).HasColumnName("state").IsRequired(true).HasConversion(EnumStringConverter<RawDownloadState>());
        rawIntent.Property(row => row.ResumeState).HasColumnName("resumeState").IsRequired(false).HasConversion(NullableEnumStringConverter<RawDownloadState>());
        rawIntent.Property(row => row.ReasonCode).HasColumnName("reasonCode").IsRequired(false).HasConversion(NullableEnumStringConverter<WaitReason>());
        rawIntent.Property(row => row.ReasonText).HasColumnName("reasonText").IsRequired(false);
        rawIntent.Property(row => row.NextTryAt).HasColumnName("nextTryAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        rawIntent.Property(row => row.NowAt).HasColumnName("nowAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        rawIntent.Property(row => row.OwnerRanked).HasColumnName("ownerRanked").IsRequired(true);
        rawIntent.Property(row => row.Rank).HasColumnName("rank").IsRequired(true);
        rawIntent.Property(row => row.LeaseUntil).HasColumnName("leaseUntil").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        rawIntent.Property(row => row.LeaseToken).HasColumnName("leaseToken").IsRequired(false);
        rawIntent.Property(row => row.BatchId).HasColumnName("batchId").IsRequired(true);
        rawIntent.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        rawIntent.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        rawIntent.Property(row => row.Version).HasColumnName("version").IsRequired(true);
        rawIntent.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<RequestRow>().ToTable("Request", table =>
        {
            table.HasCheckConstraint("CK_Request_scope", "\"scope\" IN ('film','episodes','seasons','series')");
            table.HasCheckConstraint("CK_Request_scopeJson", "json_valid(\"scopeJson\")");
            table.HasCheckConstraint("CK_Request_decision", "\"decision\" IN ('pending','approved','declined','cancelled')");
            table.HasCheckConstraint("CK_Request_version", "\"version\" >= 0");
        });
        var request = modelBuilder.Entity<RequestRow>();
        request.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("Request", null));
        request.Property(row => row.Id).IsRequired();
        request.Property(row => row.UserId).HasColumnName("userId").IsRequired(true);
        request.Property(row => row.WorkId).HasColumnName("workId").IsRequired(true);
        request.Property(row => row.Scope).HasColumnName("scope").IsRequired(true).HasConversion(EnumStringConverter<RequestScope>());
        request.Property(row => row.ScopeData).HasColumnName("scopeJson").IsRequired(true).HasConversion(JsonValueConverter<RequestScopeData>());
        request.Property(row => row.ScopeData).Metadata.SetValueComparer(JsonValueComparer<RequestScopeData>());
        request.Property(row => row.Note).HasColumnName("note").IsRequired(false);
        request.Property(row => row.Decision).HasColumnName("decision").IsRequired(true).HasConversion(EnumStringConverter<RequestDecision>());
        request.Property(row => row.DecisionReason).HasColumnName("decisionReason").IsRequired(false);
        request.Property(row => row.DecidedAt).HasColumnName("decidedAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        request.Property(row => row.DecidedBy).HasColumnName("decidedBy").IsRequired(false);
        request.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        request.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        request.Property(row => row.Version).HasColumnName("version").IsRequired(true);
        request.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<RequestItemRow>().ToTable("RequestItem", table =>
        {
            table.HasCheckConstraint("CK_RequestItem_settlement", "\"settlement\" IN ('open','fulfilled','stoppedbyowner')");
        });
        var requestItem = modelBuilder.Entity<RequestItemRow>();
        requestItem.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("RequestItem", null));
        requestItem.Property(row => row.Id).IsRequired();
        requestItem.Property(row => row.RequestId).HasColumnName("requestId").IsRequired(true);
        requestItem.Property(row => row.EpisodeId).HasColumnName("episodeId").IsRequired(false);
        requestItem.Property(row => row.TargetId).HasColumnName("targetId").IsRequired(false);
        requestItem.Property(row => row.Settlement).HasColumnName("settlement").IsRequired(true).HasConversion(EnumStringConverter<ItemSettlement>());
        requestItem.Property(row => row.SettledAt).HasColumnName("settledAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        requestItem.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        requestItem.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        modelBuilder.Entity<FollowRow>().ToTable("Follow", table =>
        {
            table.HasCheckConstraint("CK_Follow_enabled", "\"enabled\" IN (0,1)");
            table.HasCheckConstraint("CK_Follow_version", "\"version\" >= 0");
        });
        var follow = modelBuilder.Entity<FollowRow>();
        follow.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("Follow", null));
        follow.Property(row => row.Id).IsRequired();
        follow.Property(row => row.WorkId).HasColumnName("workId").IsRequired(true);
        follow.Property(row => row.Enabled).HasColumnName("enabled").IsRequired(true);
        follow.Property(row => row.FromEpisodeId).HasColumnName("fromEpisodeId").IsRequired(false);
        follow.Property(row => row.NewEpisodesSince).HasColumnName("newEpisodesSince").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        follow.Property(row => row.LastMaterializedAt).HasColumnName("lastMaterializedAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        follow.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        follow.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        follow.Property(row => row.Version).HasColumnName("version").IsRequired(true);
        follow.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<WatchItemRow>().ToTable("WatchItem", table =>
        {
            table.HasCheckConstraint("CK_WatchItem_status", "\"status\" IN ('watching','planned','completed','dropped')");
            table.HasCheckConstraint("CK_WatchItem_upgradeWatch", "\"upgradeWatch\" IN (0,1)");
            table.HasCheckConstraint("CK_WatchItem_version", "\"version\" >= 0");
        });
        var watchItem = modelBuilder.Entity<WatchItemRow>();
        watchItem.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("WatchItem", null));
        watchItem.Property(row => row.Id).IsRequired();
        watchItem.Property(row => row.UserId).HasColumnName("userId").IsRequired(true);
        watchItem.Property(row => row.WorkId).HasColumnName("workId").IsRequired(true);
        watchItem.Property(row => row.Status).HasColumnName("status").IsRequired(true).HasConversion(EnumStringConverter<WatchStatus>());
        watchItem.Property(row => row.UpgradeWatch).HasColumnName("upgradeWatch").IsRequired(true);
        watchItem.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        watchItem.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        watchItem.Property(row => row.Version).HasColumnName("version").IsRequired(true);
        watchItem.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<AutoRuleRow>().ToTable("AutoRule", table =>
        {
            table.HasCheckConstraint("CK_AutoRule_minListedSeeders", "\"minListedSeeders\" >= 0");
            table.HasCheckConstraint("CK_AutoRule_maxBytes", "\"maxBytes\" >= 0");
            table.HasCheckConstraint("CK_AutoRule_resolutionFloor", "\"resolutionFloor\" >= 0");
            table.HasCheckConstraint("CK_AutoRule_sourceIdsJson", "json_valid(\"sourceIdsJson\")");
            table.HasCheckConstraint("CK_AutoRule_enabled", "\"enabled\" IN (0,1)");
            table.HasCheckConstraint("CK_AutoRule_matchCount", "\"matchCount\" >= 0");
            table.HasCheckConstraint("CK_AutoRule_version", "\"version\" >= 0");
        });
        var autoRule = modelBuilder.Entity<AutoRuleRow>();
        autoRule.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("AutoRule", null));
        autoRule.Property(row => row.Id).IsRequired();
        autoRule.Property(row => row.UserId).HasColumnName("userId").IsRequired(true);
        autoRule.Property(row => row.Name).HasColumnName("name").IsRequired(true);
        autoRule.Property(row => row.Query).HasColumnName("query").IsRequired(true);
        autoRule.Property(row => row.Category).HasColumnName("category").IsRequired(true);
        autoRule.Property(row => row.MinListedSeeders).HasColumnName("minListedSeeders").IsRequired(true);
        autoRule.Property(row => row.MaxBytes).HasColumnName("maxBytes").IsRequired(false);
        autoRule.Property(row => row.ResolutionFloor).HasColumnName("resolutionFloor").IsRequired(false);
        autoRule.Property(row => row.SourceIds).HasColumnName("sourceIdsJson").IsRequired(true).HasConversion(JsonValueConverter<ImmutableArray<string>>());
        autoRule.Property(row => row.SourceIds).Metadata.SetValueComparer(JsonValueComparer<ImmutableArray<string>>());
        autoRule.Property(row => row.Enabled).HasColumnName("enabled").IsRequired(true);
        autoRule.Property(row => row.LastRunAt).HasColumnName("lastRunAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        autoRule.Property(row => row.LastMatchHash).HasColumnName("lastMatchHash").IsRequired(false);
        autoRule.Property(row => row.MatchCount).HasColumnName("matchCount").IsRequired(true);
        autoRule.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        autoRule.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        autoRule.Property(row => row.Version).HasColumnName("version").IsRequired(true);
        autoRule.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<ReleaseRow>().ToTable("Release", table =>
        {
            table.HasCheckConstraint("CK_Release_parsedJson", "json_valid(\"parsedJson\")");
            table.HasCheckConstraint("CK_Release_totalBytes", "\"totalBytes\" >= 0");
            table.HasCheckConstraint("CK_Release_filesJson", "json_valid(\"filesJson\")");
            table.HasCheckConstraint("CK_Release_private", "\"private\" IN (0,1)");
            table.HasCheckConstraint("CK_Release_hash", "length(hash) IN (40,64) AND hash NOT GLOB '*[^0-9a-f]*'");
        });
        var release = modelBuilder.Entity<ReleaseRow>();
        release.Property(row => row.Id).Metadata.SetColumnName("hash", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("Release", null));
        release.Property(row => row.Id).IsRequired();
        release.Property(row => row.Name).HasColumnName("name").IsRequired(true);
        release.Property(row => row.Parsed).HasColumnName("parsedJson").IsRequired(true).HasConversion(JsonValueConverter<ParsedRelease>());
        release.Property(row => row.Parsed).Metadata.SetValueComparer(JsonValueComparer<ParsedRelease>());
        release.Property(row => row.TotalBytes).HasColumnName("totalBytes").IsRequired(false);
        release.Property(row => row.TorrentUri).HasColumnName("torrentUri").IsRequired(false);
        release.Property(row => row.Magnet).HasColumnName("magnet").IsRequired(false);
        release.Property(row => row.Files).HasColumnName("filesJson").IsRequired(false).HasConversion(JsonValueConverter<ImmutableArray<TorrentFile>?>());
        release.Property(row => row.Files).Metadata.SetValueComparer(JsonValueComparer<ImmutableArray<TorrentFile>?>());
        release.Property(row => row.MetadataDigest).HasColumnName("metadataDigest").IsRequired(false);
        release.Property(row => row.Private).HasColumnName("private").IsRequired(false);
        release.Property(row => row.FirstSeenAt).HasColumnName("firstSeenAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        release.Property(row => row.LastSeenAt).HasColumnName("lastSeenAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        modelBuilder.Entity<ReleaseObservationRow>().ToTable("ReleaseObservation", table =>
        {
            table.HasCheckConstraint("CK_ReleaseObservation_listedSeeders", "\"listedSeeders\" >= 0");
            table.HasCheckConstraint("CK_ReleaseObservation_listedLeechers", "\"listedLeechers\" >= 0");
            table.HasCheckConstraint("CK_ReleaseObservation_webSeedsJson", "json_valid(\"webSeedsJson\")");
        });
        var releaseObservation = modelBuilder.Entity<ReleaseObservationRow>();
        releaseObservation.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("ReleaseObservation", null));
        releaseObservation.Property(row => row.Id).IsRequired();
        releaseObservation.Property(row => row.Hash).HasColumnName("hash").IsRequired(true);
        releaseObservation.Property(row => row.SourceId).HasColumnName("sourceId").IsRequired(true);
        releaseObservation.Property(row => row.SourceItemId).HasColumnName("sourceItemId").IsRequired(false);
        releaseObservation.Property(row => row.Query).HasColumnName("query").IsRequired(true);
        releaseObservation.Property(row => row.ListedSeeders).HasColumnName("listedSeeders").IsRequired(false);
        releaseObservation.Property(row => row.ListedLeechers).HasColumnName("listedLeechers").IsRequired(false);
        releaseObservation.Property(row => row.UploadedAt).HasColumnName("uploadedAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        releaseObservation.Property(row => row.ObservedAt).HasColumnName("observedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        releaseObservation.Property(row => row.TorrentUri).HasColumnName("torrentUri").IsRequired(false);
        releaseObservation.Property(row => row.WebSeeds).HasColumnName("webSeedsJson").IsRequired(true).HasConversion(JsonValueConverter<ImmutableArray<string>>());
        releaseObservation.Property(row => row.WebSeeds).Metadata.SetValueComparer(JsonValueComparer<ImmutableArray<string>>());
        modelBuilder.Entity<VerdictRow>().ToTable("Verdict", table =>
        {
            table.HasCheckConstraint("CK_Verdict_band", "\"band\" IN ('good','weak','dead','unknown')");
            table.HasCheckConstraint("CK_Verdict_connectedPeers", "\"connectedPeers\" >= 0");
            table.HasCheckConstraint("CK_Verdict_connectedSeeders", "\"connectedSeeders\" >= 0");
            table.HasCheckConstraint("CK_Verdict_bytesDelivered", "\"bytesDelivered\" >= 0");
            table.HasCheckConstraint("CK_Verdict_sampleMilliseconds", "\"sampleMilliseconds\" >= 0");
            table.HasCheckConstraint("CK_Verdict_scrapedSeeders", "\"scrapedSeeders\" >= 0");
            table.HasCheckConstraint("CK_Verdict_probeVersion", "\"probeVersion\" >= 0");
            table.HasCheckConstraint("CK_Verdict_byteSendingPeers", "\"byteSendingPeers\" >= 0");
            table.HasCheckConstraint("CK_Verdict_probeMetricsJson", "json_valid(\"probeMetricsJson\")");
        });
        var verdict = modelBuilder.Entity<VerdictRow>();
        verdict.Property(row => row.Id).Metadata.SetColumnName("hash", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("Verdict", null));
        verdict.Property(row => row.Id).IsRequired();
        verdict.Property(row => row.Band).HasColumnName("band").IsRequired(true).HasConversion(EnumStringConverter<HealthBand>());
        verdict.Property(row => row.ConnectedPeers).HasColumnName("connectedPeers").IsRequired(true);
        verdict.Property(row => row.ConnectedSeeders).HasColumnName("connectedSeeders").IsRequired(true);
        verdict.Property(row => row.BytesDelivered).HasColumnName("bytesDelivered").IsRequired(true);
        verdict.Property(row => row.SampleMilliseconds).HasColumnName("sampleMilliseconds").IsRequired(true);
        verdict.Property(row => row.ScrapedSeeders).HasColumnName("scrapedSeeders").IsRequired(false);
        verdict.Property(row => row.Reason).HasColumnName("reason").IsRequired(true);
        verdict.Property(row => row.CheckedAt).HasColumnName("checkedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        verdict.Property(row => row.ExpiresAt).HasColumnName("expiresAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        verdict.Property(row => row.ProbeVersion).HasColumnName("probeVersion").IsRequired(true);
        verdict.Property(row => row.ByteSendingPeers).HasColumnName("byteSendingPeers").IsRequired(true);
        verdict.Property(row => row.ProbeMetrics).HasColumnName("probeMetricsJson").IsRequired(false).HasConversion(JsonValueConverter<ProbePayloadMetrics?>());
        verdict.Property(row => row.ProbeMetrics).Metadata.SetValueComparer(JsonValueComparer<ProbePayloadMetrics?>());
        modelBuilder.Entity<AttemptRow>().ToTable("Attempt", table =>
        {
            table.HasCheckConstraint("CK_Attempt_kind", "\"kind\" IN ('search','check','plan','fetch','file','swap','legacyevent')");
            table.HasCheckConstraint("CK_Attempt_decisionJson", "json_valid(\"decisionJson\")");
            table.HasCheckConstraint("CK_Attempt_legacyContextJson", "json_valid(\"legacyContextJson\")");
            table.HasCheckConstraint("CK_Attempt_swapJson", "json_valid(\"swapJson\")");
        });
        var attempt = modelBuilder.Entity<AttemptRow>();
        attempt.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("Attempt", null));
        attempt.Property(row => row.Id).IsRequired();
        attempt.Property(row => row.TargetId).HasColumnName("targetId").IsRequired(false);
        attempt.Property(row => row.WorkId).HasColumnName("workId").IsRequired(false);
        attempt.Property(row => row.ReleaseHash).HasColumnName("releaseHash").IsRequired(false);
        attempt.Property(row => row.ActorUserId).HasColumnName("actorUserId").IsRequired(false);
        attempt.Property(row => row.Kind).HasColumnName("kind").IsRequired(true).HasConversion(EnumStringConverter<AttemptKind>());
        attempt.Property(row => row.StartedAt).HasColumnName("startedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        attempt.Property(row => row.EndedAt).HasColumnName("endedAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        attempt.Property(row => row.Outcome).HasColumnName("outcome").IsRequired(false);
        attempt.Property(row => row.ReasonCode).HasColumnName("reasonCode").IsRequired(false);
        attempt.Property(row => row.ReasonText).HasColumnName("reasonText").IsRequired(false);
        attempt.Property(row => row.Decision).HasColumnName("decisionJson").IsRequired(false).HasConversion(JsonValueConverter<DecisionEvidence?>());
        attempt.Property(row => row.Decision).Metadata.SetValueComparer(JsonValueComparer<DecisionEvidence?>());
        attempt.Property(row => row.LegacyContext).HasColumnName("legacyContextJson").IsRequired(false).HasConversion(JsonValueConverter<JsonElement?>());
        attempt.Property(row => row.LegacyContext).Metadata.SetValueComparer(JsonValueComparer<JsonElement?>());
        attempt.Property(row => row.BatchId).HasColumnName("batchId").IsRequired(false);
        attempt.Property(row => row.DownloadId).HasColumnName("downloadId").IsRequired(false);
        attempt.Property(row => row.DeadlineAt).HasColumnName("deadlineAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        attempt.Property(row => row.Swap).HasColumnName("swapJson").IsRequired(false).HasConversion(JsonValueConverter<SwapDecision?>());
        attempt.Property(row => row.Swap).Metadata.SetValueComparer(JsonValueComparer<SwapDecision?>());
        modelBuilder.Entity<BlockRow>().ToTable("Block", table =>
        {
            table.HasCheckConstraint("CK_Block_origin", "\"origin\" IN ('owner','unsafe','foreign','stalled','swap')");
        });
        var block = modelBuilder.Entity<BlockRow>();
        block.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("Block", null));
        block.Property(row => row.Id).IsRequired();
        block.Property(row => row.Hash).HasColumnName("hash").IsRequired(true);
        block.Property(row => row.WorkKey).HasColumnName("workKey").IsRequired(false);
        block.Property(row => row.Reason).HasColumnName("reason").IsRequired(true);
        block.Property(row => row.Origin).HasColumnName("origin").IsRequired(true).HasConversion(EnumStringConverter<BlockOrigin>());
        block.Property(row => row.ReplacedByHash).HasColumnName("replacedByHash").IsRequired(false);
        block.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        block.Property(row => row.Until).HasColumnName("until").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        modelBuilder.Entity<SearchCacheRow>().ToTable("SearchCache", table =>
        {
            table.HasCheckConstraint("CK_SearchCache_sourceRevision", "\"sourceRevision\" >= 0");
            table.HasCheckConstraint("CK_SearchCache_credentialRevision", "\"credentialRevision\" >= 0");
            table.HasCheckConstraint("CK_SearchCache_parserVersion", "\"parserVersion\" >= 0");
            table.HasCheckConstraint("CK_SearchCache_payloadJson", "json_valid(\"payloadJson\")");
            table.HasCheckConstraint("CK_SearchCache_complete", "\"complete\" IN (0,1)");
        });
        var searchCache = modelBuilder.Entity<SearchCacheRow>();
        searchCache.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("SearchCache", null));
        searchCache.Property(row => row.Id).IsRequired();
        searchCache.Property(row => row.NormalizedQuery).HasColumnName("normalizedQuery").IsRequired(true);
        searchCache.Property(row => row.ScopeKey).HasColumnName("scopeKey").IsRequired(true);
        searchCache.Property(row => row.SourceId).HasColumnName("sourceId").IsRequired(true);
        searchCache.Property(row => row.SourceRevision).HasColumnName("sourceRevision").IsRequired(true);
        searchCache.Property(row => row.CredentialRevision).HasColumnName("credentialRevision").IsRequired(true);
        searchCache.Property(row => row.ParserVersion).HasColumnName("parserVersion").IsRequired(true);
        searchCache.Property(row => row.Payload).HasColumnName("payloadJson").IsRequired(true).HasConversion(JsonValueConverter<SearchCachePayload>());
        searchCache.Property(row => row.Payload).Metadata.SetValueComparer(JsonValueComparer<SearchCachePayload>());
        searchCache.Property(row => row.Complete).HasColumnName("complete").IsRequired(true);
        searchCache.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        searchCache.Property(row => row.ExpiresAt).HasColumnName("expiresAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        modelBuilder.Entity<DownloadRow>().ToTable("Download", table =>
        {
            table.HasCheckConstraint("CK_Download_intent", "\"intent\" IN ('run','queued','paused','stopped')");
            table.HasCheckConstraint("CK_Download_version", "\"version\" >= 0");
        });
        var download = modelBuilder.Entity<DownloadRow>();
        download.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("Download", null));
        download.Property(row => row.Id).IsRequired();
        download.Property(row => row.Hash).HasColumnName("hash").IsRequired(true);
        download.Property(row => row.Intent).HasColumnName("intent").IsRequired(true).HasConversion(EnumStringConverter<DownloadIntent>());
        download.Property(row => row.RootId).HasColumnName("rootId").IsRequired(false);
        download.Property(row => row.AddedAt).HasColumnName("addedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        download.Property(row => row.FinishedAt).HasColumnName("finishedAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        download.Property(row => row.AdmissionToken).HasColumnName("admissionToken").IsRequired(true);
        download.Property(row => row.ResumeArtifact).HasColumnName("resumeArtifact").IsRequired(false);
        download.Property(row => row.RawIntentId).HasColumnName("rawIntentId").IsRequired(false);
        download.Property(row => row.Version).HasColumnName("version").IsRequired(true);
        download.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<DownloadTargetRow>().ToTable("DownloadTarget", table =>
        {
            table.HasCheckConstraint("CK_DownloadTarget_role", "\"role\" IN ('current','replacement','retired')");
        });
        var downloadTarget = modelBuilder.Entity<DownloadTargetRow>();
        downloadTarget.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("DownloadTarget", null));
        downloadTarget.Property(row => row.Id).IsRequired();
        downloadTarget.Property(row => row.DownloadId).HasColumnName("downloadId").IsRequired(true);
        downloadTarget.Property(row => row.TargetId).HasColumnName("targetId").IsRequired(true);
        downloadTarget.Property(row => row.Role).HasColumnName("role").IsRequired(true).HasConversion(EnumStringConverter<AssociationRole>());
        downloadTarget.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        modelBuilder.Entity<DownloadFileRow>().ToTable("DownloadFile", table =>
        {
            table.HasCheckConstraint("CK_DownloadFile_fileIndex", "\"fileIndex\" >= 0");
            table.HasCheckConstraint("CK_DownloadFile_selected", "\"selected\" IN (0,1)");
            table.HasCheckConstraint("CK_DownloadFile_role", "\"role\" IN ('video','subtitle','audio','unwanted')");
            table.HasCheckConstraint("CK_DownloadFile_expectedBytes", "\"expectedBytes\" >= 0");
            table.HasCheckConstraint("CK_DownloadFile_filed", "\"filed\" IN (0,1)");
        });
        var downloadFile = modelBuilder.Entity<DownloadFileRow>();
        downloadFile.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("DownloadFile", null));
        downloadFile.Property(row => row.Id).IsRequired();
        downloadFile.Property(row => row.DownloadId).HasColumnName("downloadId").IsRequired(true);
        downloadFile.Property(row => row.FileIndex).HasColumnName("fileIndex").IsRequired(true);
        downloadFile.Property(row => row.Selected).HasColumnName("selected").IsRequired(true);
        downloadFile.Property(row => row.TargetId).HasColumnName("targetId").IsRequired(false);
        downloadFile.Property(row => row.PartialPath).HasColumnName("partialPath").IsRequired(false);
        downloadFile.Property(row => row.FinalPath).HasColumnName("finalPath").IsRequired(false);
        downloadFile.Property(row => row.PhysicalKey).HasColumnName("physicalKey").IsRequired(false);
        downloadFile.Property(row => row.MediaFileId).HasColumnName("mediaFileId").IsRequired(false);
        downloadFile.Property(row => row.Role).HasColumnName("role").IsRequired(true).HasConversion(EnumStringConverter<FileRole>());
        downloadFile.Property(row => row.ExpectedBytes).HasColumnName("expectedBytes").IsRequired(true);
        downloadFile.Property(row => row.EnginePath).HasColumnName("enginePath").IsRequired(false);
        downloadFile.Property(row => row.Filed).HasColumnName("filed").IsRequired(true);
        modelBuilder.Entity<StorageRootRow>().ToTable("StorageRoot", table =>
        {
            table.HasCheckConstraint("CK_StorageRoot_kindsJson", "json_valid(\"kindsJson\")");
            table.HasCheckConstraint("CK_StorageRoot_libraryFoldersJson", "json_valid(\"libraryFoldersJson\")");
            table.HasCheckConstraint("CK_StorageRoot_reserveBytes", "\"reserveBytes\" >= 0");
            table.HasCheckConstraint("CK_StorageRoot_maxAllocatedBytes", "\"maxAllocatedBytes\" >= 0");
            table.HasCheckConstraint("CK_StorageRoot_enabled", "\"enabled\" IN (0,1)");
            table.HasCheckConstraint("CK_StorageRoot_online", "\"online\" IN (0,1)");
            table.HasCheckConstraint("CK_StorageRoot_reviewRequired", "\"reviewRequired\" IN (0,1)");
            table.HasCheckConstraint("CK_StorageRoot_version", "\"version\" >= 0");
        });
        var storageRoot = modelBuilder.Entity<StorageRootRow>();
        storageRoot.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("StorageRoot", null));
        storageRoot.Property(row => row.Id).IsRequired();
        storageRoot.Property(row => row.Path).HasColumnName("path").IsRequired(true);
        storageRoot.Property(row => row.PhysicalKey).HasColumnName("physicalKey").IsRequired(true);
        storageRoot.Property(row => row.Kinds).HasColumnName("kindsJson").IsRequired(true).HasConversion(JsonValueConverter<ImmutableArray<LibraryKind>>());
        storageRoot.Property(row => row.Kinds).Metadata.SetValueComparer(JsonValueComparer<ImmutableArray<LibraryKind>>());
        storageRoot.Property(row => row.LibraryFolders).HasColumnName("libraryFoldersJson").IsRequired(true).HasConversion(JsonValueConverter<LibraryFolders>());
        storageRoot.Property(row => row.LibraryFolders).Metadata.SetValueComparer(JsonValueComparer<LibraryFolders>());
        storageRoot.Property(row => row.VolumeSerial).HasColumnName("volumeSerial").IsRequired(true);
        storageRoot.Property(row => row.Priority).HasColumnName("priority").IsRequired(true);
        storageRoot.Property(row => row.ReserveBytes).HasColumnName("reserveBytes").IsRequired(true);
        storageRoot.Property(row => row.MaxAllocatedBytes).HasColumnName("maxAllocatedBytes").IsRequired(false);
        storageRoot.Property(row => row.Enabled).HasColumnName("enabled").IsRequired(true);
        storageRoot.Property(row => row.Online).HasColumnName("online").IsRequired(true);
        storageRoot.Property(row => row.ReviewRequired).HasColumnName("reviewRequired").IsRequired(true);
        storageRoot.Property(row => row.LastCheckedAt).HasColumnName("lastCheckedAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        storageRoot.Property(row => row.LastError).HasColumnName("lastError").IsRequired(false);
        storageRoot.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        storageRoot.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        storageRoot.Property(row => row.Version).HasColumnName("version").IsRequired(true);
        storageRoot.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<WorkFolderRow>().ToTable("WorkFolder", table =>
        {
            table.HasCheckConstraint("CK_WorkFolder_version", "\"version\" >= 0");
            table.HasCheckConstraint("CK_WorkFolder_shape", "(rootId IS NOT NULL AND relativeItemFolder IS NOT NULL AND externalItemFolder IS NULL) OR (rootId IS NULL AND relativeItemFolder IS NULL AND externalItemFolder IS NOT NULL)");
        });
        var workFolder = modelBuilder.Entity<WorkFolderRow>();
        workFolder.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("WorkFolder", null));
        workFolder.Property(row => row.Id).IsRequired();
        workFolder.Property(row => row.WorkId).HasColumnName("workId").IsRequired(true);
        workFolder.Property(row => row.RootId).HasColumnName("rootId").IsRequired(false);
        workFolder.Property(row => row.RelativeItemFolder).HasColumnName("relativeItemFolder").IsRequired(false);
        workFolder.Property(row => row.ExternalItemFolder).HasColumnName("externalItemFolder").IsRequired(false);
        workFolder.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        workFolder.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        workFolder.Property(row => row.Version).HasColumnName("version").IsRequired(true);
        workFolder.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<MediaFileRow>().ToTable("MediaFile", table =>
        {
            table.HasCheckConstraint("CK_MediaFile_bytes", "\"bytes\" >= 0");
            table.HasCheckConstraint("CK_MediaFile_resolution", "\"resolution\" >= 0");
            table.HasCheckConstraint("CK_MediaFile_width", "\"width\" >= 0");
            table.HasCheckConstraint("CK_MediaFile_height", "\"height\" >= 0");
            table.HasCheckConstraint("CK_MediaFile_runtimeSeconds", "\"runtimeSeconds\" >= 0");
            table.HasCheckConstraint("CK_MediaFile_bitrateBps", "\"bitrateBps\" >= 0");
            table.HasCheckConstraint("CK_MediaFile_tracksJson", "json_valid(\"tracksJson\")");
            table.HasCheckConstraint("CK_MediaFile_origin", "\"origin\" IN ('downloaded','imported','adopted')");
            table.HasCheckConstraint("CK_MediaFile_fileIndex", "\"fileIndex\" >= 0");
            table.HasCheckConstraint("CK_MediaFile_status", "\"status\" IN ('present','offline','missing')");
            table.HasCheckConstraint("CK_MediaFile_version", "\"version\" >= 0");
            table.HasCheckConstraint("CK_MediaFile_role", "role IN ('video','subtitle','audio')");
        });
        var mediaFile = modelBuilder.Entity<MediaFileRow>();
        mediaFile.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("MediaFile", null));
        mediaFile.Property(row => row.Id).IsRequired();
        mediaFile.Property(row => row.WorkId).HasColumnName("workId").IsRequired(true);
        mediaFile.Property(row => row.EpisodeId).HasColumnName("episodeId").IsRequired(false);
        mediaFile.Property(row => row.RootId).HasColumnName("rootId").IsRequired(false);
        mediaFile.Property(row => row.Path).HasColumnName("path").IsRequired(true);
        mediaFile.Property(row => row.PhysicalKey).HasColumnName("physicalKey").IsRequired(true);
        mediaFile.Property(row => row.Role).HasColumnName("role").IsRequired(true).HasConversion(EnumStringConverter<FileRole>());
        mediaFile.Property(row => row.ParentMediaFileId).HasColumnName("parentMediaFileId").IsRequired(false);
        mediaFile.Property(row => row.Bytes).HasColumnName("bytes").IsRequired(true);
        mediaFile.Property(row => row.MtimeUtc).HasColumnName("mtimeUtc").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        mediaFile.Property(row => row.Resolution).HasColumnName("resolution").IsRequired(false);
        mediaFile.Property(row => row.Source).HasColumnName("source").IsRequired(false);
        mediaFile.Property(row => row.Container).HasColumnName("container").IsRequired(false);
        mediaFile.Property(row => row.VideoCodec).HasColumnName("videoCodec").IsRequired(false);
        mediaFile.Property(row => row.VideoProfile).HasColumnName("videoProfile").IsRequired(false);
        mediaFile.Property(row => row.Width).HasColumnName("width").IsRequired(false);
        mediaFile.Property(row => row.Height).HasColumnName("height").IsRequired(false);
        mediaFile.Property(row => row.Hdr).HasColumnName("hdr").IsRequired(false);
        mediaFile.Property(row => row.RuntimeSeconds).HasColumnName("runtimeSeconds").IsRequired(false);
        mediaFile.Property(row => row.BitrateBps).HasColumnName("bitrateBps").IsRequired(false);
        mediaFile.Property(row => row.Tracks).HasColumnName("tracksJson").IsRequired(true).HasConversion(JsonValueConverter<ImmutableArray<MediaTrack>>());
        mediaFile.Property(row => row.Tracks).Metadata.SetValueComparer(JsonValueComparer<ImmutableArray<MediaTrack>>());
        mediaFile.Property(row => row.Origin).HasColumnName("origin").IsRequired(true).HasConversion(EnumStringConverter<MediaOrigin>());
        mediaFile.Property(row => row.DownloadId).HasColumnName("downloadId").IsRequired(false);
        mediaFile.Property(row => row.FileIndex).HasColumnName("fileIndex").IsRequired(false);
        mediaFile.Property(row => row.AddedAt).HasColumnName("addedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        mediaFile.Property(row => row.LastSeenAt).HasColumnName("lastSeenAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        mediaFile.Property(row => row.MissingSince).HasColumnName("missingSince").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        mediaFile.Property(row => row.Status).HasColumnName("status").IsRequired(true).HasConversion(EnumStringConverter<FilePresence>());
        mediaFile.Property(row => row.MissingConfirmedAt).HasColumnName("missingConfirmedAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        mediaFile.Property(row => row.VerifiedAt).HasColumnName("verifiedAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        mediaFile.Property(row => row.ContentDigest).HasColumnName("contentDigest").IsRequired(false);
        mediaFile.Property(row => row.Version).HasColumnName("version").IsRequired(true);
        mediaFile.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<FileOperationRow>().ToTable("FileOperation", table =>
        {
            table.HasCheckConstraint("CK_FileOperation_kind", "\"kind\" IN ('rename','move','copy','delete','import','relocate')");
            table.HasCheckConstraint("CK_FileOperation_expectedBytes", "\"expectedBytes\" >= 0");
            table.HasCheckConstraint("CK_FileOperation_state", "\"state\" IN ('pending','copied','verified','inventorycommitted','sourcedeleted','done','retry','needsowner','superseded')");
            table.HasCheckConstraint("CK_FileOperation_deleteSource", "\"deleteSource\" IN (0,1)");
            table.HasCheckConstraint("CK_FileOperation_attempts", "\"attempts\" >= 0");
            table.HasCheckConstraint("CK_FileOperation_resumeStage", "\"resumeStage\" IN ('pending','copied','verified','inventorycommitted','sourcedeleted','done','retry','needsowner','superseded')");
        });
        var fileOperation = modelBuilder.Entity<FileOperationRow>();
        fileOperation.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("FileOperation", null));
        fileOperation.Property(row => row.Id).IsRequired();
        fileOperation.Property(row => row.Kind).HasColumnName("kind").IsRequired(true).HasConversion(EnumStringConverter<FileOperationKind>());
        fileOperation.Property(row => row.TargetId).HasColumnName("targetId").IsRequired(false);
        fileOperation.Property(row => row.DownloadId).HasColumnName("downloadId").IsRequired(false);
        fileOperation.Property(row => row.MediaFileId).HasColumnName("mediaFileId").IsRequired(false);
        fileOperation.Property(row => row.SourcePath).HasColumnName("sourcePath").IsRequired(false);
        fileOperation.Property(row => row.DestinationPath).HasColumnName("destinationPath").IsRequired(false);
        fileOperation.Property(row => row.ExpectedBytes).HasColumnName("expectedBytes").IsRequired(false);
        fileOperation.Property(row => row.ExpectedDigest).HasColumnName("expectedDigest").IsRequired(false);
        fileOperation.Property(row => row.State).HasColumnName("state").IsRequired(true).HasConversion(EnumStringConverter<FileOperationState>());
        fileOperation.Property(row => row.DeleteSource).HasColumnName("deleteSource").IsRequired(true);
        fileOperation.Property(row => row.Attempts).HasColumnName("attempts").IsRequired(true);
        fileOperation.Property(row => row.NextTryAt).HasColumnName("nextTryAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        fileOperation.Property(row => row.LastError).HasColumnName("lastError").IsRequired(false);
        fileOperation.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        fileOperation.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        fileOperation.Property(row => row.LeaseToken).HasColumnName("leaseToken").IsRequired(false);
        fileOperation.Property(row => row.LeaseUntil).HasColumnName("leaseUntil").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        fileOperation.Property(row => row.ResumeStage).HasColumnName("resumeStage").IsRequired(false).HasConversion(NullableEnumStringConverter<FileOperationState>());
        fileOperation.Property(row => row.EnginePermitToken).HasColumnName("enginePermitToken").IsRequired(false);
        modelBuilder.Entity<FilePathClaimRow>().ToTable("FilePathClaim");
        var filePathClaim = modelBuilder.Entity<FilePathClaimRow>();
        filePathClaim.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("FilePathClaim", null));
        filePathClaim.Property(row => row.Id).IsRequired();
        filePathClaim.Property(row => row.OperationId).HasColumnName("operationId").IsRequired(true);
        filePathClaim.Property(row => row.PhysicalKey).HasColumnName("physicalKey").IsRequired(true);
        filePathClaim.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        modelBuilder.Entity<UserRow>().ToTable("User", table =>
        {
            table.HasCheckConstraint("CK_User_role", "\"role\" IN ('owner','requester')");
        });
        var user = modelBuilder.Entity<UserRow>();
        user.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("User", null));
        user.Property(row => row.Id).IsRequired();
        user.Property(row => row.NormalizedEmail).HasColumnName("normalizedEmail").IsRequired(false);
        user.Property(row => row.Name).HasColumnName("name").IsRequired(false);
        user.Property(row => row.Image).HasColumnName("image").IsRequired(false);
        user.Property(row => row.Role).HasColumnName("role").IsRequired(true).HasConversion(EnumStringConverter<UserRole>());
        user.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        user.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        modelBuilder.Entity<NotificationRow>().ToTable("Notification", table =>
        {
            table.HasCheckConstraint("CK_Notification_pushPending", "\"pushPending\" IN (0,1)");
            table.HasCheckConstraint("CK_Notification_pushAttempts", "\"pushAttempts\" >= 0");
            table.HasCheckConstraint("CK_Notification_length", "length(title) <= 200 AND (body IS NULL OR length(body) <= 500)");
        });
        var notification = modelBuilder.Entity<NotificationRow>();
        notification.Property(row => row.Id).Metadata.SetColumnName("id", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("Notification", null));
        notification.Property(row => row.Id).IsRequired();
        notification.Property(row => row.UserId).HasColumnName("userId").IsRequired(true);
        notification.Property(row => row.Kind).HasColumnName("kind").IsRequired(true);
        notification.Property(row => row.Title).HasColumnName("title").IsRequired(true);
        notification.Property(row => row.Body).HasColumnName("body").IsRequired(false);
        notification.Property(row => row.Link).HasColumnName("link").IsRequired(false);
        notification.Property(row => row.DedupeKey).HasColumnName("dedupeKey").IsRequired(false);
        notification.Property(row => row.CreatedAt).HasColumnName("createdAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        notification.Property(row => row.ReadAt).HasColumnName("readAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        notification.Property(row => row.PushPending).HasColumnName("pushPending").IsRequired(true);
        notification.Property(row => row.PushAttemptAt).HasColumnName("pushAttemptAt").IsRequired(false).HasConversion(NullableDateTimeOffsetConverter());
        notification.Property(row => row.PushAttempts).HasColumnName("pushAttempts").IsRequired(true);
        modelBuilder.Entity<SettingRow>().ToTable("Setting", table =>
        {
            table.HasCheckConstraint("CK_Setting_schemaVersion", "\"schemaVersion\" >= 0");
            table.HasCheckConstraint("CK_Setting_valueJson", "json_valid(\"valueJson\")");
            table.HasCheckConstraint("CK_Setting_revision", "\"revision\" >= 0");
            table.HasCheckConstraint("CK_Setting_section", "section IN ('engine','sources','metadata','remoteAccess','desktop','quality','requests','scheduler','jellyfin','recovery') AND schemaVersion=1");
        });
        var setting = modelBuilder.Entity<SettingRow>();
        setting.Property(row => row.Id).Metadata.SetColumnName("section", Microsoft.EntityFrameworkCore.Metadata.StoreObjectIdentifier.Table("Setting", null));
        setting.Property(row => row.Id).IsRequired();
        setting.Property(row => row.SchemaVersion).HasColumnName("schemaVersion").IsRequired(true);
        setting.Property(row => row.Value).HasColumnName("valueJson").IsRequired(true).HasConversion(JsonValueConverter<JsonElement>());
        setting.Property(row => row.Value).Metadata.SetValueComparer(JsonValueComparer<JsonElement>());
        setting.Property(row => row.Revision).HasColumnName("revision").IsRequired(true);
        setting.Property(row => row.Revision).IsConcurrencyToken();
        setting.Property(row => row.UpdatedAt).HasColumnName("updatedAt").IsRequired(true).HasConversion(DateTimeOffsetStringConverter());
        modelBuilder.Entity<WorkRow>().HasIndex(new[] { "WorkKey" }, "IX_Work_workKey_all").IsUnique(true);
        modelBuilder.Entity<WorkRow>().HasIndex(new[] { "Kind", "Anime" }, "IX_Work_kind_anime_all").IsUnique(false);
        modelBuilder.Entity<WorkRow>().HasIndex(new[] { "DigitalAt" }, "IX_Work_digitalAt_all").IsUnique(false);
        modelBuilder.Entity<WorkRow>().HasIndex(new[] { "RefreshedAt" }, "IX_Work_refreshedAt_all").IsUnique(false);
        modelBuilder.Entity<WorkNameRow>().HasIndex(new[] { "WorkId", "Ordinal" }, "IX_WorkName_workId_ordinal_all").IsUnique(false);
        modelBuilder.Entity<WorkLinkRow>().HasIndex(new[] { "WorkId" }, "IX_WorkLink_workId_isPrimary1").IsUnique(true).HasFilter("isPrimary=1");
        modelBuilder.Entity<WorkLinkRow>().HasIndex(new[] { "WorkId", "Status" }, "IX_WorkLink_workId_status_all").IsUnique(false);
        modelBuilder.Entity<SeasonRow>().HasIndex(new[] { "WorkId", "Number" }, "IX_Season_workId_number_all").IsUnique(true);
        modelBuilder.Entity<SeasonRow>().HasIndex(new[] { "MappingStatus", "RefreshedAt" }, "IX_Season_mappingStatus_refreshedAt_all").IsUnique(false);
        modelBuilder.Entity<EpisodeRow>().HasIndex(new[] { "SeasonId", "Number" }, "IX_Episode_seasonId_number_mappingStatusunavailable").IsUnique(true).HasFilter("mappingStatus <> 'unavailable'");
        modelBuilder.Entity<EpisodeRow>().HasIndex(new[] { "Provider", "ProviderEpisodeId" }, "IX_Episode_provider_providerEpisodeId_providerEpisodeIdISNOTNULL").IsUnique(true).HasFilter("providerEpisodeId IS NOT NULL");
        modelBuilder.Entity<EpisodeRow>().HasIndex(new[] { "AirAt" }, "IX_Episode_airAt_all").IsUnique(false);
        modelBuilder.Entity<EpisodeRow>().HasIndex(new[] { "SeasonId", "AbsoluteNumber" }, "IX_Episode_seasonId_absoluteNumber_all").IsUnique(false);
        modelBuilder.Entity<MetadataCacheRow>().HasIndex(new[] { "Kind", "CacheKey" }, "IX_MetadataCache_kind_cacheKey_all").IsUnique(true);
        modelBuilder.Entity<MetadataCacheRow>().HasIndex(new[] { "ExpiresAt" }, "IX_MetadataCache_expiresAt_all").IsUnique(false);
        modelBuilder.Entity<WorkPreferenceRow>().HasIndex(new[] { "WorkId" }, "IX_WorkPreference_workId_all").IsUnique(true);
        modelBuilder.Entity<TargetRow>().HasIndex(new[] { "WorkId" }, "IX_Target_workId_episodeIdISNULL").IsUnique(true).HasFilter("episodeId IS NULL");
        modelBuilder.Entity<TargetRow>().HasIndex(new[] { "EpisodeId" }, "IX_Target_episodeId_episodeIdISNOTNULL").IsUnique(true).HasFilter("episodeId IS NOT NULL");
        modelBuilder.Entity<TargetRow>().HasIndex(new[] { "State", "NextTryAt", "Rank" }, "IX_Target_state_nextTryAt_rank_all").IsUnique(false);
        modelBuilder.Entity<TargetRow>().HasIndex(new[] { "BatchId" }, "IX_Target_batchId_all").IsUnique(false);
        modelBuilder.Entity<TargetRow>().HasIndex(new[] { "ChosenReleaseHash" }, "IX_Target_chosenReleaseHash_all").IsUnique(false);
        modelBuilder.Entity<ScopeIntentRow>().HasIndex(new[] { "State", "NextTryAt" }, "IX_ScopeIntent_state_nextTryAt_all").IsUnique(false);
        modelBuilder.Entity<ScopeIntentRow>().HasIndex(new[] { "WorkId" }, "IX_ScopeIntent_workId_all").IsUnique(false);
        modelBuilder.Entity<ScopeIntentRow>().HasIndex(new[] { "BatchId" }, "IX_ScopeIntent_batchId_all").IsUnique(false);
        modelBuilder.Entity<RawIntentRow>().HasIndex(new[] { "DownloadId" }, "IX_RawIntent_downloadId_downloadIdISNOTNULL").IsUnique(true).HasFilter("downloadId IS NOT NULL");
        modelBuilder.Entity<RawIntentRow>().HasIndex(new[] { "State", "NextTryAt" }, "IX_RawIntent_state_nextTryAt_all").IsUnique(false);
        modelBuilder.Entity<RawIntentRow>().HasIndex(new[] { "ReleaseHash" }, "IX_RawIntent_releaseHash_all").IsUnique(false);
        modelBuilder.Entity<RequestRow>().HasIndex(new[] { "UserId", "Decision", "CreatedAt" }, "IX_Request_userId_decision_createdAt_all").IsUnique(false);
        modelBuilder.Entity<RequestRow>().HasIndex(new[] { "WorkId", "Decision" }, "IX_Request_workId_decision_all").IsUnique(false);
        modelBuilder.Entity<RequestItemRow>().HasIndex(new[] { "TargetId" }, "IX_RequestItem_targetId_all").IsUnique(false);
        modelBuilder.Entity<RequestItemRow>().HasIndex(new[] { "RequestId", "Settlement" }, "IX_RequestItem_requestId_settlement_all").IsUnique(false);
        modelBuilder.Entity<FollowRow>().HasIndex(new[] { "WorkId" }, "IX_Follow_workId_all").IsUnique(true);
        modelBuilder.Entity<FollowRow>().HasIndex(new[] { "Enabled", "LastMaterializedAt" }, "IX_Follow_enabled_lastMaterializedAt_all").IsUnique(false);
        modelBuilder.Entity<WatchItemRow>().HasIndex(new[] { "UserId", "WorkId" }, "IX_WatchItem_userId_workId_all").IsUnique(true);
        modelBuilder.Entity<WatchItemRow>().HasIndex(new[] { "UpgradeWatch" }, "IX_WatchItem_upgradeWatch_all").IsUnique(false);
        modelBuilder.Entity<AutoRuleRow>().HasIndex(new[] { "UserId", "Enabled", "LastRunAt" }, "IX_AutoRule_userId_enabled_lastRunAt_all").IsUnique(false);
        modelBuilder.Entity<ReleaseRow>().HasIndex(new[] { "LastSeenAt" }, "IX_Release_lastSeenAt_all").IsUnique(false);
        modelBuilder.Entity<ReleaseObservationRow>().HasIndex(new[] { "Hash", "SourceId", "Query" }, "IX_ReleaseObservation_hash_sourceId_query_all").IsUnique(true);
        modelBuilder.Entity<ReleaseObservationRow>().HasIndex(new[] { "SourceId", "ObservedAt" }, "IX_ReleaseObservation_sourceId_observedAt_all").IsUnique(false);
        modelBuilder.Entity<VerdictRow>().HasIndex(new[] { "ExpiresAt" }, "IX_Verdict_expiresAt_all").IsUnique(false);
        modelBuilder.Entity<VerdictRow>().HasIndex(new[] { "CheckedAt" }, "IX_Verdict_checkedAt_all").IsUnique(false);
        modelBuilder.Entity<AttemptRow>().HasIndex(new[] { "TargetId", "StartedAt" }, "IX_Attempt_targetId_startedAt_all").IsUnique(false);
        modelBuilder.Entity<AttemptRow>().HasIndex(new[] { "WorkId", "StartedAt" }, "IX_Attempt_workId_startedAt_all").IsUnique(false);
        modelBuilder.Entity<AttemptRow>().HasIndex(new[] { "ActorUserId", "StartedAt" }, "IX_Attempt_actorUserId_startedAt_all").IsUnique(false);
        modelBuilder.Entity<AttemptRow>().HasIndex(new[] { "ReleaseHash" }, "IX_Attempt_releaseHash_all").IsUnique(false);
        modelBuilder.Entity<AttemptRow>().HasIndex(new[] { "DownloadId" }, "IX_Attempt_downloadId_kindswapANDendedAtISNULL").IsUnique(true).HasFilter("kind='swap' AND endedAt IS NULL");
        modelBuilder.Entity<AttemptRow>().HasIndex(new[] { "Kind", "EndedAt", "DeadlineAt" }, "IX_Attempt_kind_endedAt_deadlineAt_all").IsUnique(false);
        modelBuilder.Entity<BlockRow>().HasIndex(new[] { "Until" }, "IX_Block_until_all").IsUnique(false);
        modelBuilder.Entity<BlockRow>().HasIndex(new[] { "WorkKey" }, "IX_Block_workKey_all").IsUnique(false);
        modelBuilder.Entity<SearchCacheRow>().HasIndex(new[] { "NormalizedQuery", "ScopeKey", "SourceId", "SourceRevision", "CredentialRevision", "ParserVersion" }, "IX_SearchCache_normalizedQuery_scopeKey_sourceId_sourceRevision_credentialRevision_parserVersion_all").IsUnique(true);
        modelBuilder.Entity<SearchCacheRow>().HasIndex(new[] { "NormalizedQuery", "ExpiresAt" }, "IX_SearchCache_normalizedQuery_expiresAt_all").IsUnique(false);
        modelBuilder.Entity<SearchCacheRow>().HasIndex(new[] { "ExpiresAt" }, "IX_SearchCache_expiresAt_all").IsUnique(false);
        modelBuilder.Entity<DownloadRow>().HasIndex(new[] { "Hash" }, "IX_Download_hash_all").IsUnique(true);
        modelBuilder.Entity<DownloadRow>().HasIndex(new[] { "AdmissionToken" }, "IX_Download_admissionToken_all").IsUnique(true);
        modelBuilder.Entity<DownloadRow>().HasIndex(new[] { "Intent", "AddedAt" }, "IX_Download_intent_addedAt_all").IsUnique(false);
        modelBuilder.Entity<DownloadTargetRow>().HasIndex(new[] { "DownloadId", "TargetId" }, "IX_DownloadTarget_downloadId_targetId_all").IsUnique(true);
        modelBuilder.Entity<DownloadTargetRow>().HasIndex(new[] { "TargetId" }, "IX_DownloadTarget_targetId_rolecurrent").IsUnique(true).HasFilter("role='current'");
        modelBuilder.Entity<DownloadTargetRow>().HasIndex(new[] { "TargetId" }, "IX_DownloadTarget_targetId_rolereplacement").IsUnique(true).HasFilter("role='replacement'");
        modelBuilder.Entity<DownloadTargetRow>().HasIndex(new[] { "DownloadId", "Role" }, "IX_DownloadTarget_downloadId_role_all").IsUnique(false);
        modelBuilder.Entity<DownloadFileRow>().HasIndex(new[] { "DownloadId", "FileIndex" }, "IX_DownloadFile_downloadId_fileIndex_all").IsUnique(true);
        modelBuilder.Entity<DownloadFileRow>().HasIndex(new[] { "PhysicalKey" }, "IX_DownloadFile_physicalKey_physicalKeyISNOTNULL").IsUnique(true).HasFilter("physicalKey IS NOT NULL");
        modelBuilder.Entity<DownloadFileRow>().HasIndex(new[] { "TargetId" }, "IX_DownloadFile_targetId_all").IsUnique(false);
        modelBuilder.Entity<DownloadFileRow>().HasIndex(new[] { "MediaFileId" }, "IX_DownloadFile_mediaFileId_all").IsUnique(false);
        modelBuilder.Entity<StorageRootRow>().HasIndex(new[] { "PhysicalKey" }, "IX_StorageRoot_physicalKey_all").IsUnique(true);
        modelBuilder.Entity<StorageRootRow>().HasIndex(new[] { "Enabled", "Priority" }, "IX_StorageRoot_enabled_priority_all").IsUnique(false);
        modelBuilder.Entity<WorkFolderRow>().HasIndex(new[] { "WorkId" }, "IX_WorkFolder_workId_all").IsUnique(true);
        modelBuilder.Entity<WorkFolderRow>().HasIndex(new[] { "RootId", "RelativeItemFolder" }, "IX_WorkFolder_rootId_relativeItemFolder_rootIdISNOTNULL").IsUnique(true).HasFilter("rootId IS NOT NULL");
        modelBuilder.Entity<WorkFolderRow>().HasIndex(new[] { "ExternalItemFolder" }, "IX_WorkFolder_externalItemFolder_externalItemFolderISNOTNULL").IsUnique(true).HasFilter("externalItemFolder IS NOT NULL");
        modelBuilder.Entity<MediaFileRow>().HasIndex(new[] { "PhysicalKey" }, "IX_MediaFile_physicalKey_all").IsUnique(true);
        modelBuilder.Entity<MediaFileRow>().HasIndex(new[] { "DownloadId", "FileIndex" }, "IX_MediaFile_downloadId_fileIndex_downloadIdISNOTNULL").IsUnique(true).HasFilter("downloadId IS NOT NULL");
        modelBuilder.Entity<MediaFileRow>().HasIndex(new[] { "WorkId", "EpisodeId", "Status" }, "IX_MediaFile_workId_episodeId_status_all").IsUnique(false);
        modelBuilder.Entity<MediaFileRow>().HasIndex(new[] { "RootId", "Status" }, "IX_MediaFile_rootId_status_all").IsUnique(false);
        modelBuilder.Entity<MediaFileRow>().HasIndex(new[] { "ParentMediaFileId" }, "IX_MediaFile_parentMediaFileId_all").IsUnique(false);
        modelBuilder.Entity<MediaFileRow>().HasIndex(new[] { "MissingSince" }, "IX_MediaFile_missingSince_all").IsUnique(false);
        modelBuilder.Entity<FileOperationRow>().HasIndex(new[] { "State", "NextTryAt" }, "IX_FileOperation_state_nextTryAt_all").IsUnique(false);
        modelBuilder.Entity<FileOperationRow>().HasIndex(new[] { "DownloadId" }, "IX_FileOperation_downloadId_all").IsUnique(false);
        modelBuilder.Entity<FileOperationRow>().HasIndex(new[] { "MediaFileId" }, "IX_FileOperation_mediaFileId_all").IsUnique(false);
        modelBuilder.Entity<FilePathClaimRow>().HasIndex(new[] { "PhysicalKey" }, "IX_FilePathClaim_physicalKey_all").IsUnique(true);
        modelBuilder.Entity<FilePathClaimRow>().HasIndex(new[] { "OperationId" }, "IX_FilePathClaim_operationId_all").IsUnique(false);
        modelBuilder.Entity<UserRow>().HasIndex(new[] { "NormalizedEmail" }, "IX_User_normalizedEmail_normalizedEmailISNOTNULL").IsUnique(true).HasFilter("normalizedEmail IS NOT NULL");
        modelBuilder.Entity<UserRow>().HasIndex(new[] { "Role" }, "IX_User_role_roleowner").IsUnique(true).HasFilter("role='owner'");
        modelBuilder.Entity<NotificationRow>().HasIndex(new[] { "UserId", "DedupeKey" }, "IX_Notification_userId_dedupeKey_dedupeKeyISNOTNULL").IsUnique(true).HasFilter("dedupeKey IS NOT NULL");
        modelBuilder.Entity<NotificationRow>().HasIndex(new[] { "UserId", "CreatedAt" }, "IX_Notification_userId_createdAt_all").IsUnique(false);
        modelBuilder.Entity<NotificationRow>().HasIndex(new[] { "PushPending", "PushAttemptAt" }, "IX_Notification_pushPending_pushAttemptAt_all").IsUnique(false);
        modelBuilder.Entity<WorkNameRow>().HasOne<WorkRow>().WithMany().HasForeignKey(row => row.WorkId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_WorkName_Work_workId");
        modelBuilder.Entity<WorkNameRow>().HasOne<WorkLinkRow>().WithMany().HasForeignKey(row => row.LinkId)
            .OnDelete(DeleteBehavior.Cascade).HasConstraintName("FK_WorkName_WorkLink_linkId");
        modelBuilder.Entity<WorkLinkRow>().HasOne<WorkRow>().WithMany().HasForeignKey(row => row.WorkId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_WorkLink_Work_workId");
        modelBuilder.Entity<WorkLinkRow>().HasOne<SeasonRow>().WithMany().HasForeignKey(row => row.SeasonId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_WorkLink_Season_seasonId");
        modelBuilder.Entity<SeasonRow>().HasOne<WorkRow>().WithMany().HasForeignKey(row => row.WorkId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Season_Work_workId");
        modelBuilder.Entity<EpisodeRow>().HasOne<SeasonRow>().WithMany().HasForeignKey(row => row.SeasonId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Episode_Season_seasonId");
        modelBuilder.Entity<WorkPreferenceRow>().HasOne<WorkRow>().WithMany().HasForeignKey(row => row.WorkId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_WorkPreference_Work_workId");
        modelBuilder.Entity<WorkPreferenceRow>().HasOne<StorageRootRow>().WithMany().HasForeignKey(row => row.StorageRootOverrideId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_WorkPreference_StorageRoot_storageRootOverrideId");
        modelBuilder.Entity<TargetRow>().HasOne<WorkRow>().WithMany().HasForeignKey(row => row.WorkId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Target_Work_workId");
        modelBuilder.Entity<TargetRow>().HasOne<EpisodeRow>().WithMany().HasForeignKey(row => row.EpisodeId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Target_Episode_episodeId");
        modelBuilder.Entity<TargetRow>().HasOne<UserRow>().WithMany().HasForeignKey(row => row.CreatedBy)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Target_User_createdBy");
        modelBuilder.Entity<TargetRow>().HasOne<AutoRuleRow>().WithMany().HasForeignKey(row => row.AutoRuleId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Target_AutoRule_autoRuleId");
        modelBuilder.Entity<TargetRow>().HasOne<ReleaseRow>().WithMany().HasForeignKey(row => row.ChosenReleaseHash)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Target_Release_chosenReleaseHash");
        modelBuilder.Entity<TargetRow>().HasOne<MediaFileRow>().WithMany().HasForeignKey(row => row.ReplaceMediaFileId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Target_MediaFile_replaceMediaFileId");
        modelBuilder.Entity<ScopeIntentRow>().HasOne<UserRow>().WithMany().HasForeignKey(row => row.ActorUserId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_ScopeIntent_User_actorUserId");
        modelBuilder.Entity<ScopeIntentRow>().HasOne<WorkRow>().WithMany().HasForeignKey(row => row.WorkId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_ScopeIntent_Work_workId");
        modelBuilder.Entity<RawIntentRow>().HasOne<UserRow>().WithMany().HasForeignKey(row => row.ActorUserId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_RawIntent_User_actorUserId");
        modelBuilder.Entity<RawIntentRow>().HasOne<ReleaseRow>().WithMany().HasForeignKey(row => row.ReleaseHash)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_RawIntent_Release_releaseHash");
        modelBuilder.Entity<RawIntentRow>().HasOne<DownloadRow>().WithMany().HasForeignKey(row => row.DownloadId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_RawIntent_Download_downloadId");
        modelBuilder.Entity<RawIntentRow>().HasOne<StorageRootRow>().WithMany().HasForeignKey(row => row.RootId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_RawIntent_StorageRoot_rootId");
        modelBuilder.Entity<RequestRow>().HasOne<UserRow>().WithMany().HasForeignKey(row => row.UserId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Request_User_userId");
        modelBuilder.Entity<RequestRow>().HasOne<WorkRow>().WithMany().HasForeignKey(row => row.WorkId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Request_Work_workId");
        modelBuilder.Entity<RequestRow>().HasOne<UserRow>().WithMany().HasForeignKey(row => row.DecidedBy)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Request_User_decidedBy");
        modelBuilder.Entity<RequestItemRow>().HasOne<RequestRow>().WithMany().HasForeignKey(row => row.RequestId)
            .OnDelete(DeleteBehavior.Cascade).HasConstraintName("FK_RequestItem_Request_requestId");
        modelBuilder.Entity<RequestItemRow>().HasOne<EpisodeRow>().WithMany().HasForeignKey(row => row.EpisodeId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_RequestItem_Episode_episodeId");
        modelBuilder.Entity<RequestItemRow>().HasOne<TargetRow>().WithMany().HasForeignKey(row => row.TargetId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_RequestItem_Target_targetId");
        modelBuilder.Entity<FollowRow>().HasOne<WorkRow>().WithMany().HasForeignKey(row => row.WorkId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Follow_Work_workId");
        modelBuilder.Entity<FollowRow>().HasOne<EpisodeRow>().WithMany().HasForeignKey(row => row.FromEpisodeId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Follow_Episode_fromEpisodeId");
        modelBuilder.Entity<WatchItemRow>().HasOne<UserRow>().WithMany().HasForeignKey(row => row.UserId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_WatchItem_User_userId");
        modelBuilder.Entity<WatchItemRow>().HasOne<WorkRow>().WithMany().HasForeignKey(row => row.WorkId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_WatchItem_Work_workId");
        modelBuilder.Entity<AutoRuleRow>().HasOne<UserRow>().WithMany().HasForeignKey(row => row.UserId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_AutoRule_User_userId");
        modelBuilder.Entity<AutoRuleRow>().HasOne<ReleaseRow>().WithMany().HasForeignKey(row => row.LastMatchHash)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_AutoRule_Release_lastMatchHash");
        modelBuilder.Entity<ReleaseObservationRow>().HasOne<ReleaseRow>().WithMany().HasForeignKey(row => row.Hash)
            .OnDelete(DeleteBehavior.Cascade).HasConstraintName("FK_ReleaseObservation_Release_hash");
        modelBuilder.Entity<VerdictRow>().HasOne<ReleaseRow>().WithMany().HasForeignKey(row => row.Id)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Verdict_Release_hash");
        modelBuilder.Entity<AttemptRow>().HasOne<TargetRow>().WithMany().HasForeignKey(row => row.TargetId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Attempt_Target_targetId");
        modelBuilder.Entity<AttemptRow>().HasOne<WorkRow>().WithMany().HasForeignKey(row => row.WorkId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Attempt_Work_workId");
        modelBuilder.Entity<AttemptRow>().HasOne<ReleaseRow>().WithMany().HasForeignKey(row => row.ReleaseHash)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Attempt_Release_releaseHash");
        modelBuilder.Entity<AttemptRow>().HasOne<UserRow>().WithMany().HasForeignKey(row => row.ActorUserId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Attempt_User_actorUserId");
        modelBuilder.Entity<AttemptRow>().HasOne<DownloadRow>().WithMany().HasForeignKey(row => row.DownloadId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Attempt_Download_downloadId");
        modelBuilder.Entity<DownloadRow>().HasOne<ReleaseRow>().WithMany().HasForeignKey(row => row.Hash)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Download_Release_hash");
        modelBuilder.Entity<DownloadRow>().HasOne<StorageRootRow>().WithMany().HasForeignKey(row => row.RootId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Download_StorageRoot_rootId");
        modelBuilder.Entity<DownloadRow>().HasOne<RawIntentRow>().WithMany().HasForeignKey(row => row.RawIntentId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Download_RawIntent_rawIntentId");
        modelBuilder.Entity<DownloadTargetRow>().HasOne<DownloadRow>().WithMany().HasForeignKey(row => row.DownloadId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_DownloadTarget_Download_downloadId");
        modelBuilder.Entity<DownloadTargetRow>().HasOne<TargetRow>().WithMany().HasForeignKey(row => row.TargetId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_DownloadTarget_Target_targetId");
        modelBuilder.Entity<DownloadFileRow>().HasOne<DownloadRow>().WithMany().HasForeignKey(row => row.DownloadId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_DownloadFile_Download_downloadId");
        modelBuilder.Entity<DownloadFileRow>().HasOne<TargetRow>().WithMany().HasForeignKey(row => row.TargetId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_DownloadFile_Target_targetId");
        modelBuilder.Entity<DownloadFileRow>().HasOne<MediaFileRow>().WithMany().HasForeignKey(row => row.MediaFileId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_DownloadFile_MediaFile_mediaFileId");
        modelBuilder.Entity<WorkFolderRow>().HasOne<WorkRow>().WithMany().HasForeignKey(row => row.WorkId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_WorkFolder_Work_workId");
        modelBuilder.Entity<WorkFolderRow>().HasOne<StorageRootRow>().WithMany().HasForeignKey(row => row.RootId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_WorkFolder_StorageRoot_rootId");
        modelBuilder.Entity<MediaFileRow>().HasOne<WorkRow>().WithMany().HasForeignKey(row => row.WorkId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_MediaFile_Work_workId");
        modelBuilder.Entity<MediaFileRow>().HasOne<EpisodeRow>().WithMany().HasForeignKey(row => row.EpisodeId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_MediaFile_Episode_episodeId");
        modelBuilder.Entity<MediaFileRow>().HasOne<StorageRootRow>().WithMany().HasForeignKey(row => row.RootId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_MediaFile_StorageRoot_rootId");
        modelBuilder.Entity<MediaFileRow>().HasOne<MediaFileRow>().WithMany().HasForeignKey(row => row.ParentMediaFileId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_MediaFile_MediaFile_parentMediaFileId");
        modelBuilder.Entity<MediaFileRow>().HasOne<DownloadRow>().WithMany().HasForeignKey(row => row.DownloadId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_MediaFile_Download_downloadId");
        modelBuilder.Entity<FileOperationRow>().HasOne<TargetRow>().WithMany().HasForeignKey(row => row.TargetId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_FileOperation_Target_targetId");
        modelBuilder.Entity<FileOperationRow>().HasOne<DownloadRow>().WithMany().HasForeignKey(row => row.DownloadId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_FileOperation_Download_downloadId");
        modelBuilder.Entity<FileOperationRow>().HasOne<MediaFileRow>().WithMany().HasForeignKey(row => row.MediaFileId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_FileOperation_MediaFile_mediaFileId");
        modelBuilder.Entity<FilePathClaimRow>().HasOne<FileOperationRow>().WithMany().HasForeignKey(row => row.OperationId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_FilePathClaim_FileOperation_operationId");
        modelBuilder.Entity<NotificationRow>().HasOne<UserRow>().WithMany().HasForeignKey(row => row.UserId)
            .OnDelete(DeleteBehavior.Restrict).HasConstraintName("FK_Notification_User_userId");
    }

    private static ValueConverter<TEnum, string> EnumStringConverter<TEnum>() where TEnum : struct, Enum =>
        new(value => value.ToString().ToLowerInvariant(), value => Enum.Parse<TEnum>(value, true));

    private static ValueConverter<TEnum?, string?> NullableEnumStringConverter<TEnum>() where TEnum : struct, Enum =>
        new(value => value.HasValue ? value.Value.ToString().ToLowerInvariant() : null,
            value => value == null ? (TEnum?)null : Enum.Parse<TEnum>(value, true));

    private static ValueConverter<DateTimeOffset, string> DateTimeOffsetStringConverter() =>
        new(value => value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
            value => DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind));

    private static ValueConverter<DateTimeOffset?, string?> NullableDateTimeOffsetConverter() =>
        new(value => value.HasValue ? value.Value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture) : null,
            value => value == null ? (DateTimeOffset?)null :
                DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind));

    private static ValueConverter<TValue, string> JsonValueConverter<TValue>() =>
        new(value => StoreJson.Serialize(value), value => StoreJson.Deserialize<TValue>(value)!);

    private static ValueComparer<TValue> JsonValueComparer<TValue>() =>
        new((left, right) => StoreJson.Serialize(left) == StoreJson.Serialize(right),
            value => StoreJson.Serialize(value).GetHashCode(),
            value => StoreJson.Deserialize<TValue>(StoreJson.Serialize(value))!);
}

internal sealed class StoreDesignFactory : IDesignTimeDbContextFactory<TorrentFlowDbContext>
{
    public TorrentFlowDbContext CreateDbContext(string[] args) =>
        new(new DbContextOptionsBuilder<TorrentFlowDbContext>().UseSqlite("Data Source=:memory:").Options);
}
