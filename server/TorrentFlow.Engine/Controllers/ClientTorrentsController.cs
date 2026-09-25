using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Engine.Controllers;

[ApiController]
[Route("api/client/torrents")]
public sealed class ClientTorrentsController(ITorrentEngine engine, ClientSettingsStore settings, IOptions<JsonOptions> json) : ControllerBase
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
        var config = await settings.GetConfigAsync(ct);
        var torrents = (await engine.ListAsync(ct)).Select(t => Owned(StripCacheStats(t))).ToList();
        var issues = new List<ClientIssue>();
        if (config.ClientType is "qbittorrent" or "transmission")
            issues.Add(new ClientIssue(config.ClientType, Label(config.ClientType),
                $"{Label(config.ClientType)} is not supported by this server yet; showing built-in transfers only.", false));
        return Ok(new ListResponse(torrents, config.ClientType, config.ClientType == "builtin" ? "" : config.Host, false, config.ExternalClientType,
            config.ExternalClientType is not null, issues.Count > 0, issues));
    }

    /// <summary>Stream/prewarm entries are cache, not downloads: the UI must not show their live speeds as progress.</summary>
    internal static EngineTorrentInfo StripCacheStats(EngineTorrentInfo t) =>
        t.RetentionState is "stream" or "prewarm"
            ? t with { Progress = 0, Dlspeed = 0, Upspeed = 0, Eta = 0, Peers = 0 }
            : t;

    /// <summary>OwnedClientTorrent: the transfer tagged with the client that owns it (transfer-ownership tagOwnedTorrents).</summary>
    private JsonObject Owned(EngineTorrentInfo t)
    {
        var node = JsonSerializer.SerializeToNode(t, json.Value.JsonSerializerOptions)!.AsObject();
        node["ownerClientType"] = BuiltinOwner;
        node["ownerClientLabel"] = BuiltinOwnerLabel;
        node["transferId"] = $"{BuiltinOwner}:{t.Hash.Trim().ToLowerInvariant()}";
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
        {
            if (action == "force") return BadRequest(new { ok = false, message = $"{Label(owner)} does not queue downloads." });
            return StatusCode(503, new { ok = false, message = "The configured torrent client is unavailable.", offline = true, code = "CLIENT_UNSUPPORTED" });
        }

        if (await engine.GetAsync(hash, ct) is null)
            return NotFound(new { ok = false, message = "That transfer was not found in its recorded owner. Refresh and try again." });

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
}
