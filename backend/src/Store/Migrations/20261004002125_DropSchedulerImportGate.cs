using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Store.Migrations
{
    /// <inheritdoc />
    public partial class DropSchedulerImportGate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                UPDATE Setting
                SET valueJson = json_remove(valueJson, '$.firstFullRootScanComplete', '$.importReviewComplete')
                WHERE section = 'scheduler';
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                UPDATE Setting
                SET valueJson = json_set(valueJson, '$.firstFullRootScanComplete', json('false'), '$.importReviewComplete', json('false'))
                WHERE section = 'scheduler';
                """);
        }
    }
}
