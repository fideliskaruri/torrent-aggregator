using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Store.Migrations
{
    /// <inheritdoc />
    public partial class CheckByteSenders : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "byteSendingPeers",
                table: "Verdict",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddCheckConstraint(
                name: "CK_Verdict_byteSendingPeers",
                table: "Verdict",
                sql: "\"byteSendingPeers\" >= 0");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "CK_Verdict_byteSendingPeers",
                table: "Verdict");

            migrationBuilder.DropColumn(
                name: "byteSendingPeers",
                table: "Verdict");
        }
    }
}
