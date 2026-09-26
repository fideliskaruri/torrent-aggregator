using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddRequestAutoApproveRules : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "RequestAutoApproveRule",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    email = table.Column<string>(type: "TEXT", nullable: false),
                    mode = table.Column<string>(type: "TEXT", nullable: false),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false, defaultValueSql: "CURRENT_TIMESTAMP"),
                    updatedAt = table.Column<string>(type: "DATETIME", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RequestAutoApproveRule", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "RequestAutoApproveRule_email_key",
                table: "RequestAutoApproveRule",
                column: "email",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "RequestAutoApproveRule");
        }
    }
}
