using System.Collections.Immutable;
using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.Metadata;
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

    protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    {
        configurationBuilder.Properties<DateTimeOffset>().HaveConversion<IsoDateTimeOffsetConverter>();
        configurationBuilder.Properties<DateTimeOffset?>().HaveConversion<NullableIsoDateTimeOffsetConverter>();
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Ignore<StoreRow>();
        var jsonProperties = new HashSet<(Type EntityType, string Property)>();
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
        Json(work.Property(row => row.Genres));
        work.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<WorkNameRow>().ToTable("WorkName", table =>
        {
            table.HasCheckConstraint("CK_WorkName_label", "\"label\" IN ('english','romaji','synonym','native','original')");
            table.HasCheckConstraint("CK_WorkName_ordinal", "\"ordinal\" >= 0");
            table.HasCheckConstraint("CK_WorkName_authoritative", "\"authoritative\" IN (0,1)");
            table.HasCheckConstraint("CK_WorkName_nonblank", "length(trim(value)) > 0 AND length(trim(normalizedValue)) > 0");
        });
        modelBuilder.Entity<WorkLinkRow>().ToTable("WorkLink", table =>
        {
            table.HasCheckConstraint("CK_WorkLink_status", "\"status\" IN ('verified','suggested','rejected')");
            table.HasCheckConstraint("CK_WorkLink_isPrimary", "\"isPrimary\" IN (0,1)");
            table.HasCheckConstraint("CK_WorkLink_confidence", "confidence <= 1");
        });
        modelBuilder.Entity<SeasonRow>().ToTable("Season", table =>
        {
            table.HasCheckConstraint("CK_Season_number", "\"number\" >= 0");
            table.HasCheckConstraint("CK_Season_mappingStatus", "\"mappingStatus\" IN ('confirmed','provisional','unavailable')");
            table.HasCheckConstraint("CK_Season_expectedEpisodeCount", "\"expectedEpisodeCount\" >= 0");
            table.HasCheckConstraint("CK_Season_version", "\"version\" >= 0");
        });
        var season = modelBuilder.Entity<SeasonRow>();
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
        episode.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<MetadataCacheRow>().ToTable("MetadataCache", table =>
        {
            table.HasCheckConstraint("CK_MetadataCache_kind", "\"kind\" IN ('providerdetail','titlesearch','browserail','fribbmap','jellyfinstate')");
            table.HasCheckConstraint("CK_MetadataCache_payloadJson", "json_valid(\"payloadJson\")");
            table.HasCheckConstraint("CK_MetadataCache_complete", "\"complete\" IN (0,1)");
        });
        var metadataCache = modelBuilder.Entity<MetadataCacheRow>();
        Json(metadataCache.Property(row => row.Payload));
        modelBuilder.Entity<WorkPreferenceRow>().ToTable("WorkPreference", table =>
        {
            table.HasCheckConstraint("CK_WorkPreference_resolutionFloor", "\"resolutionFloor\" >= 0");
            table.HasCheckConstraint("CK_WorkPreference_preferredResolution", "\"preferredResolution\" >= 0");
            table.HasCheckConstraint("CK_WorkPreference_maxBytesPerItem", "\"maxBytesPerItem\" >= 0");
            table.HasCheckConstraint("CK_WorkPreference_version", "\"version\" >= 0");
        });
        var workPreference = modelBuilder.Entity<WorkPreferenceRow>();
        workPreference.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<TargetRow>().ToTable("Target", table =>
        {
            table.HasCheckConstraint("CK_Target_kind", "\"kind\" IN ('acquire','replace')");
            table.HasCheckConstraint("CK_Target_state", "\"state\" IN ('wanted','searching','fetching','filing','done','waiting','removed')");
            table.HasCheckConstraint("CK_Target_resumeState", "\"resumeState\" IN ('wanted','searching','fetching','filing','done','waiting','removed')");
            table.HasCheckConstraint("CK_Target_reasonCode", "\"reasonCode\" IN ('notreleased','metadataunavailable','noresults','rejectedcandidates','nohealthyrelease','sourcecooldown','sourcefailure','waitingforseeders','downloadcap','downloadwindow','nodrivespace','driveoffline','filebusy','mappinguncertain','ownerpickrequired','recoverymissing','paused')");
            table.HasCheckConstraint("CK_Target_resolutionFloor", "\"resolutionFloor\" >= 0");
            table.HasCheckConstraint("CK_Target_preferredResolution", "\"preferredResolution\" >= 0");
            table.HasCheckConstraint("CK_Target_maxBytes", "\"maxBytes\" >= 0");
            table.HasCheckConstraint("CK_Target_origin", "\"origin\" IN ('owner','request','rule','follow','upgrade','hunter')");
            table.HasCheckConstraint("CK_Target_substantiveMisses", "\"substantiveMisses\" >= 0");
            table.HasCheckConstraint("CK_Target_version", "\"version\" >= 0");
            table.HasCheckConstraint("CK_Target_downloadNow", "\"downloadNow\" IN (0,1)");
            table.HasCheckConstraint("CK_Target_minListedSeeders", "\"minListedSeeders\" >= 0");
            table.HasCheckConstraint("CK_Target_replacementMode", "(kind='acquire' AND replacementMode IS NULL) OR (kind='replace' AND replacementMode IS NOT NULL)");
        });
        var target = modelBuilder.Entity<TargetRow>();
        target.Property(row => row.Version).IsConcurrencyToken();
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
        Json(scopeIntent.Property(row => row.ScopeData));
        Json(scopeIntent.Property(row => row.Policy));
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
        Json(rawIntent.Property(row => row.SelectedFiles));
        rawIntent.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<RequestRow>().ToTable("Request", table =>
        {
            table.HasCheckConstraint("CK_Request_scope", "\"scope\" IN ('film','episodes','seasons','series')");
            table.HasCheckConstraint("CK_Request_scopeJson", "json_valid(\"scopeJson\")");
            table.HasCheckConstraint("CK_Request_decision", "\"decision\" IN ('pending','approved','declined','cancelled')");
            table.HasCheckConstraint("CK_Request_version", "\"version\" >= 0");
        });
        var request = modelBuilder.Entity<RequestRow>();
        Json(request.Property(row => row.ScopeData));
        request.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<RequestItemRow>().ToTable("RequestItem", table =>
        {
            table.HasCheckConstraint("CK_RequestItem_settlement", "\"settlement\" IN ('open','fulfilled','stoppedbyowner')");
        });
        modelBuilder.Entity<FollowRow>().ToTable("Follow", table =>
        {
            table.HasCheckConstraint("CK_Follow_enabled", "\"enabled\" IN (0,1)");
            table.HasCheckConstraint("CK_Follow_version", "\"version\" >= 0");
        });
        var follow = modelBuilder.Entity<FollowRow>();
        follow.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<WatchItemRow>().ToTable("WatchItem", table =>
        {
            table.HasCheckConstraint("CK_WatchItem_status", "\"status\" IN ('watching','planned','completed','dropped')");
            table.HasCheckConstraint("CK_WatchItem_upgradeWatch", "\"upgradeWatch\" IN (0,1)");
            table.HasCheckConstraint("CK_WatchItem_version", "\"version\" >= 0");
        });
        var watchItem = modelBuilder.Entity<WatchItemRow>();
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
        Json(autoRule.Property(row => row.SourceIds));
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
        Json(release.Property(row => row.Parsed));
        Json(release.Property(row => row.Files));
        modelBuilder.Entity<ReleaseObservationRow>().ToTable("ReleaseObservation", table =>
        {
            table.HasCheckConstraint("CK_ReleaseObservation_listedSeeders", "\"listedSeeders\" >= 0");
            table.HasCheckConstraint("CK_ReleaseObservation_listedLeechers", "\"listedLeechers\" >= 0");
            table.HasCheckConstraint("CK_ReleaseObservation_webSeedsJson", "json_valid(\"webSeedsJson\")");
        });
        var releaseObservation = modelBuilder.Entity<ReleaseObservationRow>();
        Json(releaseObservation.Property(row => row.WebSeeds));
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
        Json(verdict.Property(row => row.ProbeMetrics));
        modelBuilder.Entity<AttemptRow>().ToTable("Attempt", table =>
        {
            table.HasCheckConstraint("CK_Attempt_kind", "\"kind\" IN ('search','check','plan','fetch','file','swap','legacyevent')");
            table.HasCheckConstraint("CK_Attempt_decisionJson", "json_valid(\"decisionJson\")");
            table.HasCheckConstraint("CK_Attempt_legacyContextJson", "json_valid(\"legacyContextJson\")");
            table.HasCheckConstraint("CK_Attempt_swapJson", "json_valid(\"swapJson\")");
        });
        var attempt = modelBuilder.Entity<AttemptRow>();
        Json(attempt.Property(row => row.Decision));
        Json(attempt.Property(row => row.LegacyContext));
        Json(attempt.Property(row => row.Swap));
        modelBuilder.Entity<BlockRow>().ToTable("Block", table =>
        {
            table.HasCheckConstraint("CK_Block_origin", "\"origin\" IN ('owner','unsafe','foreign','stalled','swap')");
        });
        modelBuilder.Entity<SearchCacheRow>().ToTable("SearchCache", table =>
        {
            table.HasCheckConstraint("CK_SearchCache_sourceRevision", "\"sourceRevision\" >= 0");
            table.HasCheckConstraint("CK_SearchCache_credentialRevision", "\"credentialRevision\" >= 0");
            table.HasCheckConstraint("CK_SearchCache_parserVersion", "\"parserVersion\" >= 0");
            table.HasCheckConstraint("CK_SearchCache_payloadJson", "json_valid(\"payloadJson\")");
            table.HasCheckConstraint("CK_SearchCache_complete", "\"complete\" IN (0,1)");
        });
        var searchCache = modelBuilder.Entity<SearchCacheRow>();
        Json(searchCache.Property(row => row.Payload));
        modelBuilder.Entity<DownloadRow>().ToTable("Download", table =>
        {
            table.HasCheckConstraint("CK_Download_intent", "\"intent\" IN ('run','queued','paused','stopped')");
            table.HasCheckConstraint("CK_Download_version", "\"version\" >= 0");
        });
        var download = modelBuilder.Entity<DownloadRow>();
        download.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<DownloadTargetRow>().ToTable("DownloadTarget", table =>
        {
            table.HasCheckConstraint("CK_DownloadTarget_role", "\"role\" IN ('current','replacement','retired')");
        });
        modelBuilder.Entity<DownloadFileRow>().ToTable("DownloadFile", table =>
        {
            table.HasCheckConstraint("CK_DownloadFile_fileIndex", "\"fileIndex\" >= 0");
            table.HasCheckConstraint("CK_DownloadFile_selected", "\"selected\" IN (0,1)");
            table.HasCheckConstraint("CK_DownloadFile_role", "\"role\" IN ('video','subtitle','audio','unwanted')");
            table.HasCheckConstraint("CK_DownloadFile_expectedBytes", "\"expectedBytes\" >= 0");
            table.HasCheckConstraint("CK_DownloadFile_filed", "\"filed\" IN (0,1)");
        });
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
        Json(storageRoot.Property(row => row.Kinds));
        Json(storageRoot.Property(row => row.LibraryFolders));
        storageRoot.Property(row => row.Version).IsConcurrencyToken();
        modelBuilder.Entity<WorkFolderRow>().ToTable("WorkFolder", table =>
        {
            table.HasCheckConstraint("CK_WorkFolder_version", "\"version\" >= 0");
            table.HasCheckConstraint("CK_WorkFolder_shape", "(rootId IS NOT NULL AND relativeItemFolder IS NOT NULL AND externalItemFolder IS NULL) OR (rootId IS NULL AND relativeItemFolder IS NULL AND externalItemFolder IS NOT NULL)");
        });
        var workFolder = modelBuilder.Entity<WorkFolderRow>();
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
        Json(mediaFile.Property(row => row.Tracks));
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
        modelBuilder.Entity<FilePathClaimRow>().ToTable("FilePathClaim");
        modelBuilder.Entity<UserRow>().ToTable("User", table =>
        {
            table.HasCheckConstraint("CK_User_role", "\"role\" IN ('owner','requester')");
        });
        modelBuilder.Entity<NotificationRow>().ToTable("Notification", table =>
        {
            table.HasCheckConstraint("CK_Notification_pushPending", "\"pushPending\" IN (0,1)");
            table.HasCheckConstraint("CK_Notification_pushAttempts", "\"pushAttempts\" >= 0");
            table.HasCheckConstraint("CK_Notification_length", "length(title) <= 200 AND (body IS NULL OR length(body) <= 500)");
        });
        modelBuilder.Entity<SettingRow>().ToTable("Setting", table =>
        {
            table.HasCheckConstraint("CK_Setting_schemaVersion", "\"schemaVersion\" >= 0");
            table.HasCheckConstraint("CK_Setting_valueJson", "json_valid(\"valueJson\")");
            table.HasCheckConstraint("CK_Setting_revision", "\"revision\" >= 0");
            table.HasCheckConstraint("CK_Setting_section", "section IN ('engine','sources','metadata','remoteAccess','desktop','quality','requests','scheduler','jellyfin','recovery') AND schemaVersion=1");
        });
        var setting = modelBuilder.Entity<SettingRow>();
        Json(setting.Property(row => row.Value));
        setting.Property(row => row.Revision).IsConcurrencyToken();
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
        modelBuilder.Entity<TargetRow>().HasIndex(new[] { "State", "NextTryAt", "CreatedAt" }, "IX_Target_state_nextTryAt_createdAt_all").IsUnique(false);
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

        foreach (var entity in modelBuilder.Model.GetEntityTypes())
        {
            var tableName = entity.GetTableName();
            if (tableName is null) continue;
            foreach (var property in entity.GetProperties())
            {
                var json = jsonProperties.Contains((entity.ClrType, property.Name));
                var columnName = property.Name switch
                {
                    nameof(StoreRow.Id) => tableName switch
                    {
                        "Release" or "Verdict" => "hash",
                        "Setting" => "section",
                        _ => "id",
                    },
                    nameof(RequestRow.ScopeData) => "scopeJson",
                    nameof(StorageRootRow.LibraryFolders) => "libraryFoldersJson",
                    _ => char.ToLowerInvariant(property.Name[0]) + property.Name[1..] + (json ? "Json" : ""),
                };

                if (property.Name == nameof(StoreRow.Id))
                    property.SetColumnName(columnName, StoreObjectIdentifier.Table(tableName, entity.GetSchema()));
                else
                    property.SetColumnName(columnName);
                var enumType = Nullable.GetUnderlyingType(property.ClrType) ?? property.ClrType;
                if (enumType.IsEnum) property.SetValueConverter(EnumConverter(property.ClrType));
            }
        }

        void Json<TValue>(PropertyBuilder<TValue> property)
        {
            property.HasConversion(JsonValueConverter<TValue>());
            property.Metadata.SetValueComparer(JsonValueComparer<TValue>());
            jsonProperties.Add((property.Metadata.DeclaringType.ClrType, property.Metadata.Name));
        }
    }

    private static ValueConverter EnumConverter(Type propertyType)
    {
        var nullableType = Nullable.GetUnderlyingType(propertyType);
        var converterName = nullableType is null
            ? nameof(EnumStringConverter)
            : nameof(NullableEnumStringConverter);
        var enumType = nullableType ?? propertyType;
        var factory = typeof(TorrentFlowDbContext).GetMethod(converterName,
            BindingFlags.NonPublic | BindingFlags.Static)!;
        return (ValueConverter)factory.MakeGenericMethod(enumType).Invoke(null, null)!;
    }

    private static ValueConverter<TEnum, string> EnumStringConverter<TEnum>() where TEnum : struct, Enum =>
        new(value => value.ToString().ToLowerInvariant(), value => Enum.Parse<TEnum>(value, true));

    private static ValueConverter<TEnum?, string?> NullableEnumStringConverter<TEnum>() where TEnum : struct, Enum =>
        new(value => value.HasValue ? value.Value.ToString().ToLowerInvariant() : null,
            value => value == null ? (TEnum?)null : Enum.Parse<TEnum>(value, true));

    private static ValueConverter<TValue, string> JsonValueConverter<TValue>() =>
        new(value => StoreJson.Serialize(value), value => StoreJson.Deserialize<TValue>(value)!);

    private static ValueComparer<TValue> JsonValueComparer<TValue>() =>
        new((left, right) => StoreJson.Serialize(left) == StoreJson.Serialize(right),
            value => StoreJson.Serialize(value).GetHashCode(),
            value => StoreJson.Deserialize<TValue>(StoreJson.Serialize(value))!);

    private sealed class IsoDateTimeOffsetConverter : ValueConverter<DateTimeOffset, string>
    {
        public IsoDateTimeOffsetConverter() : base(
            value => value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
            value => DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind)) { }
    }

    private sealed class NullableIsoDateTimeOffsetConverter : ValueConverter<DateTimeOffset?, string?>
    {
        public NullableIsoDateTimeOffsetConverter() : base(
            value => value.HasValue ? value.Value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture) : null,
            value => value == null ? (DateTimeOffset?)null :
                DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind)) { }
    }
}

internal sealed class StoreDesignFactory : IDesignTimeDbContextFactory<TorrentFlowDbContext>
{
    public TorrentFlowDbContext CreateDbContext(string[] args) =>
        new(new DbContextOptionsBuilder<TorrentFlowDbContext>().UseSqlite("Data Source=:memory:").Options);
}
