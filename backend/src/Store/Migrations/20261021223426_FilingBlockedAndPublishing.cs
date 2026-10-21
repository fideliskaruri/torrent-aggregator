using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Store.Migrations
{
    /// <inheritdoc />
    public partial class FilingBlockedAndPublishing : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "CK_Target_reasonCode",
                table: "Target");

            migrationBuilder.DropCheckConstraint(
                name: "CK_RawIntent_state",
                table: "RawIntent");

            migrationBuilder.AddCheckConstraint(
                name: "CK_Target_reasonCode",
                table: "Target",
                sql: "\"reasonCode\" IN ('notreleased','metadataunavailable','noresults','rejectedcandidates','nohealthyrelease','sourcecooldown','sourcefailure','waitingforseeders','downloadcap','downloadwindow','nodrivespace','driveoffline','filebusy','mappinguncertain','ownerpickrequired','recoverymissing','paused','filingblocked')");

            migrationBuilder.AddCheckConstraint(
                name: "CK_RawIntent_state",
                table: "RawIntent",
                sql: "\"state\" IN ('fetching','paused','publishing','done','removed')");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "CK_Target_reasonCode",
                table: "Target");

            migrationBuilder.DropCheckConstraint(
                name: "CK_RawIntent_state",
                table: "RawIntent");

            migrationBuilder.AddCheckConstraint(
                name: "CK_Target_reasonCode",
                table: "Target",
                sql: "\"reasonCode\" IN ('notreleased','metadataunavailable','noresults','rejectedcandidates','nohealthyrelease','sourcecooldown','sourcefailure','waitingforseeders','downloadcap','downloadwindow','nodrivespace','driveoffline','filebusy','mappinguncertain','ownerpickrequired','recoverymissing','paused')");

            migrationBuilder.AddCheckConstraint(
                name: "CK_RawIntent_state",
                table: "RawIntent",
                sql: "\"state\" IN ('fetching','paused','done','removed')");
        }
    }
}
