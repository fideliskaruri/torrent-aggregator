using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddWatchNextCheckAt : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "nextCheckAt",
                table: "WatchListItem",
                type: "DATETIME",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "WatchListItem_userId_nextCheckAt_idx",
                table: "WatchListItem",
                columns: new[] { "userId", "nextCheckAt" });

            migrationBuilder.AddColumn<string>(
                name: "nextCheckReason",
                table: "WatchListItem",
                type: "TEXT",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "WatchListItem_userId_nextCheckAt_idx",
                table: "WatchListItem");

            migrationBuilder.DropColumn(
                name: "nextCheckAt",
                table: "WatchListItem");

            migrationBuilder.DropColumn(
                name: "nextCheckReason",
                table: "WatchListItem");
        }
    }
}
