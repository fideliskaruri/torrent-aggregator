using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddWorkLinks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "linksVersion",
                table: "Work",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "WorkLink",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    workId = table.Column<string>(type: "TEXT", nullable: false),
                    provider = table.Column<string>(type: "TEXT", nullable: false),
                    externalId = table.Column<string>(type: "TEXT", nullable: false),
                    mediaType = table.Column<string>(type: "TEXT", nullable: true),
                    season = table.Column<int>(type: "INTEGER", nullable: true),
                    source = table.Column<string>(type: "TEXT", nullable: false),
                    mappingVersion = table.Column<string>(type: "TEXT", nullable: true),
                    confidence = table.Column<double>(type: "REAL", nullable: false),
                    verified = table.Column<bool>(type: "INTEGER", nullable: false),
                    rejected = table.Column<bool>(type: "INTEGER", nullable: false),
                    namesJson = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkLink", x => x.id);
                    table.ForeignKey(
                        name: "FK_WorkLink_Work_workId",
                        column: x => x.workId,
                        principalTable: "Work",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "WorkLink_workId_provider_externalId_key",
                table: "WorkLink",
                columns: new[] { "workId", "provider", "externalId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "WorkLink");

            migrationBuilder.DropColumn(
                name: "linksVersion",
                table: "Work");
        }
    }
}
