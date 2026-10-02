using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddStagedPromotion : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "legacy",
                table: "EngineTorrent",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "promotion",
                table: "EngineTorrent",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "promotionReason",
                table: "EngineTorrent",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "provenance",
                table: "EngineTorrent",
                type: "TEXT",
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<string>(
                name: "stagePath",
                table: "EngineTorrent",
                type: "TEXT",
                nullable: true);

            // Upgrade (docs/english-gates-plan.md section 1). Every existing row is legacy: it keeps writing where it is, with
            // no stage folder. Rows already finished were promoted as they were; rows still on their way pass the gate first.
            migrationBuilder.Sql("""UPDATE "EngineTorrent" SET "legacy" = 1;""");
            migrationBuilder.Sql("""UPDATE "EngineTorrent" SET "promotion" = 'promoted' WHERE "verifiedAt" IS NOT NULL AND "progress" >= 0.9999;""");
            // Provenance: a hand pick kept its language state as hand_pick; everything else was chosen by the finder.
            migrationBuilder.Sql("""
                UPDATE "EngineTorrent" SET "provenance" =
                    CASE WHEN "languageCheckJson" LIKE '%"state":"hand_pick"%' THEN 'hand' ELSE 'automatic' END;
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "legacy",
                table: "EngineTorrent");

            migrationBuilder.DropColumn(
                name: "promotion",
                table: "EngineTorrent");

            migrationBuilder.DropColumn(
                name: "promotionReason",
                table: "EngineTorrent");

            migrationBuilder.DropColumn(
                name: "provenance",
                table: "EngineTorrent");

            migrationBuilder.DropColumn(
                name: "stagePath",
                table: "EngineTorrent");
        }
    }
}
