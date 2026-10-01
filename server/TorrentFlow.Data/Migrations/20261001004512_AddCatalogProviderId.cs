using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddCatalogProviderId : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "provider",
                table: "CatalogEntry",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "providerId",
                table: "CatalogEntry",
                type: "TEXT",
                nullable: true);

            // Chart rows written before this migration carry no provider id; clearing them makes the next browse load rebuild the charts with ids.
            migrationBuilder.Sql("DELETE FROM \"CatalogEntry\";");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "provider",
                table: "CatalogEntry");

            migrationBuilder.DropColumn(
                name: "providerId",
                table: "CatalogEntry");
        }
    }
}
