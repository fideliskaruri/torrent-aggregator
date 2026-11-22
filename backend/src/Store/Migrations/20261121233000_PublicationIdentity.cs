using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace TorrentFlow.Store.Migrations;

[DbContext(typeof(TorrentFlowDbContext))]
[Migration("20261121233000_PublicationIdentity")]
public sealed class PublicationIdentity : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(name: "sourceIdentity", table: "FileOperation", type: "TEXT", nullable: true);
        migrationBuilder.AddColumn<string>(name: "bindingFingerprint", table: "FileOperation", type: "TEXT", nullable: true);
    }
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(name: "sourceIdentity", table: "FileOperation");
        migrationBuilder.DropColumn(name: "bindingFingerprint", table: "FileOperation");
    }
}
