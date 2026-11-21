using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Store.Migrations
{
    /// <inheritdoc />
    public partial class RemovalIncomplete : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "CK_Target_reasonCode",
                table: "Target");

            migrationBuilder.AddCheckConstraint(
                name: "CK_Target_reasonCode",
                table: "Target",
                sql: "\"reasonCode\" IN ('notreleased','metadataunavailable','noresults','rejectedcandidates','nohealthyrelease','sourcecooldown','sourcefailure','waitingforseeders','downloadcap','downloadwindow','nodrivespace','driveoffline','filebusy','mappinguncertain','ownerpickrequired','recoverymissing','paused','filingblocked','placementblocked','removalincomplete')");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "CK_Target_reasonCode",
                table: "Target");

            migrationBuilder.AddCheckConstraint(
                name: "CK_Target_reasonCode",
                table: "Target",
                sql: "\"reasonCode\" IN ('notreleased','metadataunavailable','noresults','rejectedcandidates','nohealthyrelease','sourcecooldown','sourcefailure','waitingforseeders','downloadcap','downloadwindow','nodrivespace','driveoffline','filebusy','mappinguncertain','ownerpickrequired','recoverymissing','paused','filingblocked')");
        }
    }
}
