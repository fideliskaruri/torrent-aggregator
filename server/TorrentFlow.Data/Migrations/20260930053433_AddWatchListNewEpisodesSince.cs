using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddWatchListNewEpisodesSince : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "newEpisodesSince",
                table: "WatchListItem",
                type: "DATETIME",
                nullable: true);

            // Series added with "New episodes only" before the mode existed carry no start at all. Mark them so
            // they hunt only episodes airing after they were added, never the back catalogue.
            migrationBuilder.Sql(@"UPDATE ""WatchListItem"" SET ""monitorMode"" = 'new'
                WHERE ""mediaType"" IN ('tv', 'anime', 'series') AND ""monitorMode"" = 'ongoing'
                  AND ""cursorSeason"" IS NULL AND ""cursorEpisode"" IS NULL AND ""fromSeason"" IS NULL
                  AND COALESCE(TRIM(""lastEpisode""), '') = '' AND COALESCE(TRIM(""nextEpisodeHint""), '') = ''
                  AND ""externalId"" NOT LIKE 'local:%';");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"UPDATE ""WatchListItem"" SET ""monitorMode"" = 'ongoing' WHERE ""monitorMode"" = 'new';");

            migrationBuilder.DropColumn(
                name: "newEpisodesSince",
                table: "WatchListItem");
        }
    }
}
