using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;

namespace TorrentFlow.Engine.Controllers;

/// <summary>
/// Engine-facing part of /api/diagnostics/health. Other modules' sections (caches, event loop) have no .NET
/// equivalent yet; the engine reports process memory, live torrents/peers and the queue so RAM is observable.
/// </summary>
[ApiController]
[Route("api/diagnostics/health")]
public sealed class DiagnosticsHealthController(TorrentFlowDbContext db, ITorrentEngine engine, IOptionsMonitor<EngineOptions> options) : ControllerBase
{
    private static readonly DateTime Started = Process.GetCurrentProcess().StartTime.ToUniversalTime();

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var dbUp = false;
        try { dbUp = await db.Database.CanConnectAsync(ct); }
        catch (Exception ex) when (ex is DbUpdateException or InvalidOperationException or Microsoft.Data.Sqlite.SqliteException) { }
        var latency = sw.ElapsedMilliseconds;

        var torrents = await engine.ListAsync(ct);
        var live = torrents.Where(t => t.State is "downloading" or "stalledDL" or "metaDL" or "checkingDL").ToList();
        using var proc = Process.GetCurrentProcess();
        var gc = GC.GetGCMemoryInfo();
        var body = new Dictionary<string, object?>
        {
            ["status"] = dbUp ? "ok" : "degraded",
            ["live"] = true,
            ["ready"] = dbUp,
            ["timestamp"] = DateTime.UtcNow.ToString("O"),
            ["process"] = new { status = "up", uptimeSeconds = (long)(DateTime.UtcNow - Started).TotalSeconds },
            ["build"] = new { id = typeof(EngineModule).Assembly.GetName().Version?.ToString() ?? "dev" },
            ["database"] = new { status = dbUp ? "up" : "down", latencyMs = latency },
            ["caches"] = new Dictionary<string, long>(),
            ["cacheRegistry"] = new { names = Array.Empty<string>(), missing = Array.Empty<string>() },
            ["enginePressure"] = new
            {
                rssBytes = proc.WorkingSet64,
                privateBytes = proc.PrivateMemorySize64,
                managedHeapBytes = GC.GetTotalMemory(false),
                gcHeapSizeBytes = gc.HeapSizeBytes,
                gcCommittedBytes = gc.TotalCommittedBytes,
                gcFragmentedBytes = gc.FragmentedBytes,
                gcServer = System.Runtime.GCSettings.IsServerGC,
                gcCollections = new[] { GC.CollectionCount(0), GC.CollectionCount(1), GC.CollectionCount(2) },
                threads = proc.Threads.Count,
                handles = proc.HandleCount,
                liveTorrents = live.Count,
                peers = live.Sum(t => t.Peers ?? 0),
                queued = torrents.Count(t => t.State == "queued"),
                maxActiveDownloads = options.CurrentValue.MaxActiveDownloads,
                maxConnections = options.CurrentValue.MaxConnections,
                diskCacheBytes = options.CurrentValue.DiskCacheBytes,
                downloadRate = live.Sum(t => t.Dlspeed),
            },
            ["completionSweep"] = null,
            ["eventLoopDelay"] = null,
            ["eventLoopDelayRecent"] = null,
            ["components"] = Array.Empty<object>(),
        };
        return StatusCode(dbUp ? 200 : 503, body);
    }
}
