using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Store.Migrations
{
    /// <inheritdoc />
    public partial class TargetSchedulingPriority : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "priority",
                table: "Target",
                type: "TEXT",
                nullable: false,
                defaultValue: "backcatalogue");

            migrationBuilder.AddCheckConstraint(
                name: "CK_Target_priority",
                table: "Target",
                sql: "\"priority\" IN ('now','ownerrank','freshrelease','request','backcatalogue','upgradewatch')");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "CK_Target_priority",
                table: "Target");

            migrationBuilder.DropColumn(
                name: "priority",
                table: "Target");
        }
    }
}
