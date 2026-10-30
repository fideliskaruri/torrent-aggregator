using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Store.Migrations
{
    /// <inheritdoc />
    public partial class JellyfinIntegration : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "audioLanguages",
                table: "MediaFile",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "inspectedAt",
                table: "MediaFile",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "inspectionState",
                table: "MediaFile",
                type: "TEXT",
                nullable: false,
                defaultValue: "pending");

            migrationBuilder.AddColumn<string>(
                name: "jellyfinItemId",
                table: "MediaFile",
                type: "TEXT",
                nullable: true);

            migrationBuilder.Sql("UPDATE \"MediaFile\" SET \"inspectionState\" = 'unknown';");

            migrationBuilder.CreateTable(
                name: "JellyfinJobs",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    kind = table.Column<string>(type: "TEXT", nullable: false),
                    payloadJson = table.Column<string>(type: "TEXT", nullable: false),
                    targetId = table.Column<string>(type: "TEXT", nullable: true),
                    mediaFileId = table.Column<string>(type: "TEXT", nullable: true),
                    attempts = table.Column<int>(type: "INTEGER", nullable: false),
                    nextAttemptAt = table.Column<string>(type: "TEXT", nullable: false),
                    createdAt = table.Column<string>(type: "TEXT", nullable: false),
                    lastError = table.Column<string>(type: "TEXT", nullable: true),
                    state = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_JellyfinJobs", x => x.id);
                    table.CheckConstraint("CK_JellyfinJobs_attempts", "\"attempts\" >= 0");
                    table.CheckConstraint("CK_JellyfinJobs_kind", "\"kind\" IN ('rescan','inspect','matchfix','subtitles')");
                    table.CheckConstraint("CK_JellyfinJobs_payloadJson", "json_valid(\"payloadJson\")");
                    table.CheckConstraint("CK_JellyfinJobs_state", "\"state\" IN ('pending','done','failed')");
                });

            migrationBuilder.CreateTable(
                name: "JellyfinLibraryPaths",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    serverId = table.Column<string>(type: "TEXT", nullable: false),
                    libraryItemId = table.Column<string>(type: "TEXT", nullable: false),
                    libraryName = table.Column<string>(type: "TEXT", nullable: false),
                    rootId = table.Column<string>(type: "TEXT", nullable: false),
                    kind = table.Column<string>(type: "TEXT", nullable: false),
                    serverPath = table.Column<string>(type: "TEXT", nullable: false),
                    addedAt = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_JellyfinLibraryPaths", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "JellyfinSuggestionDismissals",
                columns: table => new
                {
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: false),
                    season = table.Column<int>(type: "INTEGER", nullable: false),
                    episode = table.Column<int>(type: "INTEGER", nullable: false),
                    dismissedAt = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_JellyfinSuggestionDismissals", x => new { x.userId, x.workId, x.season, x.episode });
                });

            migrationBuilder.AddCheckConstraint(
                name: "CK_MediaFile_inspectionState",
                table: "MediaFile",
                sql: "\"inspectionState\" IN ('pending','unknown','verified','rejected')");

            migrationBuilder.CreateIndex(
                name: "IX_JellyfinJobs_state_nextAttemptAt",
                table: "JellyfinJobs",
                columns: new[] { "state", "nextAttemptAt" });

            migrationBuilder.CreateIndex(
                name: "IX_JellyfinLibraryPaths_serverId_libraryItemId_serverPath",
                table: "JellyfinLibraryPaths",
                columns: new[] { "serverId", "libraryItemId", "serverPath" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "JellyfinJobs");

            migrationBuilder.DropTable(
                name: "JellyfinLibraryPaths");

            migrationBuilder.DropTable(
                name: "JellyfinSuggestionDismissals");

            migrationBuilder.DropCheckConstraint(
                name: "CK_MediaFile_inspectionState",
                table: "MediaFile");

            migrationBuilder.DropColumn(
                name: "audioLanguages",
                table: "MediaFile");

            migrationBuilder.DropColumn(
                name: "inspectedAt",
                table: "MediaFile");

            migrationBuilder.DropColumn(
                name: "inspectionState",
                table: "MediaFile");

            migrationBuilder.DropColumn(
                name: "jellyfinItemId",
                table: "MediaFile");
        }
    }
}
