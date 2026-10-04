using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Store.Migrations
{
    /// <inheritdoc />
    public partial class InitialSchema : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Block",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    hash = table.Column<string>(type: "TEXT", nullable: false),
                    workKey = table.Column<string>(type: "TEXT", nullable: true),
                    reason = table.Column<string>(type: "TEXT", nullable: false),
                    origin = table.Column<string>(type: "TEXT", nullable: false),
                    replacedByHash = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    until = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Block", x => x.id);
                    table.CheckConstraint("CK_Block_origin", "\"origin\" IN ('owner','unsafe','foreign','stalled','swap')");
                });

            migrationBuilder.CreateTable(
                name: "MetadataCache",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    kind = table.Column<string>(type: "TEXT", nullable: false),
                    cacheKey = table.Column<string>(type: "TEXT", nullable: false),
                    payloadJson = table.Column<string>(type: "TEXT", nullable: false),
                    fetchedAt = table.Column<string>(type: "TEXT", nullable: false),
                    expiresAt = table.Column<string>(type: "TEXT", nullable: false),
                    etag = table.Column<string>(type: "TEXT", nullable: true),
                    lastModified = table.Column<string>(type: "TEXT", nullable: true),
                    complete = table.Column<bool>(type: "INTEGER", nullable: false),
                    provider = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MetadataCache", x => x.id);
                    table.CheckConstraint("CK_MetadataCache_complete", "\"complete\" IN (0,1)");
                    table.CheckConstraint("CK_MetadataCache_kind", "\"kind\" IN ('providerdetail','titlesearch','browserail','fribbmap','jellyfinstate')");
                    table.CheckConstraint("CK_MetadataCache_payloadJson", "json_valid(\"payloadJson\")");
                });

            migrationBuilder.CreateTable(
                name: "Release",
                columns: table => new
                {
                    hash = table.Column<string>(type: "TEXT", nullable: false),
                    name = table.Column<string>(type: "TEXT", nullable: false),
                    parsedJson = table.Column<string>(type: "TEXT", nullable: false),
                    totalBytes = table.Column<long>(type: "INTEGER", nullable: true),
                    torrentUri = table.Column<string>(type: "TEXT", nullable: true),
                    magnet = table.Column<string>(type: "TEXT", nullable: true),
                    filesJson = table.Column<string>(type: "TEXT", nullable: true),
                    metadataDigest = table.Column<string>(type: "TEXT", nullable: true),
                    @private = table.Column<bool>(name: "private", type: "INTEGER", nullable: true),
                    firstSeenAt = table.Column<string>(type: "TEXT", nullable: false),
                    lastSeenAt = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Release", x => x.hash);
                    table.CheckConstraint("CK_Release_filesJson", "json_valid(\"filesJson\")");
                    table.CheckConstraint("CK_Release_hash", "length(hash) IN (40,64) AND hash NOT GLOB '*[^0-9a-f]*'");
                    table.CheckConstraint("CK_Release_parsedJson", "json_valid(\"parsedJson\")");
                    table.CheckConstraint("CK_Release_private", "\"private\" IN (0,1)");
                    table.CheckConstraint("CK_Release_totalBytes", "\"totalBytes\" >= 0");
                });

            migrationBuilder.CreateTable(
                name: "SearchCache",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    normalizedQuery = table.Column<string>(type: "TEXT", nullable: false),
                    scopeKey = table.Column<string>(type: "TEXT", nullable: false),
                    sourceId = table.Column<string>(type: "TEXT", nullable: false),
                    sourceRevision = table.Column<long>(type: "INTEGER", nullable: false),
                    credentialRevision = table.Column<long>(type: "INTEGER", nullable: false),
                    parserVersion = table.Column<int>(type: "INTEGER", nullable: false),
                    payloadJson = table.Column<string>(type: "TEXT", nullable: false),
                    complete = table.Column<bool>(type: "INTEGER", nullable: false),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    expiresAt = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SearchCache", x => x.id);
                    table.CheckConstraint("CK_SearchCache_complete", "\"complete\" IN (0,1)");
                    table.CheckConstraint("CK_SearchCache_credentialRevision", "\"credentialRevision\" >= 0");
                    table.CheckConstraint("CK_SearchCache_parserVersion", "\"parserVersion\" >= 0");
                    table.CheckConstraint("CK_SearchCache_payloadJson", "json_valid(\"payloadJson\")");
                    table.CheckConstraint("CK_SearchCache_sourceRevision", "\"sourceRevision\" >= 0");
                });

            migrationBuilder.CreateTable(
                name: "Setting",
                columns: table => new
                {
                    section = table.Column<string>(type: "TEXT", nullable: false),
                    schemaVersion = table.Column<int>(type: "INTEGER", nullable: false),
                    valueJson = table.Column<string>(type: "TEXT", nullable: false),
                    revision = table.Column<long>(type: "INTEGER", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Setting", x => x.section);
                    table.CheckConstraint("CK_Setting_revision", "\"revision\" >= 0");
                    table.CheckConstraint("CK_Setting_schemaVersion", "\"schemaVersion\" >= 0");
                    table.CheckConstraint("CK_Setting_section", "section IN ('engine','sources','metadata','remoteAccess','desktop','quality','requests','scheduler','jellyfin','recovery') AND schemaVersion=1");
                    table.CheckConstraint("CK_Setting_valueJson", "json_valid(\"valueJson\")");
                });

            migrationBuilder.CreateTable(
                name: "StorageRoot",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    path = table.Column<string>(type: "TEXT", nullable: false),
                    physicalKey = table.Column<string>(type: "TEXT", nullable: false),
                    kindsJson = table.Column<string>(type: "TEXT", nullable: false),
                    libraryFoldersJson = table.Column<string>(type: "TEXT", nullable: false),
                    volumeSerial = table.Column<string>(type: "TEXT", nullable: false),
                    priority = table.Column<int>(type: "INTEGER", nullable: false),
                    reserveBytes = table.Column<long>(type: "INTEGER", nullable: false),
                    maxAllocatedBytes = table.Column<long>(type: "INTEGER", nullable: true),
                    enabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    online = table.Column<bool>(type: "INTEGER", nullable: false),
                    reviewRequired = table.Column<bool>(type: "INTEGER", nullable: false),
                    lastCheckedAt = table.Column<string>(type: "TEXT", nullable: true),
                    lastError = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false),
                    version = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StorageRoot", x => x.id);
                    table.CheckConstraint("CK_StorageRoot_enabled", "\"enabled\" IN (0,1)");
                    table.CheckConstraint("CK_StorageRoot_kindsJson", "json_valid(\"kindsJson\")");
                    table.CheckConstraint("CK_StorageRoot_libraryFoldersJson", "json_valid(\"libraryFoldersJson\")");
                    table.CheckConstraint("CK_StorageRoot_maxAllocatedBytes", "\"maxAllocatedBytes\" >= 0");
                    table.CheckConstraint("CK_StorageRoot_online", "\"online\" IN (0,1)");
                    table.CheckConstraint("CK_StorageRoot_reserveBytes", "\"reserveBytes\" >= 0");
                    table.CheckConstraint("CK_StorageRoot_reviewRequired", "\"reviewRequired\" IN (0,1)");
                    table.CheckConstraint("CK_StorageRoot_version", "\"version\" >= 0");
                });

            migrationBuilder.CreateTable(
                name: "User",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    normalizedEmail = table.Column<string>(type: "TEXT", nullable: true),
                    name = table.Column<string>(type: "TEXT", nullable: true),
                    image = table.Column<string>(type: "TEXT", nullable: true),
                    role = table.Column<string>(type: "TEXT", nullable: false),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_User", x => x.id);
                    table.CheckConstraint("CK_User_role", "\"role\" IN ('owner','requester')");
                });

            migrationBuilder.CreateTable(
                name: "Work",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    workKey = table.Column<string>(type: "TEXT", nullable: false),
                    kind = table.Column<string>(type: "TEXT", nullable: false),
                    format = table.Column<string>(type: "TEXT", nullable: false),
                    anime = table.Column<bool>(type: "INTEGER", nullable: true),
                    year = table.Column<int>(type: "INTEGER", nullable: true),
                    originalLanguage = table.Column<string>(type: "TEXT", nullable: true),
                    runtimeMinutes = table.Column<int>(type: "INTEGER", nullable: true),
                    posterUrl = table.Column<string>(type: "TEXT", nullable: true),
                    backdropUrl = table.Column<string>(type: "TEXT", nullable: true),
                    synopsis = table.Column<string>(type: "TEXT", nullable: true),
                    rating = table.Column<double>(type: "REAL", nullable: true),
                    ratingSource = table.Column<string>(type: "TEXT", nullable: true),
                    genresJson = table.Column<string>(type: "TEXT", nullable: false),
                    theatricalAt = table.Column<string>(type: "TEXT", nullable: true),
                    digitalAt = table.Column<string>(type: "TEXT", nullable: true),
                    physicalAt = table.Column<string>(type: "TEXT", nullable: true),
                    releasePrecision = table.Column<string>(type: "TEXT", nullable: false),
                    providerStatus = table.Column<string>(type: "TEXT", nullable: true),
                    numberingVersion = table.Column<string>(type: "TEXT", nullable: true),
                    refreshedAt = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false),
                    version = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Work", x => x.id);
                    table.CheckConstraint("CK_Work_anime", "\"anime\" IN (0,1)");
                    table.CheckConstraint("CK_Work_format", "\"format\" IN ('unknown','movie','series','special')");
                    table.CheckConstraint("CK_Work_genresJson", "json_valid(\"genresJson\")");
                    table.CheckConstraint("CK_Work_kind", "\"kind\" IN ('unknown','film','series')");
                    table.CheckConstraint("CK_Work_rating", "rating IS NULL OR rating <= 10");
                    table.CheckConstraint("CK_Work_releasePrecision", "\"releasePrecision\" IN ('unknown','day','instant')");
                    table.CheckConstraint("CK_Work_runtimeMinutes", "\"runtimeMinutes\" >= 0");
                    table.CheckConstraint("CK_Work_version", "\"version\" >= 0");
                    table.CheckConstraint("CK_Work_year", "\"year\" >= 0");
                });

            migrationBuilder.CreateTable(
                name: "ReleaseObservation",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    hash = table.Column<string>(type: "TEXT", nullable: false),
                    sourceId = table.Column<string>(type: "TEXT", nullable: false),
                    sourceItemId = table.Column<string>(type: "TEXT", nullable: true),
                    query = table.Column<string>(type: "TEXT", nullable: false),
                    listedSeeders = table.Column<int>(type: "INTEGER", nullable: true),
                    listedLeechers = table.Column<int>(type: "INTEGER", nullable: true),
                    uploadedAt = table.Column<string>(type: "TEXT", nullable: true),
                    observedAt = table.Column<string>(type: "TEXT", nullable: false),
                    torrentUri = table.Column<string>(type: "TEXT", nullable: true),
                    webSeedsJson = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ReleaseObservation", x => x.id);
                    table.CheckConstraint("CK_ReleaseObservation_listedLeechers", "\"listedLeechers\" >= 0");
                    table.CheckConstraint("CK_ReleaseObservation_listedSeeders", "\"listedSeeders\" >= 0");
                    table.CheckConstraint("CK_ReleaseObservation_webSeedsJson", "json_valid(\"webSeedsJson\")");
                    table.ForeignKey(
                        name: "FK_ReleaseObservation_Release_hash",
                        column: x => x.hash,
                        principalTable: "Release",
                        principalColumn: "hash",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "Verdict",
                columns: table => new
                {
                    hash = table.Column<string>(type: "TEXT", nullable: false),
                    band = table.Column<string>(type: "TEXT", nullable: false),
                    connectedPeers = table.Column<int>(type: "INTEGER", nullable: false),
                    connectedSeeders = table.Column<int>(type: "INTEGER", nullable: false),
                    bytesDelivered = table.Column<long>(type: "INTEGER", nullable: false),
                    sampleMilliseconds = table.Column<int>(type: "INTEGER", nullable: false),
                    scrapedSeeders = table.Column<int>(type: "INTEGER", nullable: true),
                    reason = table.Column<string>(type: "TEXT", nullable: false),
                    checkedAt = table.Column<string>(type: "TEXT", nullable: false),
                    expiresAt = table.Column<string>(type: "TEXT", nullable: false),
                    probeVersion = table.Column<int>(type: "INTEGER", nullable: false),
                    byteSendingPeers = table.Column<int>(type: "INTEGER", nullable: false),
                    probeMetricsJson = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Verdict", x => x.hash);
                    table.CheckConstraint("CK_Verdict_band", "\"band\" IN ('good','weak','dead','unknown')");
                    table.CheckConstraint("CK_Verdict_bytesDelivered", "\"bytesDelivered\" >= 0");
                    table.CheckConstraint("CK_Verdict_byteSendingPeers", "\"byteSendingPeers\" >= 0");
                    table.CheckConstraint("CK_Verdict_connectedPeers", "\"connectedPeers\" >= 0");
                    table.CheckConstraint("CK_Verdict_connectedSeeders", "\"connectedSeeders\" >= 0");
                    table.CheckConstraint("CK_Verdict_probeMetricsJson", "json_valid(\"probeMetricsJson\")");
                    table.CheckConstraint("CK_Verdict_probeVersion", "\"probeVersion\" >= 0");
                    table.CheckConstraint("CK_Verdict_sampleMilliseconds", "\"sampleMilliseconds\" >= 0");
                    table.CheckConstraint("CK_Verdict_scrapedSeeders", "\"scrapedSeeders\" >= 0");
                    table.ForeignKey(
                        name: "FK_Verdict_Release_hash",
                        column: x => x.hash,
                        principalTable: "Release",
                        principalColumn: "hash",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "AutoRule",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    name = table.Column<string>(type: "TEXT", nullable: false),
                    query = table.Column<string>(type: "TEXT", nullable: false),
                    category = table.Column<string>(type: "TEXT", nullable: false),
                    minListedSeeders = table.Column<int>(type: "INTEGER", nullable: false),
                    maxBytes = table.Column<long>(type: "INTEGER", nullable: true),
                    resolutionFloor = table.Column<int>(type: "INTEGER", nullable: true),
                    sourceIdsJson = table.Column<string>(type: "TEXT", nullable: false),
                    enabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    lastRunAt = table.Column<string>(type: "TEXT", nullable: true),
                    lastMatchHash = table.Column<string>(type: "TEXT", nullable: true),
                    matchCount = table.Column<int>(type: "INTEGER", nullable: false),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false),
                    version = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AutoRule", x => x.id);
                    table.CheckConstraint("CK_AutoRule_enabled", "\"enabled\" IN (0,1)");
                    table.CheckConstraint("CK_AutoRule_matchCount", "\"matchCount\" >= 0");
                    table.CheckConstraint("CK_AutoRule_maxBytes", "\"maxBytes\" >= 0");
                    table.CheckConstraint("CK_AutoRule_minListedSeeders", "\"minListedSeeders\" >= 0");
                    table.CheckConstraint("CK_AutoRule_resolutionFloor", "\"resolutionFloor\" >= 0");
                    table.CheckConstraint("CK_AutoRule_sourceIdsJson", "json_valid(\"sourceIdsJson\")");
                    table.CheckConstraint("CK_AutoRule_version", "\"version\" >= 0");
                    table.ForeignKey(
                        name: "FK_AutoRule_Release_lastMatchHash",
                        column: x => x.lastMatchHash,
                        principalTable: "Release",
                        principalColumn: "hash",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_AutoRule_User_userId",
                        column: x => x.userId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Notification",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    kind = table.Column<string>(type: "TEXT", nullable: false),
                    title = table.Column<string>(type: "TEXT", nullable: false),
                    body = table.Column<string>(type: "TEXT", nullable: true),
                    link = table.Column<string>(type: "TEXT", nullable: true),
                    dedupeKey = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    readAt = table.Column<string>(type: "TEXT", nullable: true),
                    pushPending = table.Column<bool>(type: "INTEGER", nullable: false),
                    pushAttemptAt = table.Column<string>(type: "TEXT", nullable: true),
                    pushAttempts = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Notification", x => x.id);
                    table.CheckConstraint("CK_Notification_length", "length(title) <= 200 AND (body IS NULL OR length(body) <= 500)");
                    table.CheckConstraint("CK_Notification_pushAttempts", "\"pushAttempts\" >= 0");
                    table.CheckConstraint("CK_Notification_pushPending", "\"pushPending\" IN (0,1)");
                    table.ForeignKey(
                        name: "FK_Notification_User_userId",
                        column: x => x.userId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Request",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: false),
                    scope = table.Column<string>(type: "TEXT", nullable: false),
                    scopeJson = table.Column<string>(type: "TEXT", nullable: false),
                    note = table.Column<string>(type: "TEXT", nullable: true),
                    decision = table.Column<string>(type: "TEXT", nullable: false),
                    decisionReason = table.Column<string>(type: "TEXT", nullable: true),
                    decidedAt = table.Column<string>(type: "TEXT", nullable: true),
                    decidedBy = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false),
                    version = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Request", x => x.id);
                    table.CheckConstraint("CK_Request_decision", "\"decision\" IN ('pending','approved','declined','cancelled')");
                    table.CheckConstraint("CK_Request_scope", "\"scope\" IN ('film','episodes','seasons','series')");
                    table.CheckConstraint("CK_Request_scopeJson", "json_valid(\"scopeJson\")");
                    table.CheckConstraint("CK_Request_version", "\"version\" >= 0");
                    table.ForeignKey(
                        name: "FK_Request_User_decidedBy",
                        column: x => x.decidedBy,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Request_User_userId",
                        column: x => x.userId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Request_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "ScopeIntent",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    actorUserId = table.Column<string>(type: "TEXT", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: false),
                    scope = table.Column<string>(type: "TEXT", nullable: false),
                    scopeJson = table.Column<string>(type: "TEXT", nullable: false),
                    policyJson = table.Column<string>(type: "TEXT", nullable: false),
                    now = table.Column<bool>(type: "INTEGER", nullable: false),
                    batchId = table.Column<string>(type: "TEXT", nullable: false),
                    state = table.Column<string>(type: "TEXT", nullable: false),
                    nextTryAt = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false),
                    version = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ScopeIntent", x => x.id);
                    table.CheckConstraint("CK_ScopeIntent_now", "\"now\" IN (0,1)");
                    table.CheckConstraint("CK_ScopeIntent_policyJson", "json_valid(\"policyJson\")");
                    table.CheckConstraint("CK_ScopeIntent_scope", "\"scope\" IN ('film','episodes','seasons','series')");
                    table.CheckConstraint("CK_ScopeIntent_scopeJson", "json_valid(\"scopeJson\")");
                    table.CheckConstraint("CK_ScopeIntent_state", "\"state\" IN ('pending','materialized','cancelled')");
                    table.CheckConstraint("CK_ScopeIntent_version", "\"version\" >= 0");
                    table.ForeignKey(
                        name: "FK_ScopeIntent_User_actorUserId",
                        column: x => x.actorUserId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_ScopeIntent_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Season",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: false),
                    number = table.Column<int>(type: "INTEGER", nullable: false),
                    title = table.Column<string>(type: "TEXT", nullable: true),
                    overview = table.Column<string>(type: "TEXT", nullable: true),
                    posterUrl = table.Column<string>(type: "TEXT", nullable: true),
                    mappingStatus = table.Column<string>(type: "TEXT", nullable: false),
                    providerEntryId = table.Column<string>(type: "TEXT", nullable: true),
                    expectedEpisodeCount = table.Column<int>(type: "INTEGER", nullable: true),
                    refreshedAt = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false),
                    version = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Season", x => x.id);
                    table.CheckConstraint("CK_Season_expectedEpisodeCount", "\"expectedEpisodeCount\" >= 0");
                    table.CheckConstraint("CK_Season_mappingStatus", "\"mappingStatus\" IN ('confirmed','provisional','unavailable')");
                    table.CheckConstraint("CK_Season_number", "\"number\" >= 0");
                    table.CheckConstraint("CK_Season_version", "\"version\" >= 0");
                    table.ForeignKey(
                        name: "FK_Season_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "WatchItem",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: false),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    upgradeWatch = table.Column<bool>(type: "INTEGER", nullable: false),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false),
                    version = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WatchItem", x => x.id);
                    table.CheckConstraint("CK_WatchItem_status", "\"status\" IN ('watching','planned','completed','dropped')");
                    table.CheckConstraint("CK_WatchItem_upgradeWatch", "\"upgradeWatch\" IN (0,1)");
                    table.CheckConstraint("CK_WatchItem_version", "\"version\" >= 0");
                    table.ForeignKey(
                        name: "FK_WatchItem_User_userId",
                        column: x => x.userId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_WatchItem_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "WorkFolder",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: false),
                    rootId = table.Column<string>(type: "TEXT", nullable: true),
                    relativeItemFolder = table.Column<string>(type: "TEXT", nullable: true),
                    externalItemFolder = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false),
                    version = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkFolder", x => x.id);
                    table.CheckConstraint("CK_WorkFolder_shape", "(rootId IS NOT NULL AND relativeItemFolder IS NOT NULL AND externalItemFolder IS NULL) OR (rootId IS NULL AND relativeItemFolder IS NULL AND externalItemFolder IS NOT NULL)");
                    table.CheckConstraint("CK_WorkFolder_version", "\"version\" >= 0");
                    table.ForeignKey(
                        name: "FK_WorkFolder_StorageRoot_rootId",
                        column: x => x.rootId,
                        principalTable: "StorageRoot",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_WorkFolder_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "WorkPreference",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: false),
                    resolutionFloor = table.Column<int>(type: "INTEGER", nullable: true),
                    preferredResolution = table.Column<int>(type: "INTEGER", nullable: true),
                    audioLanguage = table.Column<string>(type: "TEXT", nullable: true),
                    maxBytesPerItem = table.Column<long>(type: "INTEGER", nullable: true),
                    storageRootOverrideId = table.Column<string>(type: "TEXT", nullable: true),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false),
                    version = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkPreference", x => x.id);
                    table.CheckConstraint("CK_WorkPreference_maxBytesPerItem", "\"maxBytesPerItem\" >= 0");
                    table.CheckConstraint("CK_WorkPreference_preferredResolution", "\"preferredResolution\" >= 0");
                    table.CheckConstraint("CK_WorkPreference_resolutionFloor", "\"resolutionFloor\" >= 0");
                    table.CheckConstraint("CK_WorkPreference_version", "\"version\" >= 0");
                    table.ForeignKey(
                        name: "FK_WorkPreference_StorageRoot_storageRootOverrideId",
                        column: x => x.storageRootOverrideId,
                        principalTable: "StorageRoot",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_WorkPreference_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Episode",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    seasonId = table.Column<string>(type: "TEXT", nullable: false),
                    number = table.Column<int>(type: "INTEGER", nullable: false),
                    absoluteNumber = table.Column<int>(type: "INTEGER", nullable: true),
                    provider = table.Column<string>(type: "TEXT", nullable: true),
                    providerEpisodeId = table.Column<string>(type: "TEXT", nullable: true),
                    title = table.Column<string>(type: "TEXT", nullable: true),
                    synopsis = table.Column<string>(type: "TEXT", nullable: true),
                    stillUrl = table.Column<string>(type: "TEXT", nullable: true),
                    airAt = table.Column<string>(type: "TEXT", nullable: true),
                    airPrecision = table.Column<string>(type: "TEXT", nullable: false),
                    runtimeMinutes = table.Column<int>(type: "INTEGER", nullable: true),
                    mappingStatus = table.Column<string>(type: "TEXT", nullable: false),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false),
                    version = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Episode", x => x.id);
                    table.CheckConstraint("CK_Episode_absoluteNumber", "\"absoluteNumber\" >= 0");
                    table.CheckConstraint("CK_Episode_airPrecision", "\"airPrecision\" IN ('unknown','day','instant')");
                    table.CheckConstraint("CK_Episode_mappingStatus", "\"mappingStatus\" IN ('confirmed','provisional','unavailable')");
                    table.CheckConstraint("CK_Episode_number", "\"number\" >= 0");
                    table.CheckConstraint("CK_Episode_runtimeMinutes", "\"runtimeMinutes\" >= 0");
                    table.CheckConstraint("CK_Episode_version", "\"version\" >= 0");
                    table.ForeignKey(
                        name: "FK_Episode_Season_seasonId",
                        column: x => x.seasonId,
                        principalTable: "Season",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "WorkLink",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: false),
                    provider = table.Column<string>(type: "TEXT", nullable: false),
                    externalId = table.Column<string>(type: "TEXT", nullable: false),
                    providerKind = table.Column<string>(type: "TEXT", nullable: true),
                    seasonId = table.Column<string>(type: "TEXT", nullable: true),
                    source = table.Column<string>(type: "TEXT", nullable: false),
                    mappingVersion = table.Column<string>(type: "TEXT", nullable: true),
                    confidence = table.Column<double>(type: "REAL", nullable: false),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    isPrimary = table.Column<bool>(type: "INTEGER", nullable: false),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkLink", x => x.id);
                    table.CheckConstraint("CK_WorkLink_confidence", "confidence <= 1");
                    table.CheckConstraint("CK_WorkLink_isPrimary", "\"isPrimary\" IN (0,1)");
                    table.CheckConstraint("CK_WorkLink_status", "\"status\" IN ('verified','suggested','rejected')");
                    table.ForeignKey(
                        name: "FK_WorkLink_Season_seasonId",
                        column: x => x.seasonId,
                        principalTable: "Season",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_WorkLink_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Follow",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: false),
                    enabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    fromEpisodeId = table.Column<string>(type: "TEXT", nullable: true),
                    newEpisodesSince = table.Column<string>(type: "TEXT", nullable: false),
                    lastMaterializedAt = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false),
                    version = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Follow", x => x.id);
                    table.CheckConstraint("CK_Follow_enabled", "\"enabled\" IN (0,1)");
                    table.CheckConstraint("CK_Follow_version", "\"version\" >= 0");
                    table.ForeignKey(
                        name: "FK_Follow_Episode_fromEpisodeId",
                        column: x => x.fromEpisodeId,
                        principalTable: "Episode",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Follow_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "WorkName",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: false),
                    value = table.Column<string>(type: "TEXT", nullable: false),
                    normalizedValue = table.Column<string>(type: "TEXT", nullable: false),
                    label = table.Column<string>(type: "TEXT", nullable: false),
                    linkId = table.Column<string>(type: "TEXT", nullable: true),
                    ordinal = table.Column<int>(type: "INTEGER", nullable: false),
                    authoritative = table.Column<bool>(type: "INTEGER", nullable: false),
                    refreshedAt = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkName", x => x.id);
                    table.CheckConstraint("CK_WorkName_authoritative", "\"authoritative\" IN (0,1)");
                    table.CheckConstraint("CK_WorkName_label", "\"label\" IN ('english','romaji','synonym','native','original')");
                    table.CheckConstraint("CK_WorkName_nonblank", "length(trim(value)) > 0 AND length(trim(normalizedValue)) > 0");
                    table.CheckConstraint("CK_WorkName_ordinal", "\"ordinal\" >= 0");
                    table.ForeignKey(
                        name: "FK_WorkName_WorkLink_linkId",
                        column: x => x.linkId,
                        principalTable: "WorkLink",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_WorkName_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Attempt",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    targetId = table.Column<string>(type: "TEXT", nullable: true),
                    workId = table.Column<string>(type: "TEXT", nullable: true),
                    releaseHash = table.Column<string>(type: "TEXT", nullable: true),
                    actorUserId = table.Column<string>(type: "TEXT", nullable: true),
                    kind = table.Column<string>(type: "TEXT", nullable: false),
                    startedAt = table.Column<string>(type: "TEXT", nullable: false),
                    endedAt = table.Column<string>(type: "TEXT", nullable: true),
                    outcome = table.Column<string>(type: "TEXT", nullable: true),
                    reasonCode = table.Column<string>(type: "TEXT", nullable: true),
                    reasonText = table.Column<string>(type: "TEXT", nullable: true),
                    decisionJson = table.Column<string>(type: "TEXT", nullable: true),
                    legacyContextJson = table.Column<string>(type: "TEXT", nullable: true),
                    batchId = table.Column<string>(type: "TEXT", nullable: true),
                    downloadId = table.Column<string>(type: "TEXT", nullable: true),
                    deadlineAt = table.Column<string>(type: "TEXT", nullable: true),
                    swapJson = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Attempt", x => x.id);
                    table.CheckConstraint("CK_Attempt_decisionJson", "json_valid(\"decisionJson\")");
                    table.CheckConstraint("CK_Attempt_kind", "\"kind\" IN ('search','check','plan','fetch','file','swap','legacyevent')");
                    table.CheckConstraint("CK_Attempt_legacyContextJson", "json_valid(\"legacyContextJson\")");
                    table.CheckConstraint("CK_Attempt_swapJson", "json_valid(\"swapJson\")");
                    table.ForeignKey(
                        name: "FK_Attempt_Release_releaseHash",
                        column: x => x.releaseHash,
                        principalTable: "Release",
                        principalColumn: "hash",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Attempt_User_actorUserId",
                        column: x => x.actorUserId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Attempt_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Download",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    hash = table.Column<string>(type: "TEXT", nullable: false),
                    intent = table.Column<string>(type: "TEXT", nullable: false),
                    rootId = table.Column<string>(type: "TEXT", nullable: true),
                    addedAt = table.Column<string>(type: "TEXT", nullable: false),
                    finishedAt = table.Column<string>(type: "TEXT", nullable: true),
                    admissionToken = table.Column<string>(type: "TEXT", nullable: false),
                    resumeArtifact = table.Column<string>(type: "TEXT", nullable: true),
                    rawIntentId = table.Column<string>(type: "TEXT", nullable: true),
                    version = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Download", x => x.id);
                    table.CheckConstraint("CK_Download_intent", "\"intent\" IN ('run','queued','paused','stopped')");
                    table.CheckConstraint("CK_Download_version", "\"version\" >= 0");
                    table.ForeignKey(
                        name: "FK_Download_Release_hash",
                        column: x => x.hash,
                        principalTable: "Release",
                        principalColumn: "hash",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Download_StorageRoot_rootId",
                        column: x => x.rootId,
                        principalTable: "StorageRoot",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "MediaFile",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: false),
                    episodeId = table.Column<string>(type: "TEXT", nullable: true),
                    rootId = table.Column<string>(type: "TEXT", nullable: true),
                    path = table.Column<string>(type: "TEXT", nullable: false),
                    physicalKey = table.Column<string>(type: "TEXT", nullable: false),
                    role = table.Column<string>(type: "TEXT", nullable: false),
                    parentMediaFileId = table.Column<string>(type: "TEXT", nullable: true),
                    bytes = table.Column<long>(type: "INTEGER", nullable: false),
                    mtimeUtc = table.Column<string>(type: "TEXT", nullable: false),
                    resolution = table.Column<int>(type: "INTEGER", nullable: true),
                    source = table.Column<string>(type: "TEXT", nullable: true),
                    container = table.Column<string>(type: "TEXT", nullable: true),
                    videoCodec = table.Column<string>(type: "TEXT", nullable: true),
                    videoProfile = table.Column<string>(type: "TEXT", nullable: true),
                    width = table.Column<int>(type: "INTEGER", nullable: true),
                    height = table.Column<int>(type: "INTEGER", nullable: true),
                    hdr = table.Column<string>(type: "TEXT", nullable: true),
                    runtimeSeconds = table.Column<double>(type: "REAL", nullable: true),
                    bitrateBps = table.Column<long>(type: "INTEGER", nullable: true),
                    tracksJson = table.Column<string>(type: "TEXT", nullable: false),
                    origin = table.Column<string>(type: "TEXT", nullable: false),
                    downloadId = table.Column<string>(type: "TEXT", nullable: true),
                    fileIndex = table.Column<int>(type: "INTEGER", nullable: true),
                    addedAt = table.Column<string>(type: "TEXT", nullable: false),
                    lastSeenAt = table.Column<string>(type: "TEXT", nullable: true),
                    missingSince = table.Column<string>(type: "TEXT", nullable: true),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    missingConfirmedAt = table.Column<string>(type: "TEXT", nullable: true),
                    verifiedAt = table.Column<string>(type: "TEXT", nullable: true),
                    contentDigest = table.Column<string>(type: "TEXT", nullable: true),
                    version = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MediaFile", x => x.id);
                    table.CheckConstraint("CK_MediaFile_bitrateBps", "\"bitrateBps\" >= 0");
                    table.CheckConstraint("CK_MediaFile_bytes", "\"bytes\" >= 0");
                    table.CheckConstraint("CK_MediaFile_fileIndex", "\"fileIndex\" >= 0");
                    table.CheckConstraint("CK_MediaFile_height", "\"height\" >= 0");
                    table.CheckConstraint("CK_MediaFile_origin", "\"origin\" IN ('downloaded','imported','adopted')");
                    table.CheckConstraint("CK_MediaFile_resolution", "\"resolution\" >= 0");
                    table.CheckConstraint("CK_MediaFile_role", "role IN ('video','subtitle','audio')");
                    table.CheckConstraint("CK_MediaFile_runtimeSeconds", "\"runtimeSeconds\" >= 0");
                    table.CheckConstraint("CK_MediaFile_status", "\"status\" IN ('present','offline','missing')");
                    table.CheckConstraint("CK_MediaFile_tracksJson", "json_valid(\"tracksJson\")");
                    table.CheckConstraint("CK_MediaFile_version", "\"version\" >= 0");
                    table.CheckConstraint("CK_MediaFile_width", "\"width\" >= 0");
                    table.ForeignKey(
                        name: "FK_MediaFile_Download_downloadId",
                        column: x => x.downloadId,
                        principalTable: "Download",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_MediaFile_Episode_episodeId",
                        column: x => x.episodeId,
                        principalTable: "Episode",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_MediaFile_MediaFile_parentMediaFileId",
                        column: x => x.parentMediaFileId,
                        principalTable: "MediaFile",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_MediaFile_StorageRoot_rootId",
                        column: x => x.rootId,
                        principalTable: "StorageRoot",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_MediaFile_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "RawIntent",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    actorUserId = table.Column<string>(type: "TEXT", nullable: false),
                    releaseHash = table.Column<string>(type: "TEXT", nullable: false),
                    downloadId = table.Column<string>(type: "TEXT", nullable: true),
                    selectedFilesJson = table.Column<string>(type: "TEXT", nullable: false),
                    rootId = table.Column<string>(type: "TEXT", nullable: true),
                    explicitDirectory = table.Column<string>(type: "TEXT", nullable: true),
                    explicitKind = table.Column<string>(type: "TEXT", nullable: true),
                    state = table.Column<string>(type: "TEXT", nullable: false),
                    resumeState = table.Column<string>(type: "TEXT", nullable: true),
                    reasonCode = table.Column<string>(type: "TEXT", nullable: true),
                    reasonText = table.Column<string>(type: "TEXT", nullable: true),
                    nextTryAt = table.Column<string>(type: "TEXT", nullable: true),
                    nowAt = table.Column<string>(type: "TEXT", nullable: true),
                    ownerRanked = table.Column<bool>(type: "INTEGER", nullable: false),
                    rank = table.Column<long>(type: "INTEGER", nullable: false),
                    leaseUntil = table.Column<string>(type: "TEXT", nullable: true),
                    leaseToken = table.Column<string>(type: "TEXT", nullable: true),
                    batchId = table.Column<string>(type: "TEXT", nullable: false),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false),
                    version = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RawIntent", x => x.id);
                    table.CheckConstraint("CK_RawIntent_explicitKind", "\"explicitKind\" IN ('movies','tv','anime','animemovies')");
                    table.CheckConstraint("CK_RawIntent_ownerRanked", "\"ownerRanked\" IN (0,1)");
                    table.CheckConstraint("CK_RawIntent_reasonCode", "\"reasonCode\" IN ('notreleased','metadataunavailable','noresults','rejectedcandidates','nohealthyrelease','sourcecooldown','sourcefailure','waitingforseeders','downloadcap','downloadwindow','nodrivespace','driveoffline','filebusy','mappinguncertain','ownerpickrequired','recoverymissing')");
                    table.CheckConstraint("CK_RawIntent_resumeState", "\"resumeState\" IN ('wanted','checking','planning','fetching','filing','review','done','waiting','paused','removed')");
                    table.CheckConstraint("CK_RawIntent_selectedFilesJson", "json_valid(\"selectedFilesJson\")");
                    table.CheckConstraint("CK_RawIntent_state", "\"state\" IN ('wanted','checking','planning','fetching','filing','review','done','waiting','paused','removed')");
                    table.CheckConstraint("CK_RawIntent_version", "\"version\" >= 0");
                    table.ForeignKey(
                        name: "FK_RawIntent_Download_downloadId",
                        column: x => x.downloadId,
                        principalTable: "Download",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_RawIntent_Release_releaseHash",
                        column: x => x.releaseHash,
                        principalTable: "Release",
                        principalColumn: "hash",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_RawIntent_StorageRoot_rootId",
                        column: x => x.rootId,
                        principalTable: "StorageRoot",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_RawIntent_User_actorUserId",
                        column: x => x.actorUserId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Target",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: false),
                    episodeId = table.Column<string>(type: "TEXT", nullable: true),
                    kind = table.Column<string>(type: "TEXT", nullable: false),
                    state = table.Column<string>(type: "TEXT", nullable: false),
                    resumeState = table.Column<string>(type: "TEXT", nullable: true),
                    reasonCode = table.Column<string>(type: "TEXT", nullable: true),
                    reasonText = table.Column<string>(type: "TEXT", nullable: true),
                    nextTryAt = table.Column<string>(type: "TEXT", nullable: true),
                    expectedAt = table.Column<string>(type: "TEXT", nullable: true),
                    resolutionFloor = table.Column<int>(type: "INTEGER", nullable: true),
                    preferredResolution = table.Column<int>(type: "INTEGER", nullable: true),
                    audioLanguage = table.Column<string>(type: "TEXT", nullable: true),
                    maxBytes = table.Column<long>(type: "INTEGER", nullable: true),
                    ownerRanked = table.Column<bool>(type: "INTEGER", nullable: false),
                    rank = table.Column<long>(type: "INTEGER", nullable: false),
                    nowAt = table.Column<string>(type: "TEXT", nullable: true),
                    createdBy = table.Column<string>(type: "TEXT", nullable: false),
                    origin = table.Column<string>(type: "TEXT", nullable: false),
                    autoRuleId = table.Column<string>(type: "TEXT", nullable: true),
                    chosenReleaseHash = table.Column<string>(type: "TEXT", nullable: true),
                    replaceMediaFileId = table.Column<string>(type: "TEXT", nullable: true),
                    replacementMode = table.Column<string>(type: "TEXT", nullable: true),
                    batchId = table.Column<string>(type: "TEXT", nullable: true),
                    clickedAt = table.Column<string>(type: "TEXT", nullable: true),
                    substantiveMisses = table.Column<int>(type: "INTEGER", nullable: false),
                    helpNotifiedAt = table.Column<string>(type: "TEXT", nullable: true),
                    policyRevision = table.Column<long>(type: "INTEGER", nullable: false),
                    leaseUntil = table.Column<string>(type: "TEXT", nullable: true),
                    leaseToken = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false),
                    version = table.Column<long>(type: "INTEGER", nullable: false),
                    priority = table.Column<string>(type: "TEXT", nullable: false),
                    minListedSeeders = table.Column<int>(type: "INTEGER", nullable: true),
                    pickedReleaseHash = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Target", x => x.id);
                    table.CheckConstraint("CK_Target_kind", "\"kind\" IN ('acquire','replace')");
                    table.CheckConstraint("CK_Target_maxBytes", "\"maxBytes\" >= 0");
                    table.CheckConstraint("CK_Target_minListedSeeders", "\"minListedSeeders\" >= 0");
                    table.CheckConstraint("CK_Target_origin", "\"origin\" IN ('owner','request','rule','follow','upgrade','hunter')");
                    table.CheckConstraint("CK_Target_ownerRanked", "\"ownerRanked\" IN (0,1)");
                    table.CheckConstraint("CK_Target_policyRevision", "\"policyRevision\" >= 0");
                    table.CheckConstraint("CK_Target_preferredResolution", "\"preferredResolution\" >= 0");
                    table.CheckConstraint("CK_Target_priority", "\"priority\" IN ('now','ownerrank','freshrelease','request','backcatalogue','upgradewatch')");
                    table.CheckConstraint("CK_Target_reasonCode", "\"reasonCode\" IN ('notreleased','metadataunavailable','noresults','rejectedcandidates','nohealthyrelease','sourcecooldown','sourcefailure','waitingforseeders','downloadcap','downloadwindow','nodrivespace','driveoffline','filebusy','mappinguncertain','ownerpickrequired','recoverymissing')");
                    table.CheckConstraint("CK_Target_replacementMode", "(kind='acquire' AND replacementMode IS NULL) OR (kind='replace' AND replacementMode IS NOT NULL)");
                    table.CheckConstraint("CK_Target_resolutionFloor", "\"resolutionFloor\" >= 0");
                    table.CheckConstraint("CK_Target_resumeState", "\"resumeState\" IN ('wanted','finding','checking','planning','fetching','filing','done','waiting','paused','removed')");
                    table.CheckConstraint("CK_Target_state", "\"state\" IN ('wanted','finding','checking','planning','fetching','filing','done','waiting','paused','removed')");
                    table.CheckConstraint("CK_Target_substantiveMisses", "\"substantiveMisses\" >= 0");
                    table.CheckConstraint("CK_Target_version", "\"version\" >= 0");
                    table.ForeignKey(
                        name: "FK_Target_AutoRule_autoRuleId",
                        column: x => x.autoRuleId,
                        principalTable: "AutoRule",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Target_Episode_episodeId",
                        column: x => x.episodeId,
                        principalTable: "Episode",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Target_MediaFile_replaceMediaFileId",
                        column: x => x.replaceMediaFileId,
                        principalTable: "MediaFile",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Target_Release_chosenReleaseHash",
                        column: x => x.chosenReleaseHash,
                        principalTable: "Release",
                        principalColumn: "hash",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Target_User_createdBy",
                        column: x => x.createdBy,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Target_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "DownloadFile",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    downloadId = table.Column<string>(type: "TEXT", nullable: false),
                    fileIndex = table.Column<int>(type: "INTEGER", nullable: false),
                    selected = table.Column<bool>(type: "INTEGER", nullable: false),
                    targetId = table.Column<string>(type: "TEXT", nullable: true),
                    partialPath = table.Column<string>(type: "TEXT", nullable: true),
                    finalPath = table.Column<string>(type: "TEXT", nullable: true),
                    physicalKey = table.Column<string>(type: "TEXT", nullable: true),
                    mediaFileId = table.Column<string>(type: "TEXT", nullable: true),
                    role = table.Column<string>(type: "TEXT", nullable: false),
                    expectedBytes = table.Column<long>(type: "INTEGER", nullable: false),
                    enginePath = table.Column<string>(type: "TEXT", nullable: true),
                    filed = table.Column<bool>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DownloadFile", x => x.id);
                    table.CheckConstraint("CK_DownloadFile_expectedBytes", "\"expectedBytes\" >= 0");
                    table.CheckConstraint("CK_DownloadFile_filed", "\"filed\" IN (0,1)");
                    table.CheckConstraint("CK_DownloadFile_fileIndex", "\"fileIndex\" >= 0");
                    table.CheckConstraint("CK_DownloadFile_role", "\"role\" IN ('video','subtitle','audio','unwanted')");
                    table.CheckConstraint("CK_DownloadFile_selected", "\"selected\" IN (0,1)");
                    table.ForeignKey(
                        name: "FK_DownloadFile_Download_downloadId",
                        column: x => x.downloadId,
                        principalTable: "Download",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_DownloadFile_MediaFile_mediaFileId",
                        column: x => x.mediaFileId,
                        principalTable: "MediaFile",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_DownloadFile_Target_targetId",
                        column: x => x.targetId,
                        principalTable: "Target",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "DownloadTarget",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    downloadId = table.Column<string>(type: "TEXT", nullable: false),
                    targetId = table.Column<string>(type: "TEXT", nullable: false),
                    role = table.Column<string>(type: "TEXT", nullable: false),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DownloadTarget", x => x.id);
                    table.CheckConstraint("CK_DownloadTarget_role", "\"role\" IN ('current','replacement','retired')");
                    table.ForeignKey(
                        name: "FK_DownloadTarget_Download_downloadId",
                        column: x => x.downloadId,
                        principalTable: "Download",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_DownloadTarget_Target_targetId",
                        column: x => x.targetId,
                        principalTable: "Target",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "FileOperation",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    kind = table.Column<string>(type: "TEXT", nullable: false),
                    targetId = table.Column<string>(type: "TEXT", nullable: true),
                    downloadId = table.Column<string>(type: "TEXT", nullable: true),
                    mediaFileId = table.Column<string>(type: "TEXT", nullable: true),
                    sourcePath = table.Column<string>(type: "TEXT", nullable: true),
                    destinationPath = table.Column<string>(type: "TEXT", nullable: true),
                    expectedBytes = table.Column<long>(type: "INTEGER", nullable: true),
                    expectedDigest = table.Column<string>(type: "TEXT", nullable: true),
                    state = table.Column<string>(type: "TEXT", nullable: false),
                    deleteSource = table.Column<bool>(type: "INTEGER", nullable: false),
                    attempts = table.Column<int>(type: "INTEGER", nullable: false),
                    nextTryAt = table.Column<string>(type: "TEXT", nullable: true),
                    lastError = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false),
                    leaseToken = table.Column<string>(type: "TEXT", nullable: true),
                    leaseUntil = table.Column<string>(type: "TEXT", nullable: true),
                    resumeStage = table.Column<string>(type: "TEXT", nullable: true),
                    enginePermitToken = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FileOperation", x => x.id);
                    table.CheckConstraint("CK_FileOperation_attempts", "\"attempts\" >= 0");
                    table.CheckConstraint("CK_FileOperation_deleteSource", "\"deleteSource\" IN (0,1)");
                    table.CheckConstraint("CK_FileOperation_expectedBytes", "\"expectedBytes\" >= 0");
                    table.CheckConstraint("CK_FileOperation_kind", "\"kind\" IN ('rename','move','copy','delete','import','relocate')");
                    table.CheckConstraint("CK_FileOperation_resumeStage", "\"resumeStage\" IN ('pending','copied','verified','inventorycommitted','sourcedeleted','done','retry','needsowner','superseded')");
                    table.CheckConstraint("CK_FileOperation_state", "\"state\" IN ('pending','copied','verified','inventorycommitted','sourcedeleted','done','retry','needsowner','superseded')");
                    table.ForeignKey(
                        name: "FK_FileOperation_Download_downloadId",
                        column: x => x.downloadId,
                        principalTable: "Download",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_FileOperation_MediaFile_mediaFileId",
                        column: x => x.mediaFileId,
                        principalTable: "MediaFile",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_FileOperation_Target_targetId",
                        column: x => x.targetId,
                        principalTable: "Target",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "RequestItem",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    requestId = table.Column<string>(type: "TEXT", nullable: false),
                    episodeId = table.Column<string>(type: "TEXT", nullable: true),
                    targetId = table.Column<string>(type: "TEXT", nullable: true),
                    settlement = table.Column<string>(type: "TEXT", nullable: false),
                    settledAt = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RequestItem", x => x.id);
                    table.CheckConstraint("CK_RequestItem_settlement", "\"settlement\" IN ('open','fulfilled','stoppedbyowner')");
                    table.ForeignKey(
                        name: "FK_RequestItem_Episode_episodeId",
                        column: x => x.episodeId,
                        principalTable: "Episode",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_RequestItem_Request_requestId",
                        column: x => x.requestId,
                        principalTable: "Request",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_RequestItem_Target_targetId",
                        column: x => x.targetId,
                        principalTable: "Target",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "FilePathClaim",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    operationId = table.Column<string>(type: "TEXT", nullable: false),
                    physicalKey = table.Column<string>(type: "TEXT", nullable: false),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FilePathClaim", x => x.id);
                    table.ForeignKey(
                        name: "FK_FilePathClaim_FileOperation_operationId",
                        column: x => x.operationId,
                        principalTable: "FileOperation",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Attempt_actorUserId_startedAt_all",
                table: "Attempt",
                columns: new[] { "actorUserId", "startedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Attempt_downloadId_kindswapANDendedAtISNULL",
                table: "Attempt",
                column: "downloadId",
                unique: true,
                filter: "kind='swap' AND endedAt IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_Attempt_kind_endedAt_deadlineAt_all",
                table: "Attempt",
                columns: new[] { "kind", "endedAt", "deadlineAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Attempt_releaseHash_all",
                table: "Attempt",
                column: "releaseHash");

            migrationBuilder.CreateIndex(
                name: "IX_Attempt_targetId_startedAt_all",
                table: "Attempt",
                columns: new[] { "targetId", "startedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Attempt_workId_startedAt_all",
                table: "Attempt",
                columns: new[] { "workId", "startedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_AutoRule_lastMatchHash",
                table: "AutoRule",
                column: "lastMatchHash");

            migrationBuilder.CreateIndex(
                name: "IX_AutoRule_userId_enabled_lastRunAt_all",
                table: "AutoRule",
                columns: new[] { "userId", "enabled", "lastRunAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Block_until_all",
                table: "Block",
                column: "until");

            migrationBuilder.CreateIndex(
                name: "IX_Block_workKey_all",
                table: "Block",
                column: "workKey");

            migrationBuilder.CreateIndex(
                name: "IX_Download_admissionToken_all",
                table: "Download",
                column: "admissionToken",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Download_hash_all",
                table: "Download",
                column: "hash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Download_intent_addedAt_all",
                table: "Download",
                columns: new[] { "intent", "addedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Download_rawIntentId",
                table: "Download",
                column: "rawIntentId");

            migrationBuilder.CreateIndex(
                name: "IX_Download_rootId",
                table: "Download",
                column: "rootId");

            migrationBuilder.CreateIndex(
                name: "IX_DownloadFile_downloadId_fileIndex_all",
                table: "DownloadFile",
                columns: new[] { "downloadId", "fileIndex" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_DownloadFile_mediaFileId_all",
                table: "DownloadFile",
                column: "mediaFileId");

            migrationBuilder.CreateIndex(
                name: "IX_DownloadFile_physicalKey_physicalKeyISNOTNULL",
                table: "DownloadFile",
                column: "physicalKey",
                unique: true,
                filter: "physicalKey IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_DownloadFile_targetId_all",
                table: "DownloadFile",
                column: "targetId");

            migrationBuilder.CreateIndex(
                name: "IX_DownloadTarget_downloadId_role_all",
                table: "DownloadTarget",
                columns: new[] { "downloadId", "role" });

            migrationBuilder.CreateIndex(
                name: "IX_DownloadTarget_downloadId_targetId_all",
                table: "DownloadTarget",
                columns: new[] { "downloadId", "targetId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_DownloadTarget_targetId_rolecurrent",
                table: "DownloadTarget",
                column: "targetId",
                unique: true,
                filter: "role='current'");

            migrationBuilder.CreateIndex(
                name: "IX_DownloadTarget_targetId_rolereplacement",
                table: "DownloadTarget",
                column: "targetId",
                unique: true,
                filter: "role='replacement'");

            migrationBuilder.CreateIndex(
                name: "IX_Episode_airAt_all",
                table: "Episode",
                column: "airAt");

            migrationBuilder.CreateIndex(
                name: "IX_Episode_provider_providerEpisodeId_providerEpisodeIdISNOTNULL",
                table: "Episode",
                columns: new[] { "provider", "providerEpisodeId" },
                unique: true,
                filter: "providerEpisodeId IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_Episode_seasonId_absoluteNumber_all",
                table: "Episode",
                columns: new[] { "seasonId", "absoluteNumber" });

            migrationBuilder.CreateIndex(
                name: "IX_Episode_seasonId_number_mappingStatusunavailable",
                table: "Episode",
                columns: new[] { "seasonId", "number" },
                unique: true,
                filter: "mappingStatus <> 'unavailable'");

            migrationBuilder.CreateIndex(
                name: "IX_FileOperation_downloadId_all",
                table: "FileOperation",
                column: "downloadId");

            migrationBuilder.CreateIndex(
                name: "IX_FileOperation_mediaFileId_all",
                table: "FileOperation",
                column: "mediaFileId");

            migrationBuilder.CreateIndex(
                name: "IX_FileOperation_state_nextTryAt_all",
                table: "FileOperation",
                columns: new[] { "state", "nextTryAt" });

            migrationBuilder.CreateIndex(
                name: "IX_FileOperation_targetId",
                table: "FileOperation",
                column: "targetId");

            migrationBuilder.CreateIndex(
                name: "IX_FilePathClaim_operationId_all",
                table: "FilePathClaim",
                column: "operationId");

            migrationBuilder.CreateIndex(
                name: "IX_FilePathClaim_physicalKey_all",
                table: "FilePathClaim",
                column: "physicalKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Follow_enabled_lastMaterializedAt_all",
                table: "Follow",
                columns: new[] { "enabled", "lastMaterializedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Follow_fromEpisodeId",
                table: "Follow",
                column: "fromEpisodeId");

            migrationBuilder.CreateIndex(
                name: "IX_Follow_workId_all",
                table: "Follow",
                column: "workId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_MediaFile_downloadId_fileIndex_downloadIdISNOTNULL",
                table: "MediaFile",
                columns: new[] { "downloadId", "fileIndex" },
                unique: true,
                filter: "downloadId IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_MediaFile_episodeId",
                table: "MediaFile",
                column: "episodeId");

            migrationBuilder.CreateIndex(
                name: "IX_MediaFile_missingSince_all",
                table: "MediaFile",
                column: "missingSince");

            migrationBuilder.CreateIndex(
                name: "IX_MediaFile_parentMediaFileId_all",
                table: "MediaFile",
                column: "parentMediaFileId");

            migrationBuilder.CreateIndex(
                name: "IX_MediaFile_physicalKey_all",
                table: "MediaFile",
                column: "physicalKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_MediaFile_rootId_status_all",
                table: "MediaFile",
                columns: new[] { "rootId", "status" });

            migrationBuilder.CreateIndex(
                name: "IX_MediaFile_workId_episodeId_status_all",
                table: "MediaFile",
                columns: new[] { "workId", "episodeId", "status" });

            migrationBuilder.CreateIndex(
                name: "IX_MetadataCache_expiresAt_all",
                table: "MetadataCache",
                column: "expiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_MetadataCache_kind_cacheKey_all",
                table: "MetadataCache",
                columns: new[] { "kind", "cacheKey" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Notification_pushPending_pushAttemptAt_all",
                table: "Notification",
                columns: new[] { "pushPending", "pushAttemptAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Notification_userId_createdAt_all",
                table: "Notification",
                columns: new[] { "userId", "createdAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Notification_userId_dedupeKey_dedupeKeyISNOTNULL",
                table: "Notification",
                columns: new[] { "userId", "dedupeKey" },
                unique: true,
                filter: "dedupeKey IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_RawIntent_actorUserId",
                table: "RawIntent",
                column: "actorUserId");

            migrationBuilder.CreateIndex(
                name: "IX_RawIntent_downloadId_downloadIdISNOTNULL",
                table: "RawIntent",
                column: "downloadId",
                unique: true,
                filter: "downloadId IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_RawIntent_releaseHash_all",
                table: "RawIntent",
                column: "releaseHash");

            migrationBuilder.CreateIndex(
                name: "IX_RawIntent_rootId",
                table: "RawIntent",
                column: "rootId");

            migrationBuilder.CreateIndex(
                name: "IX_RawIntent_state_nextTryAt_all",
                table: "RawIntent",
                columns: new[] { "state", "nextTryAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Release_lastSeenAt_all",
                table: "Release",
                column: "lastSeenAt");

            migrationBuilder.CreateIndex(
                name: "IX_ReleaseObservation_hash_sourceId_query_all",
                table: "ReleaseObservation",
                columns: new[] { "hash", "sourceId", "query" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ReleaseObservation_sourceId_observedAt_all",
                table: "ReleaseObservation",
                columns: new[] { "sourceId", "observedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Request_decidedBy",
                table: "Request",
                column: "decidedBy");

            migrationBuilder.CreateIndex(
                name: "IX_Request_userId_decision_createdAt_all",
                table: "Request",
                columns: new[] { "userId", "decision", "createdAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Request_workId_decision_all",
                table: "Request",
                columns: new[] { "workId", "decision" });

            migrationBuilder.CreateIndex(
                name: "IX_RequestItem_episodeId",
                table: "RequestItem",
                column: "episodeId");

            migrationBuilder.CreateIndex(
                name: "IX_RequestItem_requestId_settlement_all",
                table: "RequestItem",
                columns: new[] { "requestId", "settlement" });

            migrationBuilder.CreateIndex(
                name: "IX_RequestItem_targetId_all",
                table: "RequestItem",
                column: "targetId");

            migrationBuilder.CreateIndex(
                name: "IX_ScopeIntent_actorUserId",
                table: "ScopeIntent",
                column: "actorUserId");

            migrationBuilder.CreateIndex(
                name: "IX_ScopeIntent_batchId_all",
                table: "ScopeIntent",
                column: "batchId");

            migrationBuilder.CreateIndex(
                name: "IX_ScopeIntent_state_nextTryAt_all",
                table: "ScopeIntent",
                columns: new[] { "state", "nextTryAt" });

            migrationBuilder.CreateIndex(
                name: "IX_ScopeIntent_workId_all",
                table: "ScopeIntent",
                column: "workId");

            migrationBuilder.CreateIndex(
                name: "IX_SearchCache_expiresAt_all",
                table: "SearchCache",
                column: "expiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_SearchCache_normalizedQuery_expiresAt_all",
                table: "SearchCache",
                columns: new[] { "normalizedQuery", "expiresAt" });

            migrationBuilder.CreateIndex(
                name: "IX_SearchCache_normalizedQuery_scopeKey_sourceId_sourceRevision_credentialRevision_parserVersion_all",
                table: "SearchCache",
                columns: new[] { "normalizedQuery", "scopeKey", "sourceId", "sourceRevision", "credentialRevision", "parserVersion" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Season_mappingStatus_refreshedAt_all",
                table: "Season",
                columns: new[] { "mappingStatus", "refreshedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Season_workId_number_all",
                table: "Season",
                columns: new[] { "workId", "number" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_StorageRoot_enabled_priority_all",
                table: "StorageRoot",
                columns: new[] { "enabled", "priority" });

            migrationBuilder.CreateIndex(
                name: "IX_StorageRoot_physicalKey_all",
                table: "StorageRoot",
                column: "physicalKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Target_autoRuleId",
                table: "Target",
                column: "autoRuleId");

            migrationBuilder.CreateIndex(
                name: "IX_Target_batchId_all",
                table: "Target",
                column: "batchId");

            migrationBuilder.CreateIndex(
                name: "IX_Target_chosenReleaseHash_all",
                table: "Target",
                column: "chosenReleaseHash");

            migrationBuilder.CreateIndex(
                name: "IX_Target_createdBy",
                table: "Target",
                column: "createdBy");

            migrationBuilder.CreateIndex(
                name: "IX_Target_episodeId_episodeIdISNOTNULL",
                table: "Target",
                column: "episodeId",
                unique: true,
                filter: "episodeId IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_Target_replaceMediaFileId",
                table: "Target",
                column: "replaceMediaFileId");

            migrationBuilder.CreateIndex(
                name: "IX_Target_state_nextTryAt_rank_all",
                table: "Target",
                columns: new[] { "state", "nextTryAt", "rank" });

            migrationBuilder.CreateIndex(
                name: "IX_Target_workId_episodeIdISNULL",
                table: "Target",
                column: "workId",
                unique: true,
                filter: "episodeId IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_User_normalizedEmail_normalizedEmailISNOTNULL",
                table: "User",
                column: "normalizedEmail",
                unique: true,
                filter: "normalizedEmail IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_User_role_roleowner",
                table: "User",
                column: "role",
                unique: true,
                filter: "role='owner'");

            migrationBuilder.CreateIndex(
                name: "IX_Verdict_checkedAt_all",
                table: "Verdict",
                column: "checkedAt");

            migrationBuilder.CreateIndex(
                name: "IX_Verdict_expiresAt_all",
                table: "Verdict",
                column: "expiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_WatchItem_upgradeWatch_all",
                table: "WatchItem",
                column: "upgradeWatch");

            migrationBuilder.CreateIndex(
                name: "IX_WatchItem_userId_workId_all",
                table: "WatchItem",
                columns: new[] { "userId", "workId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WatchItem_workId",
                table: "WatchItem",
                column: "workId");

            migrationBuilder.CreateIndex(
                name: "IX_Work_digitalAt_all",
                table: "Work",
                column: "digitalAt");

            migrationBuilder.CreateIndex(
                name: "IX_Work_kind_anime_all",
                table: "Work",
                columns: new[] { "kind", "anime" });

            migrationBuilder.CreateIndex(
                name: "IX_Work_refreshedAt_all",
                table: "Work",
                column: "refreshedAt");

            migrationBuilder.CreateIndex(
                name: "IX_Work_workKey_all",
                table: "Work",
                column: "workKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WorkFolder_externalItemFolder_externalItemFolderISNOTNULL",
                table: "WorkFolder",
                column: "externalItemFolder",
                unique: true,
                filter: "externalItemFolder IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_WorkFolder_rootId_relativeItemFolder_rootIdISNOTNULL",
                table: "WorkFolder",
                columns: new[] { "rootId", "relativeItemFolder" },
                unique: true,
                filter: "rootId IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_WorkFolder_workId_all",
                table: "WorkFolder",
                column: "workId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WorkLink_seasonId",
                table: "WorkLink",
                column: "seasonId");

            migrationBuilder.CreateIndex(
                name: "IX_WorkLink_workId_isPrimary1",
                table: "WorkLink",
                column: "workId",
                unique: true,
                filter: "isPrimary=1");

            migrationBuilder.CreateIndex(
                name: "IX_WorkLink_workId_status_all",
                table: "WorkLink",
                columns: new[] { "workId", "status" });

            migrationBuilder.CreateIndex(
                name: "IX_WorkName_linkId",
                table: "WorkName",
                column: "linkId");

            migrationBuilder.CreateIndex(
                name: "IX_WorkName_workId_ordinal_all",
                table: "WorkName",
                columns: new[] { "workId", "ordinal" });

            migrationBuilder.CreateIndex(
                name: "IX_WorkPreference_storageRootOverrideId",
                table: "WorkPreference",
                column: "storageRootOverrideId");

            migrationBuilder.CreateIndex(
                name: "IX_WorkPreference_workId_all",
                table: "WorkPreference",
                column: "workId",
                unique: true);

            migrationBuilder.AddForeignKey(
                name: "FK_Attempt_Download_downloadId",
                table: "Attempt",
                column: "downloadId",
                principalTable: "Download",
                principalColumn: "id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_Attempt_Target_targetId",
                table: "Attempt",
                column: "targetId",
                principalTable: "Target",
                principalColumn: "id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "FK_Download_RawIntent_rawIntentId",
                table: "Download",
                column: "rawIntentId",
                principalTable: "RawIntent",
                principalColumn: "id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.Sql("""
                CREATE UNIQUE INDEX UX_WorkName_Identity ON WorkName(workId,normalizedValue,label,coalesce(linkId,''));
                CREATE UNIQUE INDEX UX_WorkLink_Identity ON WorkLink(workId,provider,externalId,coalesce(providerKind,''));
                CREATE UNIQUE INDEX UX_WorkLink_VerifiedIdentity ON WorkLink(provider,externalId,coalesce(providerKind,'')) WHERE status='verified';
                CREATE UNIQUE INDEX UX_RequestItem_Identity ON RequestItem(requestId,coalesce(episodeId,''));
                CREATE UNIQUE INDEX UX_Block_Identity ON Block(hash,coalesce(workKey,''));
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_RawIntent_Download_downloadId",
                table: "RawIntent");

            migrationBuilder.DropTable(
                name: "Attempt");

            migrationBuilder.DropTable(
                name: "Block");

            migrationBuilder.DropTable(
                name: "DownloadFile");

            migrationBuilder.DropTable(
                name: "DownloadTarget");

            migrationBuilder.DropTable(
                name: "FilePathClaim");

            migrationBuilder.DropTable(
                name: "Follow");

            migrationBuilder.DropTable(
                name: "MetadataCache");

            migrationBuilder.DropTable(
                name: "Notification");

            migrationBuilder.DropTable(
                name: "ReleaseObservation");

            migrationBuilder.DropTable(
                name: "RequestItem");

            migrationBuilder.DropTable(
                name: "ScopeIntent");

            migrationBuilder.DropTable(
                name: "SearchCache");

            migrationBuilder.DropTable(
                name: "Setting");

            migrationBuilder.DropTable(
                name: "Verdict");

            migrationBuilder.DropTable(
                name: "WatchItem");

            migrationBuilder.DropTable(
                name: "WorkFolder");

            migrationBuilder.DropTable(
                name: "WorkName");

            migrationBuilder.DropTable(
                name: "WorkPreference");

            migrationBuilder.DropTable(
                name: "FileOperation");

            migrationBuilder.DropTable(
                name: "Request");

            migrationBuilder.DropTable(
                name: "WorkLink");

            migrationBuilder.DropTable(
                name: "Target");

            migrationBuilder.DropTable(
                name: "AutoRule");

            migrationBuilder.DropTable(
                name: "MediaFile");

            migrationBuilder.DropTable(
                name: "Episode");

            migrationBuilder.DropTable(
                name: "Season");

            migrationBuilder.DropTable(
                name: "Work");

            migrationBuilder.DropTable(
                name: "Download");

            migrationBuilder.DropTable(
                name: "RawIntent");

            migrationBuilder.DropTable(
                name: "Release");

            migrationBuilder.DropTable(
                name: "StorageRoot");

            migrationBuilder.DropTable(
                name: "User");
        }
    }
}
