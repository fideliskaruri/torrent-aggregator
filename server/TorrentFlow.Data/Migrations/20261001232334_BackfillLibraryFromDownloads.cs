using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <summary>
    /// Changes no schema. Its first run marks the one-time Library backfill as due: downloads that finished before
    /// finished downloads went to the Library are added once, so a title the owner later removes stays removed.
    /// <see cref="DatabaseInitializer.LibraryBackfillDue"/>.
    /// </summary>
    public partial class BackfillLibraryFromDownloads : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
        }
    }
}
