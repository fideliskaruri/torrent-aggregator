using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Store.Migrations
{
    /// <inheritdoc />
    public partial class EpisodeAvailableCoordinates : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Episode_seasonId_number_all",
                table: "Episode");

            migrationBuilder.CreateIndex(
                name: "IX_Episode_seasonId_number_mappingStatusunavailable",
                table: "Episode",
                columns: new[] { "seasonId", "number" },
                unique: true,
                filter: "mappingStatus <> 'unavailable'");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Episode_seasonId_number_mappingStatusunavailable",
                table: "Episode");

            migrationBuilder.CreateIndex(
                name: "IX_Episode_seasonId_number_all",
                table: "Episode",
                columns: new[] { "seasonId", "number" },
                unique: true);
        }
    }
}
