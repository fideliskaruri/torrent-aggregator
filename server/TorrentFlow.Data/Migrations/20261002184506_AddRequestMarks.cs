using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddRequestMarks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "fulfilledThrough",
                table: "MediaRequest",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "stoppedKey",
                table: "MediaRequest",
                type: "TEXT",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "fulfilledThrough",
                table: "MediaRequest");

            migrationBuilder.DropColumn(
                name: "stoppedKey",
                table: "MediaRequest");
        }
    }
}
