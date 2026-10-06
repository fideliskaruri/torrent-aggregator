using System.Text.Json;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class ReleaseReplacementEndpoints
{
    private static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web);

    internal static void Map(RouteGroupBuilder group)
    {
        group.MapPost("/downloads/{transferId}/find-another", async (string transferId,
            TargetPipeline targets, CancellationToken ct) =>
        {
            var match = Regex.Match(transferId.Trim(),
                "^(?:builtin:)?([0-9a-f]{40}|[0-9a-f]{64})(?::(.+))?$",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            if (!match.Success) return Results.NotFound(new { ok = false, error = "Download not found." });
            var hash = match.Groups[1].Value;
            var target = await CurrentTarget(targets, hash, ct);
            if (target is null) return Results.NotFound(new { ok = false, error = "Download not found." });
            return ActionReply(await targets.FindAnotherAsync(target.Id, ct), await targets.ReadAsync(ct), target.Id);
        });
    }

    private static async Task<TargetRow?> CurrentTarget(TargetPipeline targets, string hash, CancellationToken ct)
    {
        if (hash.Length is not (40 or 64) || hash.Any(c => !Uri.IsHexDigit(c))) return null;
        var snapshot = await targets.ReadAsync(ct);
        return snapshot.Targets.FirstOrDefault(t => t.State == TargetState.Fetching &&
            t.ChosenReleaseHash?.Equals(hash, StringComparison.OrdinalIgnoreCase) == true);
    }

    private static IResult ActionReply(TargetActionReply reply, TargetSnapshot snapshot, string targetId) =>
        Results.Json(new { ok = reply.Accepted, message = reply.Message,
            hash = snapshot.Targets.SingleOrDefault(t => t.Id == targetId)?.ChosenReleaseHash },
            Wire, statusCode: reply.Accepted ? 200 : 409);
}
