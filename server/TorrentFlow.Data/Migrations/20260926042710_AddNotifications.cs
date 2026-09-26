using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddNotifications : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Notification",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    recipientUserId = table.Column<string>(type: "TEXT", nullable: false),
                    kind = table.Column<string>(type: "TEXT", nullable: false),
                    title = table.Column<string>(type: "TEXT", nullable: false),
                    body = table.Column<string>(type: "TEXT", nullable: true),
                    link = table.Column<string>(type: "TEXT", nullable: true),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false),
                    readAt = table.Column<string>(type: "DATETIME", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Notification", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "PushSubscription",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    userId = table.Column<string>(type: "TEXT", nullable: false),
                    endpoint = table.Column<string>(type: "TEXT", nullable: false),
                    p256dh = table.Column<string>(type: "TEXT", nullable: false),
                    auth = table.Column<string>(type: "TEXT", nullable: false),
                    createdAt = table.Column<string>(type: "DATETIME", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PushSubscription", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "Notification_recipientUserId_createdAt_idx",
                table: "Notification",
                columns: new[] { "recipientUserId", "createdAt" });

            migrationBuilder.CreateIndex(
                name: "PushSubscription_endpoint_key",
                table: "PushSubscription",
                column: "endpoint",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "PushSubscription_userId_idx",
                table: "PushSubscription",
                column: "userId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Raw SQL like AddRequestGrabbedHashes: the snapshot chain spans parallel branches, so keep Down independent of it.
            migrationBuilder.Sql(@"DROP TABLE IF EXISTS ""PushSubscription"";");
            migrationBuilder.Sql(@"DROP TABLE IF EXISTS ""Notification"";");
        }
    }
}
