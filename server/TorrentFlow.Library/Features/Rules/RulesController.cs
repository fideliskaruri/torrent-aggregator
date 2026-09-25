using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Automation;

namespace TorrentFlow.Library.Features.Rules;

[ApiController, Route("api/rules"), ServiceFilter(typeof(LibraryExceptionFilter))]
public sealed class RulesController(IDbContextFactory<TorrentFlowDbContext> factory, AutomationService automation) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var rules = await db.AutoRules.AsNoTracking().Where(x => x.UserId == LocalUser.Id).OrderByDescending(x => x.UpdatedAt).ToListAsync(ct);
        return Ok(new { rules = rules.Select(LibraryJson.Row) });
    }
    [HttpPost, HttpPatch]
    public async Task<IActionResult> Save(CancellationToken ct)
    {
        var f = await Fields.Read(Request, ct);
        var patch = Request.Method == "PATCH";
        var id = patch ? f.String("id", true, 128) : null;
        var name = f.String("name", !patch, 200);
        var query = f.String("query", !patch);
        var category = f.Enum("category", ["all", "anime", "movies", "tv"]);
        var seeders = (int?)f.Number("minSeeders", max: 10000000, integer: true);
        var size = (long?)f.Number("maxSizeBytes", min: 1, max: 9007199254740991, integer: true, nullable: true);
        var resolution = f.Enum("resolution", ["480p", "720p", "1080p", "2160p"], nullable: true);
        var sources = f.String("sources", nullable: true);
        if (sources != null)
        {
            var parts = sources.Split(',').Select(x => x.Trim()).ToArray();
            if (parts.Length > 7 || parts.Any(string.IsNullOrEmpty)) Fields.Fail("sources may contain at most 7 non-empty values", "sources");
            foreach (var source in parts)
                if (!new[] { "nyaa", "1337x", "apibay", "torrentscsv", "yts", "archive", "torznab" }.Contains(source)) Fields.Fail($"Unknown rule source `{source}`", "sources");
            sources = string.Join(',', parts.Distinct());
        }
        var enabled = f.Bool("enabled");
        var run = !patch && f.Bool("run") == true;
        await using var db = await factory.CreateDbContextAsync(ct);
        var rule = patch ? await db.AutoRules.FirstOrDefaultAsync(x => x.UserId == LocalUser.Id && x.Id == id, ct) : null;
        if (patch && rule == null) return NotFound(new { error = "Not found" });
        if (rule == null)
        {
            rule = new() { Id = Ids.New(), UserId = LocalUser.Id, Name = name!, Query = query!, Category = "all", MinSeeders = 10, Enabled = true, CreatedAt = DateTime.UtcNow };
            db.AutoRules.Add(rule);
        }
        if (name != null) rule.Name = name;
        if (query != null) rule.Query = query;
        if (category != null) rule.Category = category;
        if (seeders != null) rule.MinSeeders = seeders.Value;
        if (f.Has("maxSizeBytes")) rule.MaxSizeBytes = size;
        if (f.Has("resolution")) rule.Resolution = resolution;
        if (f.Has("sources")) rule.Sources = sources;
        if (enabled != null) rule.Enabled = enabled;
        rule.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        var body = LibraryJson.Object(("rule", LibraryJson.Row(rule)));
        if (!patch) body["runResult"] = run ? await automation.Rules(ct) : null;
        return Ok(body);
    }
    [HttpDelete]
    public async Task<IActionResult> Delete(CancellationToken ct)
    {
        Fields.Guard(Request);
        var id = Fields.Query(Request, "id", required: true, maxLength: 128)!;
        await using var db = await factory.CreateDbContextAsync(ct);
        await db.AutoRules.Where(x => x.Id == id && x.UserId == LocalUser.Id).ExecuteDeleteAsync(ct);
        return Ok(new { ok = true });
    }
    [HttpPost("run")]
    public async Task<IActionResult> Run(CancellationToken ct)
    {
        Fields.Guard(Request);
        var summary = await automation.Rules(ct);
        var sent = summary.Count(x => x.Status == "sent");
        var failed = summary.Count(x => x.Status == "failed");
        var skipped = summary.Count(x => x.Status == "skipped");
        return Ok(new { ok = true, offline = false, message = $"Rules finished · {sent} sent · {failed} failed · {skipped} skipped", summary });
    }
}
