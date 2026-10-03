using System.Collections.Immutable;
using System.Diagnostics;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Engine;

namespace TorrentFlow.Api;

internal static class DevCheck
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    { Converters = { new JsonStringEnumConverter() } };

    internal static void MapDevCheck(this WebApplication app)
    {
        if (!app.Environment.IsDevelopment()) return;
        var group = app.MapGroup("/api/dev/check").AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var actor = AccessIdentity.Actor(http);
            if (actor.Role != UserRole.Owner || !actor.TrustedLocal ||
                http.Connection.RemoteIpAddress is not { } ip || !IPAddress.IsLoopback(ip))
                return Results.StatusCode(403);
            try { return await next(context); }
            catch (Exception ex) when (ex is ArgumentException or FormatException or JsonException)
            { return Results.BadRequest(new { error = "invalid_input", message = ex.Message }); }
        });
        group.MapGet("/", async (string? hashes, int? limit, ICheck check, CancellationToken ct) =>
            Results.Json(hashes is null ? await check.RecentAsync(limit ?? 100, ct) :
                await check.LoadAsync([.. hashes.Split(',').Select(MonoTorrentEngine.NormalizeHash)], ct), Json));
        group.MapGet("/status", (ICheck check) => Results.Json(check.Diagnostics, Json));
        group.MapPost("/metadata-wait", async (WaitInput input, IEngine engine, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(input.TargetId) || input.TargetId.Length > 200)
                return Results.BadRequest(new { error = "Provide a bounded targetId." });
            var candidate = MonoTorrentEngine.CandidateFor(input.Magnet ?? input.Hash ??
                throw new ArgumentException("Provide hash or magnet."), null);
            return Results.Json(await engine.AttachMetadataWaitAsync(
                new(input.TargetId, candidate, DateTimeOffset.UtcNow.AddMinutes(45)), ct), Json);
        });
        group.MapGet("/metadata-wait/{token}", async (string token, IEngine engine, CancellationToken ct) =>
            Results.Json(await engine.ObserveMetadataWaitAsync(token, ct), Json));
        group.MapDelete("/metadata-wait/{token}", async (string token, IEngine engine, CancellationToken ct) =>
        {
            await engine.ReleaseMetadataWaitAsync(token, ct);
            return Results.NoContent();
        });
        group.MapPost("/", async (CheckInput input, HttpContext http, ICheck check, CancellationToken ct) =>
        {
            if (input.Candidates is null || input.Candidates.Length is < 1 or > 100)
                return Results.BadRequest(new { error = "Provide 1..100 candidates." });
            var requests = input.Candidates.Select(item =>
            {
                var link = item.Magnet ?? item.Hash ?? throw new ArgumentException("Provide hash or magnet.");
                var hash = MonoTorrentEngine.NormalizeHash(link);
                if (item.Hash is not null && MonoTorrentEngine.NormalizeHash(item.Hash) != hash)
                    throw new ArgumentException("Hash and magnet must identify the same torrent.");
                if (item.Trackers is { Length: > 0 })
                {
                    if (item.Trackers.Length > 50 || item.Trackers.Any(t =>
                        !Uri.TryCreate(t, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https" or "udp")))
                        throw new ArgumentException("Provide at most 50 HTTP, HTTPS or UDP trackers.");
                    if (!link.StartsWith("magnet:", StringComparison.OrdinalIgnoreCase))
                        link = "magnet:?xt=urn:btih:" + hash;
                    link += string.Concat(item.Trackers.Select(t => "&tr=" + Uri.EscapeDataString(t)));
                }
                var xs = link.Split('&').FirstOrDefault(p => p.StartsWith("xs=", StringComparison.Ordinal));
                var candidate = MonoTorrentEngine.CandidateFor(link, item.TorrentUri ??
                    (xs is null ? null : Uri.UnescapeDataString(xs[3..])));
                candidate = candidate with
                {
                    Release = candidate.Release with { Name = item.Name ?? candidate.Release.Name },
                    ConservativeListedSeeders = item.ListedSeeders,
                };
                return new ProbeRequest(candidate, input.Background ? PriorityLane.Background : PriorityLane.Owner,
                    input.ForceFresh, true);
            }).ToImmutableArray();
            var clock = Stopwatch.StartNew();
            var results = new List<SwarmEvidence>();
            if (input.Stream) http.Response.ContentType = "application/x-ndjson";
            await foreach (var evidence in check.ProbeAsync(requests, ct))
            {
                results.Add(evidence);
                if (input.Stream)
                {
                    await http.Response.WriteAsync(JsonSerializer.Serialize(new
                    { evidence, listedSeeders = requests.First(r => r.Candidate.Release.Id == evidence.Hash).Candidate.ConservativeListedSeeders,
                        elapsedMilliseconds = clock.ElapsedMilliseconds }, Json) + "\n", ct);
                    await http.Response.Body.FlushAsync(ct);
                }
            }
            return input.Stream ? Results.Empty : Results.Json(new
            { elapsedMilliseconds = clock.ElapsedMilliseconds, results, diagnostics = check.Diagnostics }, Json);
        });
    }

    private sealed record CheckInput(CheckCandidate[] Candidates, bool ForceFresh = false, bool Background = false, bool Stream = false);
    private sealed record WaitInput(string TargetId, string? Hash, string? Magnet);
    private sealed record CheckCandidate(string? Hash, string? Magnet, string? Name, int? ListedSeeders,
        string? TorrentUri, string[]? Trackers = null);
}
