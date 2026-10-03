using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Store.Migrations
{
    /// <inheritdoc />
    public partial class TargetRecoverySettings : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "CK_Setting_section",
                table: "Setting");

            migrationBuilder.AddCheckConstraint(
                name: "CK_Setting_section",
                table: "Setting",
                sql: "section IN ('engine','sources','metadata','remoteAccess','desktop','quality','requests','scheduler','jellyfin','migration','recovery') AND schemaVersion=1");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "CK_Setting_section",
                table: "Setting");

            migrationBuilder.AddCheckConstraint(
                name: "CK_Setting_section",
                table: "Setting",
                sql: "section IN ('engine','sources','metadata','remoteAccess','desktop','quality','requests','scheduler','jellyfin','migration') AND schemaVersion=1");
        }
    }
}
