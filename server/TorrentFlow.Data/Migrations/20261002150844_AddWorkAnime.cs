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
            migrationBuilder.DropIndex(
                name: "WatchListItem_userId_mediaType_externalId_key",
                table: "WatchListItem");

            migrationBuilder.AddColumn<bool>(
                name: "anime",
                table: "Work",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "animeCheckedAt",
                table: "Work",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "provider",
                table: "WatchListItem",
                type: "TEXT",
                nullable: false,
                defaultValue: "");

            // An anime source is anime outright (AnimeIdentity); every other work learns it from its provider on its next refresh.
            migrationBuilder.Sql("""
                UPDATE "Work" SET "anime" = 1
                WHERE lower("provider") IN ('anilist', 'kitsu', 'mal', 'myanimelist', 'anidb')
                   OR lower("providerId") LIKE 'kitsu:%' OR lower("providerId") LIKE 'mal:%' OR lower("providerId") LIKE 'anidb:%'
                   OR lower("providerId") LIKE 'anilist:%';
                """);

            // A row's catalog is its work's when the work's own id is the row's; otherwise a numeric "anime" row's external
            // id has always been an AniList id, whichever work the row is linked to.
            migrationBuilder.Sql("""
                UPDATE "WatchListItem" SET "provider" = COALESCE(
                    (SELECT w."provider" FROM "Work" w WHERE w."id" = "WatchListItem"."workId" AND w."providerId" = "WatchListItem"."externalId"),
                    CASE WHEN "WatchListItem"."mediaType" = 'anime' AND "WatchListItem"."externalId" <> ''
                          AND "WatchListItem"."externalId" NOT GLOB '*[^0-9]*' THEN 'anilist' ELSE '' END,
                    '');
                """);

            migrationBuilder.CreateIndex(
                name: "WatchListItem_userId_mediaType_externalId_provider_key",
                table: "WatchListItem",
                columns: new[] { "userId", "mediaType", "externalId", "provider" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "WatchListItem_userId_mediaType_externalId_provider_key",
                table: "WatchListItem");

            migrationBuilder.DropColumn(
                name: "anime",
                table: "Work");

            migrationBuilder.DropColumn(
                name: "animeCheckedAt",
                table: "Work");

            migrationBuilder.DropColumn(
                name: "provider",
                table: "WatchListItem");

            migrationBuilder.CreateIndex(
                name: "WatchListItem_userId_mediaType_externalId_key",
                table: "WatchListItem",
                columns: new[] { "userId", "mediaType", "externalId" },
                unique: true);
        }
    }
}
