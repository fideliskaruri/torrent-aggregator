using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Clients.External;

namespace TorrentFlow.Engine.Controllers;

[ApiController]
[Route("api/client/torrents")]
public sealed class ClientTorrentsController(
    ITorrentEngine engine,
    ExternalClientRegistry clients,
    IOptions<JsonOptions> json,
    IDbContextFactory<TorrentFlowDbContext> dbFactory) : ControllerBase
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
                var deduped = rows.Where(t => !string.IsNullOrWhiteSpace(t.Hash))
                    .GroupBy(t => t.Hash.Trim().ToLowerInvariant()).Select(g => g.Last());
                var owned = owner == BuiltinOwner
                    ? BuiltinListOrder(deduped).Select(t => BuiltinListRow(Owned(t, owner), t)).ToList()
                    : deduped.Select(t => Owned(t, owner)).ToList();
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
        AnnotateRefused(torrents);
        await AnnotateAcquisitionIntentAsync(torrents, ct);
        await AnnotatePostersAsync(torrents, ct);
        var issues = snapshots.Select(s => s.Issue).OfType<ClientIssue>().ToList();
        return Ok(new ListResponse(torrents, config.ClientType, config.ClientType == "builtin" ? "" : config.Host, false, config.ExternalClientType,
            config.ExternalClientType is not null, issues.Count > 0, issues));
    }

    /// <summary>
    /// The built-in list is sorted by name (numeric-aware) then hash, like builtin-engine listTorrents, so rows
    /// do not jump when a transfer goes live.
    /// </summary>
    private static IEnumerable<EngineTorrentInfo> BuiltinListOrder(IEnumerable<EngineTorrentInfo> rows) =>
        rows.OrderBy(t => t.Name, NameOrder).ThenBy(t => t.Hash, StringComparer.Ordinal);

    private static readonly StringComparer NameOrder =
        StringComparer.Create(System.Globalization.CultureInfo.InvariantCulture, System.Globalization.CompareOptions.NumericOrdering);

    /// <summary>
    /// Matches the shape Next lists for built-in rows. Canonical work identity is resolved below, not inferred
    /// from release names. A row that is not loaded in the client reports no peer count, exactly like the
    /// persisted-row branch there.
    /// </summary>
    private JsonObject BuiltinListRow(JsonObject node, EngineTorrentInfo t)
    {
        node.Remove("workId");
        node.Remove("queueKey");
        if (!IsLoaded(t.Hash)) node.Remove("peers");
        return node;
    }

    private bool IsLoaded(string hash) =>
        HttpContext?.RequestServices.GetService<ITorrentBackend>()?.Contains(hash.Trim().ToLowerInvariant()) == true;

    /// <summary>
    /// client/torrents GET: each transfer carries the work/episode it was acquired for (acquisitionIntentByHash),
    /// so Downloads groups by work instead of guessing from release names.
    /// </summary>
    private async Task AnnotateAcquisitionIntentAsync(List<JsonObject> torrents, CancellationToken ct)
    {
        var hashes = torrents.Select(t => t["hash"]?.GetValue<string>()?.Trim().ToLowerInvariant())
            .OfType<string>().Where(h => h.Length > 0).Distinct().ToList();
        if (hashes.Count == 0) return;
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var targets = await db.AcquisitionTargets.AsNoTracking()
            .Where(a => a.UserId == LocalUser.Id && a.InfoHash != null && hashes.Contains(a.InfoHash.ToLower()))
            .OrderByDescending(a => a.UpdatedAt)
            .Select(a => new AcquisitionIntent(a.InfoHash!, a.WorkId, a.WorkKey, a.Scope, a.Season, a.Episode,
                a.Work != null ? a.Work.CanonicalTitle : null, a.Work != null ? a.Work.Year : null, a.Work != null ? a.Work.MediaType : null))
            .ToListAsync(ct);
        var byHash = IntentByHash(targets);
        var targetHashes = byHash.Keys.ToHashSet(StringComparer.OrdinalIgnoreCase);
        // Request grabs have a canonical work but no owner-created acquisition target.
        // QueueKey (sNNNNNeNNNNN) carries season/episode when the grab knew them.
        var requestTransfers = await db.EngineTorrents.AsNoTracking()
            .Where(t => t.UserId == LocalUser.Id && hashes.Contains(t.Hash) && t.Work != null)
            .Select(t => new { t.Hash, t.WorkId, t.Work!.WorkKey, t.Work.CanonicalTitle, t.Work.Year, t.Work.MediaType, t.QueueKey })
            .ToListAsync(ct);
        foreach (var transfer in requestTransfers)
        {
            var (scope, season, episode) = ScopeFromQueueKey(transfer.QueueKey);
            byHash.TryAdd(transfer.Hash.ToLowerInvariant(), new(transfer.Hash, transfer.WorkId, transfer.WorkKey, scope,
                season, episode, transfer.CanonicalTitle, transfer.Year, transfer.MediaType));
        }
        // Older request downloads predate the work link. Their recorded hashes still provide exact identity,
        // without merging unrelated shows that merely have similar release names.
        var wanted = hashes.Except(byHash.Keys, StringComparer.OrdinalIgnoreCase).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (wanted.Count > 0)
        {
            var requests = await db.MediaRequests.AsNoTracking()
                .Where(r => r.GrabbedHashes != null && (r.Status == "approved" || r.Status == "fulfilled" || r.Status == "partial" || r.Status == "failed"))
                .OrderByDescending(r => r.CreatedAt)
                .Select(r => new { r.GrabbedHashes, r.WorkKey, r.Title, r.Year, r.MediaType }).ToListAsync(ct);
            foreach (var request in requests)
                foreach (var hash in request.GrabbedHashes!.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                    if (wanted.Contains(hash))
                        byHash.TryAdd(hash.ToLowerInvariant(), new(hash, null, request.WorkKey, "title", null, null,
                            request.Title, request.Year, request.MediaType));
        }
        if (byHash.Count == 0) return;
        var workKeys = byHash.Values.Select(t => t.WorkKey).Where(k => !string.IsNullOrEmpty(k)).Distinct().ToList();
        var catalog = (await db.CatalogEntries.AsNoTracking().Where(c => workKeys.Contains(c.WorkKey))
                .OrderByDescending(c => c.RefreshedAt).Select(c => new { c.WorkKey, c.Title, c.Year, c.MediaType }).ToListAsync(ct))
            .GroupBy(c => c.WorkKey).ToDictionary(g => g.Key, g => g.First());
        foreach (var torrent in torrents)
        {
            var hash = torrent["hash"]?.GetValue<string>()?.Trim().ToLowerInvariant();
            if (hash is null || !byHash.TryGetValue(hash, out var target)) continue;
            var entry = catalog.GetValueOrDefault(target.WorkKey);
            torrent["workId"] = target.WorkId;
            torrent["workKey"] = target.WorkKey;
            torrent["workTitle"] = target.CanonicalTitle ?? entry?.Title ?? TorrentFlow.Core.Text.WorkKeySlug.DisplayTitle(target.WorkKey);
            torrent["workYear"] = target.Year ?? entry?.Year;
            torrent["workMediaType"] = (target.MediaType != "unknown" ? target.MediaType : null)
                ?? entry?.MediaType ?? torrent["category"]?.GetValue<string>();
            // Acquisition targets own the full scope triple. Request-lane rows only get season/episode when QueueKey carried them.
            if (targetHashes.Contains(hash))
            {
                torrent["targetScope"] = target.Scope;
                torrent["season"] = target.Season;
                torrent["episode"] = target.Episode;
            }
            else if (target.Season is not null || target.Episode is not null)
            {
                if (target.Scope is "episode" or "season") torrent["targetScope"] = target.Scope;
                if (target.Season is not null) torrent["season"] = target.Season;
                if (target.Episode is not null) torrent["episode"] = target.Episode;
            }
        }
        // Season pack fallback v1: one transfer filling several missing episodes of a season with selected files only.
        var packs = await db.AcquisitionTargets.AsNoTracking()
            .Where(a => a.UserId == LocalUser.Id && a.InfoHash != null && a.FileIndex != null && hashes.Contains(a.InfoHash.ToLower()))
            .GroupBy(a => a.InfoHash!.ToLower()).Select(g => new { Hash = g.Key, Count = g.Count() }).ToListAsync(ct);
        foreach (var torrent in torrents)
        {
            var hash = torrent["hash"]?.GetValue<string>()?.Trim().ToLowerInvariant();
            if (hash != null && packs.FirstOrDefault(p => p.Hash == hash) is { } pack) torrent["packEpisodes"] = pack.Count;
        }
        await AnnotateReplacedAsync(db, torrents, targetHashes, ct);
    }

    /// <summary>
    /// <c>refused</c> marks a release the engine refused (a program file, no video, or not a real video once finished):
    /// retrying it would fetch the same thing, so Downloads never offers Retry. Any row, linked to a title or not.
    /// </summary>
    private static void AnnotateRefused(List<JsonObject> torrents)
    {
        foreach (var torrent in torrents)
            if (torrent["state"] is JsonValue s && s.TryGetValue<string>(out var state) && state == "error"
                && TorrentEngineService.IsRefusedRelease(torrent["error"] is JsonValue e && e.TryGetValue<string>(out var error) ? error : null))
                torrent["refused"] = true;
    }

    /// <summary>
    /// A failed release the app already handed back is history, not something for the owner: <c>replaced</c> when the
    /// film or episode it was fetched for has moved on (another release, Ready, or looking again), so Downloads neither
    /// lists it as needing attention nor offers Retry.
    /// </summary>
    private static async Task AnnotateReplacedAsync(TorrentFlowDbContext db, List<JsonObject> torrents, HashSet<string> linked, CancellationToken ct)
    {
        static string? Text(JsonObject t, string name) => t[name] is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0 ? s : null;
        static int? Number(JsonObject t, string name) => t[name] is JsonValue v && v.TryGetValue<int>(out var n) ? n : null;
        var failed = torrents.Where(t => Text(t, "state") == "error").ToList();
        var orphaned = failed.Where(t => Text(t, "workKey") != null && Text(t, "hash") is { } h && !linked.Contains(h.Trim().ToLowerInvariant())).ToList();
        if (orphaned.Count == 0) return;
        var workKeys = orphaned.Select(t => Text(t, "workKey")!).Distinct().ToList();
        var targets = await db.AcquisitionTargets.AsNoTracking().Where(a => a.UserId == LocalUser.Id && workKeys.Contains(a.WorkKey))
            .Where(a => a.Status != "failed")
            .Select(a => new { a.WorkKey, a.Scope, a.Season, a.Episode }).ToListAsync(ct);
        foreach (var torrent in orphaned)
        {
            var (workKey, season, episode) = (Text(torrent, "workKey"), Number(torrent, "season"), Number(torrent, "episode"));
            // Its own target now points elsewhere: Ready, another release, or the queue looking again. A target that
            // failed with it has nothing in its place, so the error stays for the owner.
            if (targets.Any(a => a.WorkKey == workKey && (episode == null ? a.Scope == "title" : a.Season == season && a.Episode == episode)))
                torrent["replaced"] = true;
        }
    }

    /// <summary>
    /// posterUrl on every row: the linked work's poster (<see cref="WorkPosters"/>), else the release name's
    /// (<see cref="IReleasePosters"/>). A linked work with no art keeps what the release lookup found.
    /// </summary>
    private async Task AnnotatePostersAsync(List<JsonObject> torrents, CancellationToken ct)
    {
        if (torrents.Count == 0) return;
        static string? Text(JsonObject t, string name) => t[name] is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0 ? s : null;
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var known = await WorkPosters.LoadAsync(db, torrents.Select(t => Text(t, "workKey")), ct);
        var unresolved = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var torrent in torrents)
        {
            var poster = WorkPosters.Pick(known, Text(torrent, "workKey"), null);
            torrent["posterUrl"] = poster;
            if (poster is null && Text(torrent, "name") is { } name) unresolved[name] = Text(torrent, "workMediaType") ?? Text(torrent, "category");
        }
        if (unresolved.Count == 0 || HttpContext?.RequestServices.GetService<IReleasePosters>() is not { } releases) return;
        var found = await releases.ForReleasesAsync(unresolved, ct);
        foreach (var torrent in torrents)
        {
            if (torrent["posterUrl"] is not null || Text(torrent, "name") is not { } name || !found.TryGetValue(name, out var poster)) continue;
            torrent["posterUrl"] = poster;
            if (Text(torrent, "workKey") is { } key) await WorkPosters.ResolveAsync(db, key, poster, ct);
        }
    }

    /// <summary>s00001e00002 → episode scope; missing/unparsed keys leave season/episode unknown.</summary>
    internal static (string Scope, int? Season, int? Episode) ScopeFromQueueKey(string? queueKey) =>
        TorrentFlow.Core.QueueKeys.Parse(queueKey) is { } key ? ("episode", key.Season, key.Episode) : ("title", null, null);

    internal sealed record AcquisitionIntent(string InfoHash, string? WorkId, string WorkKey, string Scope, int? Season, int? Episode,
        string? CanonicalTitle, int? Year, string? MediaType);

    /// <summary>
    /// acquisition-intent.ts: a non-episode target wins; one episode is itself; several episodes of one torrent
    /// collapse to its season (or no season when they span seasons). Input is newest first.
    /// </summary>
    internal static Dictionary<string, AcquisitionIntent> IntentByHash(IEnumerable<AcquisitionIntent> targets) =>
        targets.Where(t => !string.IsNullOrWhiteSpace(t.InfoHash))
            .GroupBy(t => t.InfoHash.Trim().ToLowerInvariant())
            .ToDictionary(g => g.Key, g =>
            {
                var rows = g.ToList();
                if (rows.FirstOrDefault(r => r.Scope != "episode") is { } whole) return whole;
                var first = rows[0];
                var seasons = rows.Select(r => r.Season).Distinct().Count();
                var episodes = rows.Select(r => r.Episode).Distinct().Count();
                if (seasons == 1 && episodes == 1) return first;
                return first with { Scope = "season", Season = seasons == 1 ? first.Season : null, Episode = null };
            });

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
        if (body.TryGetProperty("hashes", out var list)) return await DeleteManyAsync(body, action, list, ct);
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

    /// <summary>
    /// <c>{action:"delete", hashes:[…], ownerClientType:"builtin"}</c>: one delete for a whole selection, so a season's
    /// episodes are removed together and their shared season folder goes with the last of them.
    /// </summary>
    private async Task<IActionResult> DeleteManyAsync(System.Text.Json.JsonElement body, string? action, System.Text.Json.JsonElement list, CancellationToken ct)
    {
        var owner = body.Str("ownerClientType");
        if (action != "delete" || owner != "builtin")
            return BadRequest(new { error = "hashes is only supported for deleting built-in downloads" });
        if (list.ValueKind != System.Text.Json.JsonValueKind.Array || list.GetArrayLength() is 0 or > 1000
            || list.EnumerateArray().Any(h => h.ValueKind != System.Text.Json.JsonValueKind.String || string.IsNullOrWhiteSpace(h.GetString())))
            return BadRequest(new { error = "hashes must be a non-empty array of info hashes" });
        var hashes = list.EnumerateArray().Select(h => h.GetString()!.Trim().ToLowerInvariant()).Distinct().ToList();
        var deleteFiles = body.Bool("deleteFiles") ?? true;

        var results = new Dictionary<string, (bool Ok, string Message)>();
        var removable = new List<string>();
        var config = deleteFiles ? await clients.GetConfigAsync(ct) : null;
        foreach (var hash in hashes)
        {
            var torrent = await engine.GetAsync(hash, ct);
            if (torrent is null) { results[hash] = (false, "That transfer was not found in its recorded owner. Refresh and try again."); continue; }
            if (config is not null && (await clients.CheckDeleteAsync(config, owner, torrent, ct)).Message is { } refused)
            {
                results[hash] = (false, refused);
                continue;
            }
            removable.Add(hash);
        }
        foreach (var (hash, result) in await engine.RemoveManyAsync(removable, deleteFiles, ct))
            results[hash] = (result.Ok, result.Message);

        var failed = results.Count(r => !r.Value.Ok);
        return StatusCode(failed == 0 ? 200 : 502, new
        {
            ok = failed == 0,
            message = failed == 0 ? $"Removed {hashes.Count}" : $"{failed} of {hashes.Count} could not be removed.",
            ownerClientType = owner,
            offline = false,
            results = hashes.Select(h => new { hash = h, ok = results[h].Ok, message = results[h].Message }),
        });
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
