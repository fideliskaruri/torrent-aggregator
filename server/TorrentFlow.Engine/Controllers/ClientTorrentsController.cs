using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Clients.External;

namespace TorrentFlow.Engine.Controllers;

[ApiController]
[Route("api/client/torrents")]
public sealed class ClientTorrentsController(ITorrentEngine engine, ExternalClientRegistry clients, IOptions<JsonOptions> json) : ControllerBase
{
    private static readonly string[] Actions = ["pause", "resume", "delete", "force"];
    private static readonly string[] Owners = ["builtin", "qbittorrent", "transmission"];
    public const string BuiltinOwner = "builtin";
    /// <summary>transfer-ownership clientTypeLabel("builtin").</summary>
    public const string BuiltinOwnerLabel = "Built-in";

    public sealed record ClientIssue(string ClientType, string Label, string Message, bool Offline);

    public sealed record ListResponse(
        IReadOnlyList<JsonObject> Torrents,
        string ClientType,
        string Host,
        bool Offline,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? ExternalClientType,
        bool HasExternal,
        bool Partial,
        IReadOnlyList<ClientIssue> ClientIssues);

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var config = await clients.GetConfigAsync(ct);
        var snapshots = await Task.WhenAll(ExternalClientRegistry.Sources(config).Select(async owner =>
        {
            try
            {
                var rows = await clients.ListAsync(config, owner, ct);
                var owned = rows.Where(t => !string.IsNullOrWhiteSpace(t.Hash))
                    .GroupBy(t => t.Hash.Trim().ToLowerInvariant()).Select(g => g.Last())
                    .Select(t => Owned(owner == "builtin" ? StripCacheStats(t) : t, owner)).ToList();
                return (Torrents: owned, Issue: (ClientIssue?)null);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                var error = ExternalClientErrors.Format(ex, owner);
                return (Torrents: new List<JsonObject>(), Issue: new ClientIssue(owner, ExternalClientRegistry.Label(owner),
                    error.Offline ? $"{ExternalClientRegistry.Label(owner)} is unavailable." : error.Message, error.Offline));
            }
        }));
        var torrents = snapshots.SelectMany(s => s.Torrents).ToList();
        var issues = snapshots.Select(s => s.Issue).OfType<ClientIssue>().ToList();
        return Ok(new ListResponse(torrents, config.ClientType, config.ClientType == "builtin" ? "" : config.Host, false, config.ExternalClientType,
            config.ExternalClientType is not null, issues.Count > 0, issues));
    }

    /// <summary>Stream/prewarm entries are cache, not downloads: the UI must not show their live speeds as progress.</summary>
    internal static EngineTorrentInfo StripCacheStats(EngineTorrentInfo t) =>
        t.RetentionState is "stream" or "prewarm"
            ? t with { Progress = 0, Dlspeed = 0, Upspeed = 0, Eta = 0, Peers = 0 }
            : t;

    /// <summary>OwnedClientTorrent: the transfer tagged with the client that owns it (transfer-ownership tagOwnedTorrents).</summary>
    private JsonObject Owned(EngineTorrentInfo t, string owner = BuiltinOwner)
    {
        var node = JsonSerializer.SerializeToNode(t, json.Value.JsonSerializerOptions)!.AsObject();
        node["hash"] = t.Hash.Trim();
        node["ownerClientType"] = owner;
        node["ownerClientLabel"] = ExternalClientRegistry.Label(owner);
        node["transferId"] = $"{owner}:{t.Hash.Trim().ToLowerInvariant()}";
        if (owner != "builtin") node["savePath"] = t.SavePath;
        return node;
    }

    private static string Label(string clientType) => clientType switch
    {
        "qbittorrent" => "qBittorrent",
        "transmission" => "Transmission",
        _ => "Built-in engine",
    };

    [HttpPost]
    public async Task<IActionResult> Act(CancellationToken ct)
    {
        if (await JsonBody.ReadAsync(Request, ct) is not { } body) return JsonBody.InvalidJson();
        var action = body.Str("action");
        var hash = body.Str("hash")?.Trim().ToLowerInvariant();
        var owner = body.Str("ownerClientType");
        if (string.IsNullOrEmpty(action) || string.IsNullOrEmpty(hash) || string.IsNullOrEmpty(owner))
            return BadRequest(new { error = "action, hash and ownerClientType required" });
        if (!Owners.Contains(owner)) return BadRequest(new { error = "Invalid ownerClientType" });
        if (!Actions.Contains(action)) return BadRequest(new { error = "Action not supported" });

        if (owner != "builtin")
            return await ExternalActionAsync(owner, action, hash, body.Bool("deleteFiles") ?? true, ct);

        if (await engine.GetAsync(hash, ct) is null)
            return NotFound(new { ok = false, message = "That transfer was not found in its recorded owner. Refresh and try again." });

        if (action == "delete" && body.Bool("deleteFiles") != false)
        {
            var config = await clients.GetConfigAsync(ct);
            var torrent = await engine.GetAsync(hash, ct);
            if (torrent is not null)
            {
                var check = await clients.CheckDeleteAsync(config, owner, torrent, ct);
                if (check.Message is not null) return StatusCode(check.Status, new { ok = false, message = check.Message });
            }
        }

        var result = action switch
        {
            "pause" => await engine.PauseAsync(hash, ct),
            "resume" => await engine.ResumeAsync(hash, ct),
            "force" => await engine.ForceAsync(hash, ct),
            _ => await engine.RemoveAsync(hash, body.Bool("deleteFiles") ?? true, ct),
        };

        var response = new Dictionary<string, object?>
        {
            ["ok"] = result.Ok,
            ["message"] = result.Ok ? result.Message : "Torrent action failed.",
            ["ownerClientType"] = owner,
            ["offline"] = false,
        };
        if (!result.Ok) response["detail"] = result.Message;
        // "Download now" changes the row the UI is rendering, so hand back the new state instead of waiting for the 5s poll.
        if (action == "force" && result.Ok)
        {
            var t = await engine.GetAsync(hash, ct);
            response["torrent"] = t is null ? null : Owned(t with { Files = null });
        }
        return StatusCode(result.Ok ? 200 : 502, response);
    }

    private async Task<IActionResult> ExternalActionAsync(string owner, string action, string hash, bool deleteFiles, CancellationToken ct)
    {
        var config = await clients.GetConfigAsync(ct);
        EngineTorrentInfo? torrent;
        try { torrent = await clients.FindAsync(config, owner, hash, ct); }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            var error = ExternalClientErrors.Format(ex, owner);
            return StatusCode(error.Offline ? 503 : 502, new
            {
                ok = false, message = error.Offline ? $"{Label(owner)} is unavailable." : error.Message, offline = error.Offline,
            });
        }
        if (torrent is null)
            return NotFound(new { ok = false, message = "That transfer was not found in its recorded owner. Refresh and try again." });
        if (action == "force") return BadRequest(new { ok = false, message = $"{Label(owner)} does not queue downloads." });
        if (action == "delete" && deleteFiles)
        {
            var check = await clients.CheckDeleteAsync(config, owner, torrent, ct);
            if (check.Message is not null) return StatusCode(check.Status, new { ok = false, message = check.Message });
        }
        var result = await clients.Get(owner).ActAsync(config with { ClientType = owner }, action, hash, deleteFiles, ct);
        if (action == "delete" && result.Ok)
        {
            try
            {
                if (await clients.FindAsync(config, owner, hash, ct) is not null)
                    result = new(false, $"{Label(owner)} did not remove that transfer.");
            }
            catch (Exception) when (!ct.IsCancellationRequested)
            {
                result = new(false, $"Could not verify that {Label(owner)} removed that transfer.");
            }
        }
        if (action == "delete" && deleteFiles && result.Ok)
        {
            var pruned = await clients.ConfirmedRemovalAsync(config, owner, torrent, ct);
            if (pruned > 0) result = result with { Message = $"{result.Message} · cleaned {pruned} empty folder(s)" };
        }
        return StatusCode(result.Ok ? 200 : 502, new
        {
            ok = result.Ok, message = result.Ok ? result.Message : "Torrent action failed.", ownerClientType = owner, offline = false,
        });
    }
}
