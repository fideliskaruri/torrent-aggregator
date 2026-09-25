using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using TorrentFlow.Data;
using TorrentFlow.Engine.Client;

namespace TorrentFlow.Engine.Controllers;

/// <summary>
/// /api/diagnostics/health. The shared sections and <c>enginePressure</c> follow the Next.js contract
/// (observability/responses.ts buildDiagnosticsHealthResponse, clients/engine-pressure.ts). Sections backed by
/// Node-only machinery (named cache registry, event-loop delay, completion sweep, component health) have no .NET
/// counterpart and stay at their empty/null defaults; .NET process memory is reported under <c>runtime</c>.
/// </summary>
[ApiController]
[Route("api/diagnostics/health")]
public sealed class DiagnosticsHealthController(TorrentFlowDbContext db, IOptionsMonitor<EngineOptions> options) : ControllerBase
{
    private static readonly DateTime Started = Process.GetCurrentProcess().StartTime.ToUniversalTime();
    /// <summary>engine-pressure.ts COMPLETE_PROGRESS.</summary>
    private const double CompleteProgress = 0.9999;

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var dbUp = false;
        try { dbUp = await db.Database.CanConnectAsync(ct); }
        catch (Exception ex) when (ex is DbUpdateException or InvalidOperationException or Microsoft.Data.Sqlite.SqliteException) { }
        var latency = Math.Clamp((int)Math.Round(sw.Elapsed.TotalMilliseconds), 0, 30_000);

        using var proc = Process.GetCurrentProcess();
        Response.Headers.CacheControl = "no-store";
        var body = new Dictionary<string, object?>
        {
            ["status"] = dbUp ? "ok" : "degraded",
            ["live"] = true,
            ["ready"] = dbUp,
            ["timestamp"] = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture),
            ["process"] = new { status = "up", uptimeSeconds = Math.Max(0, (long)(DateTime.UtcNow - Started).TotalSeconds) },
            ["build"] = new { id = typeof(EngineModule).Assembly.GetName().Version?.ToString() ?? "dev" },
            ["database"] = new { status = dbUp ? "up" : "down", latencyMs = latency },
            ["caches"] = new Dictionary<string, long>(),
            ["cacheRegistry"] = new { names = Array.Empty<string>(), missing = Array.Empty<string>() },
            ["enginePressure"] = EnginePressure(),
            ["completionSweep"] = null,
            ["eventLoopDelay"] = null,
            ["eventLoopDelayRecent"] = null,
            ["components"] = Array.Empty<object>(),
            ["runtime"] = new
            {
                rssBytes = proc.WorkingSet64,
                privateBytes = proc.PrivateMemorySize64,
                managedHeapBytes = GC.GetTotalMemory(false),
                maxActiveDownloads = options.CurrentValue.MaxActiveDownloads,
                maxConnections = options.CurrentValue.MaxConnections,
                diskCacheBytes = options.CurrentValue.DiskCacheBytes,
            },
        };
        return StatusCode(dbUp ? 200 : 503, body);
    }

    /// <summary>
    /// Aggregate pressure over transfers loaded in the client, redacted like redactEnginePressureDetails (no
    /// per-torrent names or hashes). The MonoTorrent client exists for the process lifetime, so it is always present.
    /// Parking and park retries are not separate states here: a completed transfer detaches in the monitor pass
    /// unless a reader holds it open, which is what <c>streamLeases</c> counts.
    /// </summary>
    private object EnginePressure()
    {
        var live = HttpContext.RequestServices.GetRequiredService<ITorrentBackend>().List();
        var engine = HttpContext.RequestServices.GetRequiredService<TorrentEngineService>();
        int active = 0, paused = 0, complete = 0, peers = 0, leases = 0, leased = 0, unknown = 0;
        long down = 0, up = 0;
        foreach (var t in live)
        {
            if (t.State == "paused") paused++; else active++;
            if (t.Progress >= CompleteProgress && t.State == "complete") complete++;
            peers += Math.Max(0, t.Peers);
            down += Math.Max(0, t.DownloadRate);
            up += Math.Max(0, t.UploadRate);
            var open = engine.OpenStreamCount(t.Hash);
            leases += open;
            if (open > 0) leased++;
            if (!t.HasMetadata) unknown++;
        }
        return new
        {
            clientPresent = true,
            totals = new
            {
                torrents = live.Count,
                active,
                paused,
                complete,
                peers,
                // MonoTorrent's peer count is its open connections: each connected peer is one wire.
                wires = peers,
                downloadSpeed = down,
                uploadSpeed = up,
                streamLeases = leases,
                leasedTorrents = leased,
                parking = 0,
                parkRetryPending = 0,
                completionMismatch = 0,
                verificationUnknown = unknown,
            },
            torrents = Array.Empty<object>(),
        };
    }
}
