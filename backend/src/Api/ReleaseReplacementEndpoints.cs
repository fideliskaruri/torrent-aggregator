using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class ReleaseReplacementEndpoints
{
    private static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web);
    private sealed record Choice(string CurrentHash, string Hash, DateTimeOffset ExpiresAt);
    internal sealed record SwapInput(string? Token = null, bool Best = false, string? Source = null,
        bool AllowBlocked = false);

    private static IDataProtector Protector(IDataProtectionProvider protection) =>
        protection.CreateProtector("TorrentFlow.ReleaseReplacement.v1");

    internal static void Map(RouteGroupBuilder group)
    {
        group.MapGet("/client/torrents/{hash}/alternatives", Read);
        group.MapPost("/client/torrents/{hash}/alternatives", Swap);
        group.MapPost("/downloads/{transferId}/find-another", async (string transferId,
            TargetPipeline targets, CancellationToken ct) =>
        {
            var hash = transferId.StartsWith("builtin:", StringComparison.Ordinal) ? transferId[8..] : transferId;
            var target = await CurrentTarget(targets, hash, ct);
            if (target is null) return Results.NotFound(new { ok = false, error = "Download not found." });
            return ActionReply(await targets.FindAnotherAsync(target.Id, ct), await targets.ReadAsync(ct), target.Id);
        });
    }

    private static async Task<TargetRow?> CurrentTarget(TargetPipeline targets, string hash, CancellationToken ct)
    {
        if (hash.Length is not (40 or 64) || hash.Any(c => !Uri.IsHexDigit(c))) return null;
        var snapshot = await targets.ReadAsync(ct);
        var matching = snapshot.Targets.Where(t => t.ChosenReleaseHash?.Equals(hash,
            StringComparison.OrdinalIgnoreCase) == true && t.State != TargetState.Removed);
        return matching.FirstOrDefault(t => t.State == TargetState.Fetching) ?? matching.FirstOrDefault();
    }

    private static async Task<IResult> Read(string hash, string? source, TargetPipeline targets,
        IServiceScopeFactory scopes, IDataProtectionProvider protection, CancellationToken ct)
    {
        var target = await CurrentTarget(targets, hash, ct);
        if (target is null) return Results.NotFound(new { error = "Download not found." });
        var result = await targets.AlternativesAsync(target.Id, source, ct);
        if (result is null) return Results.Conflict(new { message = "Only an unfinished download can find another release." });
        var snapshot = await targets.ReadAsync(ct);
        var live = snapshot.Live.FirstOrDefault(l => l.Hash == hash.ToLowerInvariant());
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
        var current = (await AccessState.AllAsync<ReleaseRow>(store, ct)).FirstOrDefault(r => r.Id == hash.ToLowerInvariant());
        var sourceRows = (await AccessState.AllAsync<SettingRow>(store, ct)).FirstOrDefault(s => s.Id == "sources");
        var sources = sourceRows is null ? [] : TorrentFlow.Store.SettingsCatalog.Read<ImmutableArray<SourceSettings>>(sourceRows);
        var protector = Protector(protection);
        var alternatives = result.Find.Candidates.Select(candidate => new
        {
            token = protector.Protect(JsonSerializer.Serialize(new Choice(hash.ToLowerInvariant(),
                candidate.Release.Id, DateTimeOffset.UtcNow.AddMinutes(10)))),
            hash = candidate.Release.Id, title = candidate.Release.Name,
            seeders = candidate.TrustedSeeders ?? 0,
            peers = candidate.Observations.Select(o => o.ListedLeechers).DefaultIfEmpty().Max() ?? 0,
            sizeBytes = candidate.Release.TotalBytes, quality = candidate.Release.Parsed.Quality.Resolution,
            source = candidate.Observations.FirstOrDefault()?.SourceId ?? "",
            languages = Languages(candidate.Release.Parsed),
            why = result.Plan.Rejections.FirstOrDefault(r => r.Hash == candidate.Release.Id)?.Explanation ??
                "Found for this title.",
            fits = result.Plan.Assignments.Any(a => a.Hash == candidate.Release.Id),
        }).ToArray();
        var recommended = result.Plan.Assignments.FirstOrDefault()?.Hash;
        return Results.Json(new
        {
            alternatives,
            current = new { title = current?.Name ?? hash, source = "", sizeBytes = current?.TotalBytes,
                quality = current?.Parsed.Quality.Resolution, finished = live?.Complete == true,
                languages = Languages(current?.Parsed) },
            health = new { connectedPeers = live?.Peers ?? 0, downloadBytesPerSecond = live?.BytesPerSecond ?? 0,
                stalledForSeconds = 0, state = live?.Complete == true ? "complete" :
                    live?.Active == true ? "downloading" : "queued" },
            recommendedToken = alternatives.FirstOrDefault(a => a.hash == recommended)?.token,
            sources = sources.Where(s => s.Enabled).Select(s => new { id = s.Id, name = s.Id }),
            note = "The current release stays until its replacement starts. Completed files are kept.",
        }, Wire);
    }

    private static object Languages(ParsedRelease? parsed) => new
    {
        audio = Array.Empty<string>(), subtitles = Array.Empty<string>(), subtitleState = "unknown",
        fit = parsed?.ClearlyForeign == true ? "clash" : "neutral",
        basis = parsed?.LanguageMarkers.IsEmpty == false ? "name" : "none",
        confidence = parsed?.LanguageMarkers.IsEmpty == false ? "medium" : "low",
        label = parsed?.LanguageMarkers.IsEmpty == false ? string.Join(", ", parsed.LanguageMarkers) : "Language not stated",
        english = parsed?.ClearlyForeign == true ? "fail" : "unknown",
        englishReason = parsed?.ClearlyForeign == true ? "This release is labelled in another language." : "Language not stated",
    };

    private static async Task<IResult> Swap(string hash, SwapInput input, TargetPipeline targets,
        IDataProtectionProvider protection, CancellationToken ct)
    {
        var target = await CurrentTarget(targets, hash, ct);
        if (target is null) return Results.NotFound(new { ok = false, error = "Download not found.",
            message = "Download not found." });
        string? chosen = null;
        if (!input.Best)
        {
            if (string.IsNullOrWhiteSpace(input.Token))
                return Results.BadRequest(new { ok = false, message = "Choose a release, or ask for the best one." });
            Choice? choice;
            try { choice = JsonSerializer.Deserialize<Choice>(Protector(protection).Unprotect(input.Token)); }
            catch (Exception ex) when (ex is CryptographicException or JsonException)
            { return Results.Conflict(new { ok = false, message = "That choice is invalid. Search again." }); }
            if (choice is null || choice.ExpiresAt <= DateTimeOffset.UtcNow ||
                !choice.CurrentHash.Equals(hash, StringComparison.OrdinalIgnoreCase))
                return Results.Conflict(new { ok = false, message = "That choice expired. Search again." });
            chosen = choice.Hash;
        }
        var reply = await targets.ReplaceAsync(target.Id, chosen, input.Source, ct);
        return ActionReply(reply, await targets.ReadAsync(ct), target.Id);
    }

    private static IResult ActionReply(TargetActionReply reply, TargetSnapshot snapshot, string targetId) =>
        Results.Json(new { ok = reply.Accepted, message = reply.Message,
            hash = snapshot.Targets.SingleOrDefault(t => t.Id == targetId)?.ChosenReleaseHash },
            Wire, statusCode: reply.Accepted ? 200 : 409);
}
