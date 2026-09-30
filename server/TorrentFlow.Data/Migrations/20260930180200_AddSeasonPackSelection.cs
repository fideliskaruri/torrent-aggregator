using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddSeasonPackSelection : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "selectedFilesJson",
                table: "EngineTorrent",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "fileIndex",
                table: "AcquisitionTarget",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "realMisses",
                table: "AcquisitionTarget",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "selectedFilesJson",
                table: "EngineTorrent");

            migrationBuilder.DropColumn(
                name: "fileIndex",
                table: "AcquisitionTarget");

            migrationBuilder.DropColumn(
                name: "realMisses",
                table: "AcquisitionTarget");
        }
    }
}
