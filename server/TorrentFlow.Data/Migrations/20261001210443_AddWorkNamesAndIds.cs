using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddWorkNamesAndIds : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "format",
                table: "Work",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "idsJson",
                table: "Work",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "namesJson",
                table: "Work",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "namesRefreshedAt",
                table: "Work",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "originalLanguage",
                table: "Work",
                type: "TEXT",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "format",
                table: "Work");

            migrationBuilder.DropColumn(
                name: "idsJson",
                table: "Work");

            migrationBuilder.DropColumn(
                name: "namesJson",
                table: "Work");

            migrationBuilder.DropColumn(
                name: "namesRefreshedAt",
                table: "Work");

            migrationBuilder.DropColumn(
                name: "originalLanguage",
                table: "Work");
        }
    }
}
