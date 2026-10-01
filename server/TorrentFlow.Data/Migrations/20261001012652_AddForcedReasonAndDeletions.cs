using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddForcedReasonAndDeletions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "forcedReason",
                table: "EngineTorrent",
                type: "TEXT",
                nullable: true);

            // Rows forced before reasons were stored keep their slot until they finish, labelled as such.
            migrationBuilder.Sql("UPDATE \"EngineTorrent\" SET \"forcedReason\" = 'legacy' WHERE \"forcedAt\" IS NOT NULL;");

            migrationBuilder.CreateTable(
                name: "EngineDeletion",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "TEXT", nullable: false),
                    Hash = table.Column<string>(type: "TEXT", nullable: false),
                    BatchId = table.Column<string>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", nullable: false),
                    SavePath = table.Column<string>(type: "TEXT", nullable: true),
                    FilesJson = table.Column<string>(type: "TEXT", nullable: false),
                    DeleteFiles = table.Column<bool>(type: "INTEGER", nullable: false),
                    Attempts = table.Column<int>(type: "INTEGER", nullable: false),
                    LastError = table.Column<string>(type: "TEXT", nullable: true),
                    CreatedAt = table.Column<string>(type: "TEXT", nullable: false),
                    NextAttemptAt = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_EngineDeletion", x => new { x.UserId, x.Hash });
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "EngineDeletion");

            migrationBuilder.DropColumn(
                name: "forcedReason",
                table: "EngineTorrent");
        }
    }
}
