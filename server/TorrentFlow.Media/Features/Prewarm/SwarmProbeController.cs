using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Media.Features.Prewarm;

/// <summary>Swarm-probe settings + visibility (src/app/api/prewarm/swarm-probe/route.ts).</summary>
[ApiController]
[Route("api/prewarm/swarm-probe")]
public sealed class SwarmProbeController(IDbContextFactory<TorrentFlowDbContext> factory, PreProber prober, SwarmMeasurements swarm, TimeProvider time) : ControllerBase
{
    private static readonly object[] Choices =
    [
        new { value = "off", label = "Off" },
        new { value = "watching", label = "Only what I'm watching" },
        new { value = "monitored", label = "Everything I monitor" },
    ];

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        try
        {
            var scope = await prober.ResolveScopeAsync(LocalUser.Id, ct);
            var measurements = await swarm.ListRecentAsync(SwarmMeasurements.RecentLimit, ct);
            return PrewarmHttp.Json(new
            {
                scope,
                defaultScope = PreProber.DefaultScope,
                choices = Choices,
                measurements = measurements.Select(m => new
                {
                    infoHash = m.InfoHash,
                    name = m.Name,
                    verdict = m.Verdict,
                    peersConnected = m.PeersConnected,
                    peersUnchoked = m.PeersUnchoked,
                    effectiveBps = m.EffectiveBps,
                    requiredBps = m.RequiredBps,
                    measuredAt = PrewarmHttp.Iso(m.MeasuredAt),
                    expiresAt = PrewarmHttp.Iso(m.ExpiresAt),
                    expired = m.Expired,
                }),
            });
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            return PrewarmHttp.Json(new { error = e.Message, scope = PreProber.DefaultScope, measurements = Array.Empty<object>() }, 500);
        }
    }

    [HttpPut]
    public async Task<IActionResult> Put(CancellationToken ct)
    {
        if (await PrewarmHttp.ReadJsonAsync(Request, ct) is not { } body) return PrewarmHttp.Json(new { error = "Invalid JSON" }, 400);
        // An unrecognised scope clamps to the default rather than being rejected.
        var scope = PreProber.NormalizeScope(PrewarmHttp.Str(body, "scope"));
        try
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            var now = time.GetUtcNow().UtcDateTime;
            var row = await db.ClientSettings.FirstOrDefaultAsync(s => s.UserId == LocalUser.Id, ct);
            if (row is null)
            {
                // Created lazily elsewhere; a minimal row carries the schema defaults.
                db.ClientSettings.Add(new ClientSetting
                {
                    Id = Ids.New(),
                    UserId = LocalUser.Id,
                    ClientType = "builtin",
                    Host = "http://127.0.0.1:8080",
                    DefaultRetentionPolicy = "EPHEMERAL",
                    PreProbeScope = scope,
                    CreatedAt = now,
                    UpdatedAt = now,
                });
            }
            else
            {
                row.PreProbeScope = scope;
                row.UpdatedAt = now;
            }
            await db.SaveChangesAsync(ct);
            return PrewarmHttp.Json(new { ok = true, scope });
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            return PrewarmHttp.Json(new { error = e.Message }, 500);
        }
    }
}
