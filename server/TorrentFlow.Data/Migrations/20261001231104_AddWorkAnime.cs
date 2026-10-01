using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddWorkAnime : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "anime",
                table: "Work",
                type: "INTEGER",
                nullable: true);

            // An anime source is anime outright (AnimeIdentity); every other work learns it from its provider on its next refresh.
            migrationBuilder.Sql("""
                UPDATE "Work" SET "anime" = 1
                WHERE lower("provider") IN ('anilist', 'kitsu', 'mal', 'myanimelist', 'anidb')
                   OR lower("providerId") LIKE 'kitsu:%' OR lower("providerId") LIKE 'mal:%' OR lower("providerId") LIKE 'anidb:%'
                   OR lower("providerId") LIKE 'anilist:%';
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "anime",
                table: "Work");
        }
    }
}
