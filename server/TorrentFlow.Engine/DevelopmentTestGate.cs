using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;

namespace TorrentFlow.Engine;

/// <summary>
/// Development only (registered when the host runs as Development and TorrentFlow:Engine:TestGateFile is set): reads its
/// decision from that file on every call, so the promotion states can be exercised by hand. Lines: <c>promote</c>,
/// <c>hold &lt;reason&gt;</c>, <c>reject &lt;reason&gt;</c>, optionally after <c>delay &lt;seconds&gt;</c> on the first
/// line. A missing or empty file promotes.
/// </summary>
internal sealed class DevelopmentTestGate(string file, ILogger<DevelopmentTestGate> logger) : IPromotionGate
{
    public async Task<PromotionDecision> DecideAsync(PromotionCandidate candidate, CancellationToken ct)
    {
        var lines = File.Exists(file) ? (await File.ReadAllLinesAsync(file, ct)).Select(l => l.Trim()).Where(l => l.Length > 0).ToList() : [];
        if (lines.Count > 0 && lines[0].StartsWith("delay ", StringComparison.OrdinalIgnoreCase)
            && int.TryParse(lines[0][6..].Trim(), out var seconds))
        {
            logger.LogWarning("[test-gate] {Hash}: waiting {Seconds} s before deciding", candidate.Hash, seconds);
            await Task.Delay(TimeSpan.FromSeconds(seconds), ct);
            lines.RemoveAt(0);
        }
        var line = lines.FirstOrDefault() ?? "promote";
        var split = line.IndexOf(' ');
        var verb = split < 0 ? line : line[..split];
        var reason = split < 0 ? "The test gate said so" : line[(split + 1)..].Trim();
        var decision = verb.ToLowerInvariant() switch
        {
            "hold" => PromotionDecision.Hold(reason),
            "reject" => PromotionDecision.Reject(reason),
            _ => PromotionDecision.Promote,
        };
        logger.LogWarning("[test-gate] {Hash} ({Name}), {Provenance}: {Outcome}", candidate.Hash, candidate.Name, candidate.Provenance, decision.Outcome);
        return decision;
    }
}
