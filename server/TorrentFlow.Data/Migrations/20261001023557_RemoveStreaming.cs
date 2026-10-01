using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <summary>
    /// Streaming is gone (docs/rules.md): drops watch progress and swarm probe tables, and the stream/prewarm cache rows
    /// the engine no longer knows how to evict. Their files stay on disk; Settings lists them as untracked files.
    /// The unused columns ClientSettings.preProbeScope and EngineTorrent.evictLease/evictFrom stay (dropping a SQLite
    /// column rebuilds the table).
    /// </summary>
    public partial class RemoveStreaming : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DELETE FROM \"EngineTorrent\" WHERE \"origin\" IN ('stream', 'prewarm', 'evicting');");
            migrationBuilder.Sql("DELETE FROM \"DownloadHistory\" WHERE \"retention\" = 'stream';");
            migrationBuilder.Sql("DELETE FROM \"GrabJob\" WHERE \"retention\" = 'stream';");
            migrationBuilder.Sql("UPDATE \"ClientSettings\" SET \"defaultRetentionPolicy\" = 'KEPT' WHERE \"defaultRetentionPolicy\" <> 'KEPT';");

            // IF EXISTS: an old adopted Prisma database may predate either table. Their indexes go with them.
            migrationBuilder.Sql("DROP TABLE IF EXISTS \"PlaybackProgress\";");
            migrationBuilder.Sql("DROP TABLE IF EXISTS \"SwarmMeasurement\";");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "PlaybackProgress",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: true),
                    completedAt = table.Column<string>(type: "DATETIME", nullable: true),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    durationSec = table.Column<double>(type: "REAL", nullable: true),
                    episode = table.Column<int>(type: "INTEGER", nullable: true),
                    filePath = table.Column<string>(type: "TEXT", nullable: false),
                    infoHash = table.Column<string>(type: "TEXT", nullable: false),
                    positionSec = table.Column<double>(type: "REAL", nullable: false),
                    posterUrl = table.Column<string>(type: "TEXT", nullable: true),
                    season = table.Column<int>(type: "INTEGER", nullable: true),
                    title = table.Column<string>(type: "TEXT", nullable: false),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false),
                    watchListItemId = table.Column<string>(type: "TEXT", nullable: true)
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
                name: "SwarmMeasurement",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    bytesReceived = table.Column<long>(type: "BIGINT", nullable: false),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    effectiveBps = table.Column<double>(type: "REAL", nullable: false),
                    elapsedMs = table.Column<int>(type: "INTEGER", nullable: false),
                    expiresAt = table.Column<string>(type: "DATETIME", nullable: false),
                    infoHash = table.Column<string>(type: "TEXT", nullable: false),
                    measuredAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    name = table.Column<string>(type: "TEXT", nullable: true),
                    peersConnected = table.Column<int>(type: "INTEGER", nullable: false),
                    peersUnchoked = table.Column<int>(type: "INTEGER", nullable: false),
                    requiredBps = table.Column<double>(type: "REAL", nullable: false),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false),
                    verdict = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SwarmMeasurement", x => x.id);
                });

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
                name: "SwarmMeasurement_expiresAt_idx",
                table: "SwarmMeasurement",
                column: "expiresAt");

            migrationBuilder.CreateIndex(
                name: "SwarmMeasurement_infoHash_key",
                table: "SwarmMeasurement",
                column: "infoHash",
                unique: true);
        }
    }
}
