using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TorrentFlow.Data.Migrations
{
    /// <summary>
    /// The release blocklist (<see cref="ReleaseBlocks"/>). Back-fills it from the swap history. A swap marked both
    /// hashes as tried in <c>ReleaseAttempt</c>, so every attempt row is classified first:
    /// <list type="bullet">
    /// <item><b>replaced</b>: a swap replaced this hash (its <c>release-swap</c> history row says "Replaced {hash}").
    /// It becomes a <c>replaced</c> block, replaced by that row's new hash, dated by it.</item>
    /// <item><b>owner-selected</b>: the hash a swap switched to (that row's <c>infoHash</c>). Not blocked.</item>
    /// <item><b>ambiguous</b>: anything else, for example when the activity log was cleared. Not blocked.</item>
    /// </list>
    /// <c>ReleaseAttempt</c> and its rows stay. <see cref="DatabaseInitializer"/> logs the counts once.
    /// </summary>
    public partial class AddReleaseBlocks : Migration
    {
        /// <summary>One row per swap (ReleaseSwap.cs CarrySwapLinks): hashes compared lower-case.</summary>
        internal const string SwapsCte = """
            "Swap" AS (
                SELECT "userId" AS "UserId", lower(trim(substr("message", 10))) AS "Old", lower("infoHash") AS "New", "createdAt" AS "At"
                FROM "DownloadHistory"
                WHERE "context" = 'release-swap' AND "message" LIKE 'Replaced %')
            """;

        /// <summary>Every attempt row with its class: replaced, owner-selected or ambiguous. Needs <see cref="SwapsCte"/>.</summary>
        internal const string ClassifiedAttemptsSelect = """
            SELECT a."UserId", a."WorkKey", a."Scope", lower(a."Hash") AS "Hash", a."TriedAt",
                CASE WHEN EXISTS (SELECT 1 FROM "Swap" s WHERE s."UserId" = a."UserId" AND s."Old" = lower(a."Hash")) THEN 'replaced'
                     WHEN EXISTS (SELECT 1 FROM "Swap" s WHERE s."UserId" = a."UserId" AND s."New" = lower(a."Hash")) THEN 'owner-selected'
                     ELSE 'ambiguous' END AS "Class"
            FROM "ReleaseAttempt" a
            """;

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ReleaseBlock",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "TEXT", nullable: false),
                    Hash = table.Column<string>(type: "TEXT", nullable: false),
                    WorkKey = table.Column<string>(type: "TEXT", nullable: false),
                    Scope = table.Column<string>(type: "TEXT", nullable: false),
                    Reason = table.Column<string>(type: "TEXT", nullable: false),
                    Title = table.Column<string>(type: "TEXT", nullable: true),
                    Source = table.Column<string>(type: "TEXT", nullable: true),
                    ReplacedBy = table.Column<string>(type: "TEXT", nullable: true),
                    Origin = table.Column<string>(type: "TEXT", nullable: false),
                    CreatedAt = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ReleaseBlock", x => new { x.UserId, x.Hash });
                });

            migrationBuilder.CreateIndex(
                name: "IX_ReleaseBlock_UserId_WorkKey_Scope",
                table: "ReleaseBlock",
                columns: new[] { "UserId", "WorkKey", "Scope" });

            // Replaced hashes only, one block per user and hash: the latest swap that replaced it, the latest attempt's
            // work and scope, and the old release's name and site from its own history rows.
            migrationBuilder.Sql($"""
                WITH {SwapsCte},
                "Classified" AS ({ClassifiedAttemptsSelect}),
                "Picked" AS (
                    SELECT c."UserId", c."Hash", c."WorkKey", c."Scope", s."New" AS "ReplacedBy", s."At",
                        ROW_NUMBER() OVER (PARTITION BY c."UserId", c."Hash" ORDER BY s."At" DESC, c."TriedAt" DESC) AS "N"
                    FROM "Classified" c
                    JOIN "Swap" s ON s."UserId" = c."UserId" AND s."Old" = c."Hash"
                    WHERE c."Class" = 'replaced' AND length(c."Hash") = 40 AND c."Hash" NOT GLOB '*[^0-9a-f]*')
                INSERT INTO "ReleaseBlock" ("UserId", "Hash", "WorkKey", "Scope", "Reason", "Title", "Source", "ReplacedBy", "Origin", "CreatedAt")
                SELECT p."UserId", p."Hash", p."WorkKey", p."Scope", 'replaced',
                    (SELECT h."title" FROM "DownloadHistory" h WHERE h."userId" = p."UserId" AND lower(h."infoHash") = p."Hash"
                        ORDER BY h."createdAt" DESC LIMIT 1),
                    (SELECT h."source" FROM "DownloadHistory" h WHERE h."userId" = p."UserId" AND lower(h."infoHash") = p."Hash"
                        AND h."source" IS NOT NULL ORDER BY h."createdAt" DESC LIMIT 1),
                    p."ReplacedBy", 'migrated', p."At"
                FROM "Picked" p
                WHERE p."N" = 1;
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ReleaseBlock");
        }
    }
}
