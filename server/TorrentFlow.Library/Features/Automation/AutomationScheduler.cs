using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Data;
using TorrentFlow.Library.Features.Common;

namespace TorrentFlow.Library.Features.Automation;

public sealed class AutomationScheduler(IDbContextFactory<TorrentFlowDbContext> factory, AutomationService automation,
    IConfiguration configuration, ILogger<AutomationScheduler> logger, AutomationWake wake) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (configuration.GetValue<bool>("TorrentFlow:Library:DisableScheduler")) return;
        logger.LogInformation("[scheduler] automation scheduler armed");
        var delay = TimeSpan.FromSeconds(30);
        var nextRules = DateTime.MinValue;
        while (!stoppingToken.IsCancellationRequested)
        {
            await wake.Wait(delay, stoppingToken);
            delay = TimeSpan.FromMinutes(5);
            try
            {
                await using var db = await factory.CreateDbContextAsync(stoppingToken);
                var minutes = await db.ClientSettings.Where(x => x.UserId == LocalUser.Id).Select(x => x.AutomationIntervalMinutes).FirstOrDefaultAsync(stoppingToken);
                if (minutes is not > 0) continue;
                var now = DateTime.UtcNow;
                var due = await db.WatchListItems.Where(x => x.UserId == LocalUser.Id && x.Monitored == true &&
                    (x.Status == "watching" || x.Status == "planned") && (x.NextCheckAt == null || x.NextCheckAt <= now))
                    .OrderBy(x => x.NextCheckAt).ThenBy(x => x.LastChecked).Select(x => x.Id).Take(50).ToListAsync(stoppingToken);
                var runRules = now >= nextRules;
                var result = await automation.Run(due, stoppingToken, runRules);
                if (runRules) nextRules = now.AddMinutes(Math.Max(15, minutes.Value));
                var earliest = await db.WatchListItems.Where(x => x.UserId == LocalUser.Id && x.Monitored == true &&
                    (x.Status == "watching" || x.Status == "planned"))
                    .OrderBy(x => x.NextCheckAt).Select(x => (DateTime?)(x.NextCheckAt ?? now)).FirstOrDefaultAsync(stoppingToken);
                delay = CheckSchedule.Delay(DateTime.UtcNow, earliest < nextRules ? earliest : nextRules, minutes.Value);
                logger.LogInformation("[scheduler] {Message}", result["message"]);
            }
            catch (Exception error) when (!stoppingToken.IsCancellationRequested) { logger.LogError(error, "[scheduler] run failed"); }
        }
    }
}

[ApiController, Route("api/automation/run"), ServiceFilter(typeof(LibraryExceptionFilter))]
public sealed class AutomationController(AutomationService automation) : ControllerBase
{
    [HttpPost]
    public async Task<IActionResult> Run(CancellationToken ct)
    {
        Fields.Guard(Request);
        var summary = await automation.Run(ct);
        return Ok(new { ok = true, offline = summary["offline"], message = summary["message"], summary });
    }
}
