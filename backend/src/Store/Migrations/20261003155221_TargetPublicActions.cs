using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Store.Migrations
{
    /// <inheritdoc />
    public partial class TargetPublicActions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "CK_Target_origin",
                table: "Target");

            migrationBuilder.AddColumn<int>(
                name: "minListedSeeders",
                table: "Target",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "pickedReleaseHash",
                table: "Target",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddCheckConstraint(
                name: "CK_Target_minListedSeeders",
                table: "Target",
                sql: "\"minListedSeeders\" >= 0");

            migrationBuilder.AddCheckConstraint(
                name: "CK_Target_origin",
                table: "Target",
                sql: "\"origin\" IN ('owner','request','rule','follow','upgrade','hunter')");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "CK_Target_minListedSeeders",
                table: "Target");

            migrationBuilder.DropCheckConstraint(
                name: "CK_Target_origin",
                table: "Target");

            migrationBuilder.DropColumn(
                name: "minListedSeeders",
                table: "Target");

            migrationBuilder.DropColumn(
                name: "pickedReleaseHash",
                table: "Target");

            migrationBuilder.AddCheckConstraint(
                name: "CK_Target_origin",
                table: "Target",
                sql: "\"origin\" IN ('owner','request','rule','follow','upgrade')");
        }
    }
}
