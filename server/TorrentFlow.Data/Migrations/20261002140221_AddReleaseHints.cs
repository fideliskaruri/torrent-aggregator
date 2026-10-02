using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddReleaseHints : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ReleaseHint",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    source = table.Column<string>(type: "TEXT", nullable: false),
                    key = table.Column<string>(type: "TEXT", nullable: false),
                    state = table.Column<string>(type: "TEXT", nullable: false),
                    filesJson = table.Column<string>(type: "TEXT", nullable: true),
                    attempts = table.Column<int>(type: "INTEGER", nullable: false),
                    fetchedAt = table.Column<string>(type: "DATETIME", nullable: false),
                    retryAt = table.Column<string>(type: "DATETIME", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ReleaseHint", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "ReleaseHint_source_key_key",
                table: "ReleaseHint",
                columns: new[] { "source", "key" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ReleaseHint");
        }
    }
}
