using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddMediaRequests : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "MediaRequest",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    requestedByUserId = table.Column<string>(type: "TEXT", nullable: false),
                    provider = table.Column<string>(type: "TEXT", nullable: false),
                    providerId = table.Column<string>(type: "TEXT", nullable: true),
                    workKey = table.Column<string>(type: "TEXT", nullable: false),
                    mediaType = table.Column<string>(type: "TEXT", nullable: false),
                    title = table.Column<string>(type: "TEXT", nullable: false),
                    year = table.Column<int>(type: "INTEGER", nullable: true),
                    posterUrl = table.Column<string>(type: "TEXT", nullable: true),
                    scope = table.Column<string>(type: "TEXT", nullable: false),
                    seasons = table.Column<string>(type: "TEXT", nullable: true),
                    note = table.Column<string>(type: "TEXT", nullable: true),
                    status = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "pending"),
                    decisionReason = table.Column<string>(type: "TEXT", nullable: true),
                    decidedAt = table.Column<string>(type: "DATETIME", nullable: true),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false),
                    watchListItemId = table.Column<string>(type: "TEXT", nullable: true),
                    acquisitionTargetId = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MediaRequest", x => x.id);
                    table.ForeignKey(
                        name: "FK_MediaRequest_AcquisitionTarget_acquisitionTargetId",
                        column: x => x.acquisitionTargetId,
                        principalTable: "AcquisitionTarget",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_MediaRequest_User_requestedByUserId",
                        column: x => x.requestedByUserId,
                        principalTable: "User",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_MediaRequest_WatchListItem_watchListItemId",
                        column: x => x.watchListItemId,
                        principalTable: "WatchListItem",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "IX_MediaRequest_acquisitionTargetId",
                table: "MediaRequest",
                column: "acquisitionTargetId");

            migrationBuilder.CreateIndex(
                name: "IX_MediaRequest_watchListItemId",
                table: "MediaRequest",
                column: "watchListItemId");

            migrationBuilder.CreateIndex(
                name: "MediaRequest_requestedByUserId_status_idx",
                table: "MediaRequest",
                columns: new[] { "requestedByUserId", "status" });

            migrationBuilder.CreateIndex(
                name: "MediaRequest_status_createdAt_idx",
                table: "MediaRequest",
                columns: new[] { "status", "createdAt" });

            migrationBuilder.CreateIndex(
                name: "MediaRequest_workKey_idx",
                table: "MediaRequest",
                column: "workKey");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "MediaRequest");
        }
    }
}
