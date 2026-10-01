using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddSeasonRunId : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "runId",
                table: "AcquisitionTarget",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "AcquisitionTarget_userId_runId_idx",
                table: "AcquisitionTarget",
                columns: new[] { "userId", "runId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "AcquisitionTarget_userId_runId_idx",
                table: "AcquisitionTarget");

            migrationBuilder.DropColumn(
                name: "runId",
                table: "AcquisitionTarget");
        }
    }
}
