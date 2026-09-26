using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddRequestGrabbedHashes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "grabbedHashes",
                table: "MediaRequest",
                type: "TEXT",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // The previous migration's model predates MediaRequest (parallel branches), so EF cannot rebuild the
            // table here; SQLite 3.35+ drops a plain nullable column directly.
            migrationBuilder.Sql(@"ALTER TABLE ""MediaRequest"" DROP COLUMN ""grabbedHashes"";");
        }
    }
}
