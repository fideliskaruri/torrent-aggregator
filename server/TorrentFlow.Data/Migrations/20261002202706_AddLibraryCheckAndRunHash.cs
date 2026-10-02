using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddLibraryCheckAndRunHash : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "libraryCheckedAt",
                table: "EngineTorrent",
                type: "DATETIME",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "runHash",
                table: "AcquisitionTarget",
                type: "TEXT",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "libraryCheckedAt",
                table: "EngineTorrent");

            migrationBuilder.DropColumn(
                name: "runHash",
                table: "AcquisitionTarget");
        }
    }
}
