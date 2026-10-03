using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Store.Migrations
{
    /// <inheritdoc />
    public partial class ProbePayloadMetrics : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "probeMetricsJson",
                table: "Verdict",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddCheckConstraint(
                name: "CK_Verdict_probeMetricsJson",
                table: "Verdict",
                sql: "json_valid(\"probeMetricsJson\")");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "CK_Verdict_probeMetricsJson",
                table: "Verdict");

            migrationBuilder.DropColumn(
                name: "probeMetricsJson",
                table: "Verdict");
        }
    }
}
