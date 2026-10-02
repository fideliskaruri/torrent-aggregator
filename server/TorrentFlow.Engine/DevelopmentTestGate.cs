using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;

namespace TorrentFlow.Engine;

/// <summary>Development-only points where verification can pause or fail a promotion. A no-op everywhere else.</summary>
internal interface IPromotionTestHooks
{
    /// <summary>
    /// A promotion reached <paramref name="point"/>: "claimed" (the layout recorded its targets, nothing moved yet) or
    /// "staged" (every file renamed aside, none landed).
    /// </summary>
    void Checkpoint(string hash, string point);

    /// <summary>Throws an <see cref="IOException"/> when verification asked for a failure at <paramref name="point"/> ("finish").</summary>
    void Fail(string hash, string point);
}

internal sealed class NoPromotionTestHooks : IPromotionTestHooks
{
    public static readonly NoPromotionTestHooks Instance = new();

    public void Checkpoint(string hash, string point) { }

    public void Fail(string hash, string point) { }
}

/// <summary>
/// Development only (registered when the host runs as Development and TorrentFlow:Engine:TestGateFile is set; off
/// otherwise): reads its instructions from that file on every call, so the promotion states can be exercised by hand.
/// Lines: <c>promote</c>, <c>hold &lt;reason&gt;</c> or <c>reject &lt;reason&gt;</c>; <c>delay &lt;seconds&gt;</c> before
/// deciding; <c>pause &lt;point&gt; &lt;seconds&gt;</c> at a promotion checkpoint (claimed, staged), long enough to stop
/// the process there; <c>fail &lt;point&gt; &lt;count&gt;</c> to throw the first count times for each transfer (finish).
/// A line that starts with an info hash applies to that transfer only, ahead of the lines for every transfer. A missing
/// or empty file promotes.
/// </summary>
internal sealed class DevelopmentTestGate(string file, ILogger<DevelopmentTestGate> logger) : IPromotionGate, IPromotionTestHooks
{
    private readonly Dictionary<string, int> _failed = new(StringComparer.OrdinalIgnoreCase);

    public async Task<PromotionDecision> DecideAsync(PromotionCandidate candidate, CancellationToken ct)
    {
        var lines = Lines(candidate.Hash);
        if (lines.FirstOrDefault(l => l.Verb == "delay") is { Verb: "delay" } delay && int.TryParse(delay.Arg, out var seconds))
        {
            logger.LogWarning("[test-gate] {Hash}: waiting {Seconds} s before deciding", candidate.Hash, seconds);
            await Task.Delay(TimeSpan.FromSeconds(seconds), ct);
        }
        var line = lines.FirstOrDefault(l => l.Verb is "promote" or "hold" or "reject");
        var reason = string.IsNullOrEmpty(line.Arg) ? "The test gate said so" : line.Arg;
        var decision = line.Verb switch
        {
            "hold" => PromotionDecision.Hold(reason),
            "reject" => PromotionDecision.Reject(reason),
            _ => PromotionDecision.Promote,
        };
        logger.LogWarning("[test-gate] {Hash} ({Name}), {Provenance}: {Outcome}", candidate.Hash, candidate.Name, candidate.Provenance, decision.Outcome);
        return decision;
    }

    public void Checkpoint(string hash, string point)
    {
        foreach (var (verb, arg) in Lines(hash))
        {
            var parts = arg.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (verb != "pause" || parts.Length != 2 || !parts[0].Equals(point, StringComparison.OrdinalIgnoreCase)
                || !int.TryParse(parts[1], out var seconds)) continue;
            logger.LogWarning("[test-gate] {Hash}: pausing {Seconds} s at {Point}", hash, seconds, point);
            Thread.Sleep(TimeSpan.FromSeconds(seconds));
        }
    }

    public void Fail(string hash, string point)
    {
        foreach (var (verb, arg) in Lines(hash))
        {
            var parts = arg.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (verb != "fail" || parts.Length != 2 || !parts[0].Equals(point, StringComparison.OrdinalIgnoreCase)
                || !int.TryParse(parts[1], out var count)) continue;
            int attempt;
            lock (_failed)
            {
                var key = $"{hash}|{point}";
                attempt = _failed.GetValueOrDefault(key) + 1;
                if (attempt > count) return;
                _failed[key] = attempt;
            }
            logger.LogWarning("[test-gate] {Hash}: forced failure {Attempt} of {Count} at {Point}", hash, attempt, count, point);
            throw new IOException($"Development test: forced failure at {point}.");
        }
    }

    /// <summary>The instructions for <paramref name="hash"/>: its own lines first (hash prefix removed), then the rest.</summary>
    private List<(string Verb, string Arg)> Lines(string hash)
    {
        try
        {
            if (!File.Exists(file)) return [];
            var all = File.ReadAllLines(file).Select(l => l.Trim()).Where(l => l.Length > 0).ToList();
            bool Scoped(string l) => l.Length > 41 && l[40] == ' ' && l[..40].All(char.IsAsciiHexDigit);
            return all.Where(l => Scoped(l) && l[..40].Equals(hash, StringComparison.OrdinalIgnoreCase)).Select(l => l[41..].Trim())
                .Concat(all.Where(l => !Scoped(l)))
                .Select(l =>
                {
                    var split = l.IndexOf(' ');
                    return split < 0 ? (l.ToLowerInvariant(), "") : (l[..split].ToLowerInvariant(), l[(split + 1)..].Trim());
                }).ToList();
        }
        catch (IOException) { return []; }
    }
}
