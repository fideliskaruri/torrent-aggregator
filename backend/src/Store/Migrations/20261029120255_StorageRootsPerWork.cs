using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Store.Migrations
{
    /// <inheritdoc />
    public partial class StorageRootsPerWork : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_WorkFolder_workId_all",
                table: "WorkFolder");

            migrationBuilder.CreateIndex(
                name: "IX_WorkFolder_workId_rootId_rootIdISNOTNULL",
                table: "WorkFolder",
                columns: new[] { "workId", "rootId" },
                unique: true,
                filter: "rootId IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_WorkFolder_workId_rootIdISNULL",
                table: "WorkFolder",
                column: "workId",
                unique: true,
                filter: "rootId IS NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_WorkFolder_workId_rootId_rootIdISNOTNULL",
                table: "WorkFolder");

            migrationBuilder.DropIndex(
                name: "IX_WorkFolder_workId_rootIdISNULL",
                table: "WorkFolder");

            migrationBuilder.CreateIndex(
                name: "IX_WorkFolder_workId_all",
                table: "WorkFolder",
                column: "workId",
                unique: true);
        }
    }
}
