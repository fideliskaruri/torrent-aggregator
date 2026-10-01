using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddAudioLanguage : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "language",
                table: "GrabJob",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "rung",
                table: "GrabJob",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "audioLanguage",
                table: "ClientSettings",
                type: "TEXT",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "language",
                table: "GrabJob");

            migrationBuilder.DropColumn(
                name: "rung",
                table: "GrabJob");

            migrationBuilder.DropColumn(
                name: "audioLanguage",
                table: "ClientSettings");
        }
    }
}
