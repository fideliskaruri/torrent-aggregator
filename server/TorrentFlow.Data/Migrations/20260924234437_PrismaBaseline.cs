using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class PrismaBaseline : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "CachedMetadata",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    cacheKey = table.Column<string>(type: "TEXT", nullable: false),
                    source = table.Column<string>(type: "TEXT", nullable: false),
                    mediaType = table.Column<string>(type: "TEXT", nullable: false),
                    externalId = table.Column<string>(type: "TEXT", nullable: false),
                    title = table.Column<string>(type: "TEXT", nullable: false),
                    posterUrl = table.Column<string>(type: "TEXT", nullable: true),
                    backdropUrl = table.Column<string>(type: "TEXT", nullable: true),
                    synopsis = table.Column<string>(type: "TEXT", nullable: true),
                    rating = table.Column<double>(type: "REAL", nullable: true),
                    year = table.Column<int>(type: "INTEGER", nullable: true),
                    genres = table.Column<string>(type: "TEXT", nullable: true),
                    rawJson = table.Column<string>(type: "TEXT", nullable: true),
                    expiresAt = table.Column<string>(type: "DATETIME", nullable: false),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false),
                    releaseDate = table.Column<string>(type: "DATETIME", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CachedMetadata", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "MediaProbe",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    infoHash = table.Column<string>(type: "TEXT", nullable: false),
                    filePath = table.Column<string>(type: "TEXT", nullable: false),
                    container = table.Column<string>(type: "TEXT", nullable: true),
                    durationSec = table.Column<double>(type: "REAL", nullable: true),
                    videoCodec = table.Column<string>(type: "TEXT", nullable: true),
                    videoProfile = table.Column<string>(type: "TEXT", nullable: true),
                    width = table.Column<int>(type: "INTEGER", nullable: true),
                    height = table.Column<int>(type: "INTEGER", nullable: true),
                    colorTransfer = table.Column<string>(type: "TEXT", nullable: true),
                    audioCodec = table.Column<string>(type: "TEXT", nullable: true),
                    audioChannels = table.Column<int>(type: "INTEGER", nullable: true),
                    audioLayout = table.Column<string>(type: "TEXT", nullable: true),
                    streamsJson = table.Column<string>(type: "TEXT", nullable: true),
                    probedAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false),
                    bitRateBps = table.Column<int>(type: "INTEGER", nullable: true),
                    probeVersion = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MediaProbe", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "RunLock",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    scope = table.Column<string>(type: "TEXT", nullable: false),
                    acquiredAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RunLock", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "SearchCache",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    cacheKey = table.Column<string>(type: "TEXT", nullable: false),
                    payload = table.Column<string>(type: "TEXT", nullable: false),
                    expiresAt = table.Column<string>(type: "DATETIME", nullable: false),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    normalizedQuery = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SearchCache", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "SwarmMeasurement",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    infoHash = table.Column<string>(type: "TEXT", nullable: false),
                    peersConnected = table.Column<int>(type: "INTEGER", nullable: false),
                    peersUnchoked = table.Column<int>(type: "INTEGER", nullable: false),
                    bytesReceived = table.Column<long>(type: "BIGINT", nullable: false),
                    elapsedMs = table.Column<int>(type: "INTEGER", nullable: false),
                    effectiveBps = table.Column<double>(type: "REAL", nullable: false),
                    requiredBps = table.Column<double>(type: "REAL", nullable: false),
                    verdict = table.Column<string>(type: "TEXT", nullable: false),
                    measuredAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    expiresAt = table.Column<string>(type: "DATETIME", nullable: false),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false),
                    name = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SwarmMeasurement", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "User",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    name = table.Column<string>(type: "TEXT", nullable: true),
                    email = table.Column<string>(type: "TEXT", nullable: true),
                    image = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_User", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "Work",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    workKey = table.Column<string>(type: "TEXT", nullable: false),
                    canonicalTitle = table.Column<string>(type: "TEXT", nullable: false),
                    year = table.Column<int>(type: "INTEGER", nullable: true),
                    mediaType = table.Column<string>(type: "TEXT", nullable: false),
                    aliasesJson = table.Column<string>(type: "TEXT", nullable: true),
                    provider = table.Column<string>(type: "TEXT", nullable: true),
                    providerId = table.Column<string>(type: "TEXT", nullable: true),
                    posterUrl = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Work", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "AutoRule",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    name = table.Column<string>(type: "TEXT", nullable: false),
                    query = table.Column<string>(type: "TEXT", nullable: false),
                    category = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "all"),
                    minSeeders = table.Column<int>(type: "INTEGER", nullable: false, defaultValue: 10),
                    maxSizeBytes = table.Column<long>(type: "BIGINT", nullable: true),
                    resolution = table.Column<string>(type: "TEXT", nullable: true),
                    sources = table.Column<string>(type: "TEXT", nullable: true),
                    enabled = table.Column<bool>(type: "BOOLEAN", nullable: false, defaultValueSql: "true"),
                    lastRunAt = table.Column<string>(type: "DATETIME", nullable: true),
                    lastMatchTitle = table.Column<string>(type: "TEXT", nullable: true),
                    lastMatchMagnet = table.Column<string>(type: "TEXT", nullable: true),
                    matchCount = table.Column<int>(type: "INTEGER", nullable: false),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AutoRule", x => x.id);
                    table.ForeignKey(
                        name: "FK_AutoRule_User_userId",
                        column: x => x.userId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ClientSettings",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    clientType = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "builtin"),
                    externalClientType = table.Column<string>(type: "TEXT", nullable: true),
                    host = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "http://127.0.0.1:8080"),
                    username = table.Column<string>(type: "TEXT", nullable: true),
                    password = table.Column<string>(type: "TEXT", nullable: true),
                    category = table.Column<string>(type: "TEXT", nullable: true),
                    savePath = table.Column<string>(type: "TEXT", nullable: true),
                    baseDownloadPath = table.Column<string>(type: "TEXT", nullable: true),
                    maxStorageBytes = table.Column<long>(type: "BIGINT", nullable: true),
                    categories = table.Column<string>(type: "TEXT", nullable: true),
                    pathRules = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false),
                    preferredResolution = table.Column<int>(type: "INTEGER", nullable: true),
                    automationIntervalMinutes = table.Column<int>(type: "INTEGER", nullable: true),
                    preProbeScope = table.Column<string>(type: "TEXT", nullable: true),
                    defaultRetentionPolicy = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "EPHEMERAL"),
                    storageCapConfigured = table.Column<bool>(type: "BOOLEAN", nullable: true),
                    verboseDiagnostics = table.Column<bool>(type: "BOOLEAN", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ClientSettings", x => x.id);
                    table.ForeignKey(
                        name: "FK_ClientSettings_User_userId",
                        column: x => x.userId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "GrabJob",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    title = table.Column<string>(type: "TEXT", nullable: false),
                    query = table.Column<string>(type: "TEXT", nullable: false),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    message = table.Column<string>(type: "TEXT", nullable: true),
                    magnet = table.Column<string>(type: "TEXT", nullable: true),
                    infoHash = table.Column<string>(type: "TEXT", nullable: true),
                    source = table.Column<string>(type: "TEXT", nullable: true),
                    savePath = table.Column<string>(type: "TEXT", nullable: true),
                    category = table.Column<string>(type: "TEXT", nullable: true),
                    kind = table.Column<string>(type: "TEXT", nullable: true),
                    externalId = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false),
                    retention = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GrabJob", x => x.id);
                    table.ForeignKey(
                        name: "FK_GrabJob_User_userId",
                        column: x => x.userId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "AcquisitionTarget",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    targetKey = table.Column<string>(type: "TEXT", nullable: false),
                    workKey = table.Column<string>(type: "TEXT", nullable: false),
                    scope = table.Column<string>(type: "TEXT", nullable: false),
                    season = table.Column<int>(type: "INTEGER", nullable: true),
                    episode = table.Column<int>(type: "INTEGER", nullable: true),
                    preferredResolution = table.Column<int>(type: "INTEGER", nullable: true),
                    status = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "queued"),
                    progress = table.Column<double>(type: "REAL", nullable: false),
                    infoHash = table.Column<string>(type: "TEXT", nullable: true),
                    filePath = table.Column<string>(type: "TEXT", nullable: true),
                    error = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AcquisitionTarget", x => x.id);
                    table.ForeignKey(
                        name: "FK_AcquisitionTarget_User_userId",
                        column: x => x.userId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_AcquisitionTarget_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "CatalogEntry",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    workKey = table.Column<string>(type: "TEXT", nullable: false),
                    title = table.Column<string>(type: "TEXT", nullable: false),
                    year = table.Column<int>(type: "INTEGER", nullable: true),
                    mediaType = table.Column<string>(type: "TEXT", nullable: false),
                    posterUrl = table.Column<string>(type: "TEXT", nullable: true),
                    backdropUrl = table.Column<string>(type: "TEXT", nullable: true),
                    overview = table.Column<string>(type: "TEXT", nullable: true),
                    rating = table.Column<double>(type: "REAL", nullable: true),
                    source = table.Column<string>(type: "TEXT", nullable: false),
                    rank = table.Column<int>(type: "INTEGER", nullable: false),
                    seedTitle = table.Column<string>(type: "TEXT", nullable: true),
                    seeders = table.Column<int>(type: "INTEGER", nullable: false),
                    bestRelease = table.Column<string>(type: "TEXT", nullable: true),
                    refreshedAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    releaseDate = table.Column<string>(type: "DATETIME", nullable: true),
                    workId = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CatalogEntry", x => x.id);
                    table.ForeignKey(
                        name: "FK_CatalogEntry_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "DownloadHistory",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    title = table.Column<string>(type: "TEXT", nullable: false),
                    magnet = table.Column<string>(type: "TEXT", nullable: true),
                    torrentUrl = table.Column<string>(type: "TEXT", nullable: true),
                    infoHash = table.Column<string>(type: "TEXT", nullable: true),
                    source = table.Column<string>(type: "TEXT", nullable: true),
                    status = table.Column<string>(type: "TEXT", nullable: false),
                    message = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    context = table.Column<string>(type: "TEXT", nullable: true),
                    category = table.Column<string>(type: "TEXT", nullable: true),
                    savePath = table.Column<string>(type: "TEXT", nullable: true),
                    clientType = table.Column<string>(type: "TEXT", nullable: true),
                    sendKind = table.Column<string>(type: "TEXT", nullable: true),
                    retention = table.Column<string>(type: "TEXT", nullable: true),
                    workId = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DownloadHistory", x => x.id);
                    table.ForeignKey(
                        name: "FK_DownloadHistory_User_userId",
                        column: x => x.userId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_DownloadHistory_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "EngineTorrent",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    hash = table.Column<string>(type: "TEXT", nullable: false),
                    name = table.Column<string>(type: "TEXT", nullable: false),
                    magnet = table.Column<string>(type: "TEXT", nullable: true),
                    savePath = table.Column<string>(type: "TEXT", nullable: true),
                    category = table.Column<string>(type: "TEXT", nullable: true),
                    status = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "downloading"),
                    progress = table.Column<double>(type: "REAL", nullable: false),
                    sizeBytes = table.Column<long>(type: "BIGINT", nullable: false),
                    error = table.Column<string>(type: "TEXT", nullable: true),
                    origin = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "user"),
                    lastUsedAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false),
                    torrentUrl = table.Column<string>(type: "TEXT", nullable: true),
                    verifiedBitfield = table.Column<string>(type: "TEXT", nullable: true),
                    verifiedFilesJson = table.Column<string>(type: "TEXT", nullable: true),
                    verifiedAt = table.Column<string>(type: "DATETIME", nullable: true),
                    evictLease = table.Column<string>(type: "TEXT", nullable: true),
                    evictFrom = table.Column<string>(type: "TEXT", nullable: true),
                    workId = table.Column<string>(type: "TEXT", nullable: true),
                    queueKey = table.Column<string>(type: "TEXT", nullable: true),
                    forcedAt = table.Column<string>(type: "DATETIME", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_EngineTorrent", x => x.id);
                    table.ForeignKey(
                        name: "FK_EngineTorrent_User_userId",
                        column: x => x.userId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_EngineTorrent_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "PlaybackProgress",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    infoHash = table.Column<string>(type: "TEXT", nullable: false),
                    filePath = table.Column<string>(type: "TEXT", nullable: false),
                    positionSec = table.Column<double>(type: "REAL", nullable: false),
                    durationSec = table.Column<double>(type: "REAL", nullable: true),
                    completedAt = table.Column<string>(type: "DATETIME", nullable: true),
                    title = table.Column<string>(type: "TEXT", nullable: false),
                    season = table.Column<int>(type: "INTEGER", nullable: true),
                    episode = table.Column<int>(type: "INTEGER", nullable: true),
                    watchListItemId = table.Column<string>(type: "TEXT", nullable: true),
                    posterUrl = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PlaybackProgress", x => x.id);
                    table.ForeignKey(
                        name: "FK_PlaybackProgress_User_userId",
                        column: x => x.userId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_PlaybackProgress_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "WatchListItem",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    mediaType = table.Column<string>(type: "TEXT", nullable: false),
                    externalId = table.Column<string>(type: "TEXT", nullable: false),
                    title = table.Column<string>(type: "TEXT", nullable: false),
                    posterUrl = table.Column<string>(type: "TEXT", nullable: true),
                    synopsis = table.Column<string>(type: "TEXT", nullable: true),
                    rating = table.Column<double>(type: "REAL", nullable: true),
                    status = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "watching"),
                    monitored = table.Column<bool>(type: "BOOLEAN", nullable: false, defaultValueSql: "true"),
                    lastChecked = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    lastEpisode = table.Column<string>(type: "TEXT", nullable: true),
                    fromSeason = table.Column<int>(type: "INTEGER", nullable: true),
                    fromEpisode = table.Column<int>(type: "INTEGER", nullable: true, defaultValue: 1),
                    cursorSeason = table.Column<int>(type: "INTEGER", nullable: true),
                    cursorEpisode = table.Column<int>(type: "INTEGER", nullable: true),
                    cursorMisses = table.Column<int>(type: "INTEGER", nullable: false),
                    monitorMode = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "ongoing"),
                    latestReleaseTitle = table.Column<string>(type: "TEXT", nullable: true),
                    latestReleaseAt = table.Column<string>(type: "DATETIME", nullable: true),
                    latestReleaseMagnet = table.Column<string>(type: "TEXT", nullable: true),
                    nextEpisodeHint = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false),
                    seederWaitSince = table.Column<string>(type: "DATETIME", nullable: true),
                    preferredResolution = table.Column<int>(type: "INTEGER", nullable: true),
                    workId = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WatchListItem", x => x.id);
                    table.ForeignKey(
                        name: "FK_WatchListItem_User_userId",
                        column: x => x.userId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_WatchListItem_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "AcquisitionTarget_userId_infoHash_idx",
                table: "AcquisitionTarget",
                columns: new[] { "userId", "infoHash" });

            migrationBuilder.CreateIndex(
                name: "AcquisitionTarget_userId_status_idx",
                table: "AcquisitionTarget",
                columns: new[] { "userId", "status" });

            migrationBuilder.CreateIndex(
                name: "AcquisitionTarget_userId_targetKey_key",
                table: "AcquisitionTarget",
                columns: new[] { "userId", "targetKey" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "AcquisitionTarget_userId_workKey_scope_idx",
                table: "AcquisitionTarget",
                columns: new[] { "userId", "workKey", "scope" });

            migrationBuilder.CreateIndex(
                name: "AcquisitionTarget_workId_idx",
                table: "AcquisitionTarget",
                column: "workId");

            migrationBuilder.CreateIndex(
                name: "AutoRule_userId_enabled_idx",
                table: "AutoRule",
                columns: new[] { "userId", "enabled" });

            migrationBuilder.CreateIndex(
                name: "CachedMetadata_cacheKey_key",
                table: "CachedMetadata",
                column: "cacheKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "CachedMetadata_expiresAt_idx",
                table: "CachedMetadata",
                column: "expiresAt");

            migrationBuilder.CreateIndex(
                name: "CachedMetadata_source_externalId_idx",
                table: "CachedMetadata",
                columns: new[] { "source", "externalId" });

            migrationBuilder.CreateIndex(
                name: "CachedMetadata_updatedAt_idx",
                table: "CachedMetadata",
                column: "updatedAt");

            migrationBuilder.CreateIndex(
                name: "CatalogEntry_refreshedAt_idx",
                table: "CatalogEntry",
                column: "refreshedAt");

            migrationBuilder.CreateIndex(
                name: "CatalogEntry_source_rank_idx",
                table: "CatalogEntry",
                columns: new[] { "source", "rank" });

            migrationBuilder.CreateIndex(
                name: "CatalogEntry_source_seedTitle_rank_title_idx",
                table: "CatalogEntry",
                columns: new[] { "source", "seedTitle", "rank", "title" });

            migrationBuilder.CreateIndex(
                name: "CatalogEntry_workId_idx",
                table: "CatalogEntry",
                column: "workId");

            migrationBuilder.CreateIndex(
                name: "CatalogEntry_workKey_source_seedTitle_key",
                table: "CatalogEntry",
                columns: new[] { "workKey", "source", "seedTitle" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ClientSettings_userId_key",
                table: "ClientSettings",
                column: "userId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "DownloadHistory_userId_createdAt_idx",
                table: "DownloadHistory",
                columns: new[] { "userId", "createdAt" });

            migrationBuilder.CreateIndex(
                name: "DownloadHistory_userId_status_idx",
                table: "DownloadHistory",
                columns: new[] { "userId", "status" });

            migrationBuilder.CreateIndex(
                name: "DownloadHistory_workId_idx",
                table: "DownloadHistory",
                column: "workId");

            migrationBuilder.CreateIndex(
                name: "EngineTorrent_userId_hash_key",
                table: "EngineTorrent",
                columns: new[] { "userId", "hash" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "EngineTorrent_userId_origin_lastUsedAt_idx",
                table: "EngineTorrent",
                columns: new[] { "userId", "origin", "lastUsedAt" });

            migrationBuilder.CreateIndex(
                name: "EngineTorrent_userId_status_idx",
                table: "EngineTorrent",
                columns: new[] { "userId", "status" });

            migrationBuilder.CreateIndex(
                name: "EngineTorrent_workId_idx",
                table: "EngineTorrent",
                column: "workId");

            migrationBuilder.CreateIndex(
                name: "GrabJob_userId_createdAt_idx",
                table: "GrabJob",
                columns: new[] { "userId", "createdAt" });

            migrationBuilder.CreateIndex(
                name: "GrabJob_userId_status_idx",
                table: "GrabJob",
                columns: new[] { "userId", "status" });

            migrationBuilder.CreateIndex(
                name: "MediaProbe_infoHash_filePath_key",
                table: "MediaProbe",
                columns: new[] { "infoHash", "filePath" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "PlaybackProgress_userId_completedAt_idx",
                table: "PlaybackProgress",
                columns: new[] { "userId", "completedAt" });

            migrationBuilder.CreateIndex(
                name: "PlaybackProgress_userId_infoHash_filePath_key",
                table: "PlaybackProgress",
                columns: new[] { "userId", "infoHash", "filePath" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "PlaybackProgress_userId_updatedAt_idx",
                table: "PlaybackProgress",
                columns: new[] { "userId", "updatedAt" });

            migrationBuilder.CreateIndex(
                name: "PlaybackProgress_workId_idx",
                table: "PlaybackProgress",
                column: "workId");

            migrationBuilder.CreateIndex(
                name: "RunLock_acquiredAt_idx",
                table: "RunLock",
                column: "acquiredAt");

            migrationBuilder.CreateIndex(
                name: "RunLock_userId_scope_key",
                table: "RunLock",
                columns: new[] { "userId", "scope" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "SearchCache_cacheKey_key",
                table: "SearchCache",
                column: "cacheKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "SearchCache_expiresAt_idx",
                table: "SearchCache",
                column: "expiresAt");

            migrationBuilder.CreateIndex(
                name: "SearchCache_normalizedQuery_expiresAt_idx",
                table: "SearchCache",
                columns: new[] { "normalizedQuery", "expiresAt" });

            migrationBuilder.CreateIndex(
                name: "SwarmMeasurement_expiresAt_idx",
                table: "SwarmMeasurement",
                column: "expiresAt");

            migrationBuilder.CreateIndex(
                name: "SwarmMeasurement_infoHash_key",
                table: "SwarmMeasurement",
                column: "infoHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "User_email_key",
                table: "User",
                column: "email",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "WatchListItem_userId_idx",
                table: "WatchListItem",
                column: "userId");

            migrationBuilder.CreateIndex(
                name: "WatchListItem_userId_mediaType_externalId_key",
                table: "WatchListItem",
                columns: new[] { "userId", "mediaType", "externalId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "WatchListItem_workId_idx",
                table: "WatchListItem",
                column: "workId");

            migrationBuilder.CreateIndex(
                name: "Work_mediaType_idx",
                table: "Work",
                column: "mediaType");

            migrationBuilder.CreateIndex(
                name: "Work_provider_providerId_mediaType_key",
                table: "Work",
                columns: new[] { "provider", "providerId", "mediaType" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "Work_workKey_key",
                table: "Work",
                column: "workKey",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AcquisitionTarget");

            migrationBuilder.DropTable(
                name: "AutoRule");

            migrationBuilder.DropTable(
                name: "CachedMetadata");

            migrationBuilder.DropTable(
                name: "CatalogEntry");

            migrationBuilder.DropTable(
                name: "ClientSettings");

            migrationBuilder.DropTable(
                name: "DownloadHistory");

            migrationBuilder.DropTable(
                name: "EngineTorrent");

            migrationBuilder.DropTable(
                name: "GrabJob");

            migrationBuilder.DropTable(
                name: "MediaProbe");

            migrationBuilder.DropTable(
                name: "PlaybackProgress");

            migrationBuilder.DropTable(
                name: "RunLock");

            migrationBuilder.DropTable(
                name: "SearchCache");

            migrationBuilder.DropTable(
                name: "SwarmMeasurement");

            migrationBuilder.DropTable(
                name: "WatchListItem");

            migrationBuilder.DropTable(
                name: "User");

            migrationBuilder.DropTable(
                name: "Work");
        }
    }
}
