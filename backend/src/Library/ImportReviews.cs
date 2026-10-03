using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

// The host binds these narrow persistence functions to Store without a module reference.
public sealed class ImportReviews(
    Func<string, CancellationToken, Task<ImportScanView?>> get,
    Func<CancellationToken, Task<ImmutableArray<ImportScanView>>> list,
    Func<ImportScanView, CancellationToken, Task> save,
    Func<string, string, string, CancellationToken, Task> decide,
    Func<string, CancellationToken, Task<string?>> canonical)
{
    public const string HoldMessage = "A file on disk may already be this. Review it in Import first.";
    public const string BackgroundMessage = "Review files in Import before automatic downloads can continue.";
    public Task<ImportScanView?> GetAsync(string id, CancellationToken ct) => get(id, ct);
    public Task<ImmutableArray<ImportScanView>> ListAsync(CancellationToken ct) => list(ct);
    public Task SaveAsync(ImportScanView scan, CancellationToken ct) => save(scan, ct);
    public Task DecideAsync(string id, string item, string decision, CancellationToken ct) => decide(id, item, decision, ct);
    public async Task<bool> HasSwitchoverAsync(CancellationToken ct) =>
        (await list(ct)).Any(s => s.Id.StartsWith("adoption:", StringComparison.Ordinal) &&
            (s.State != "complete" || !s.Items.IsEmpty));
    public async Task<ImmutableArray<ImportReviewItem>> CandidatesAsync(string workId, CancellationToken ct) =>
        (await CandidatesAsync([workId], ct))[workId];

    public async Task<ImmutableDictionary<string, ImmutableArray<ImportReviewItem>>> CandidatesAsync(
        ImmutableArray<string> workIds, CancellationToken ct)
    {
        var items = (await list(ct)).SelectMany(s => s.Items).ToArray();
        var results = ImmutableDictionary.CreateBuilder<string, ImmutableArray<ImportReviewItem>>();
        var identities = new Dictionary<string, string?>();
        async Task<string?> Identity(string key)
        {
            if (!identities.TryGetValue(key, out var identity))
                identities[key] = identity = await canonical(key, ct);
            return identity;
        }
        var groups = items.SelectMany(i => i.Candidates).GroupBy(c => (c.WorkId, c.WorkKey)).ToArray();
        foreach (var workId in workIds.Distinct())
        {
            if (groups.Length == 0) { results[workId] = []; continue; }
            var identity = await Identity(workId) ?? workId;
            var matching = new HashSet<(string WorkId, string WorkKey)>();
            foreach (var group in groups)
                if (group.Key.WorkId == workId || group.Key.WorkKey == workId ||
                    group.Key.WorkId == identity ||
                    await Identity(group.Key.WorkKey) is { } resolved && resolved == identity)
                    matching.Add(group.Key);
            results[workId] = [.. items.Select(i => i with
                { Candidates = [.. i.Candidates.Where(c => matching.Contains((c.WorkId, c.WorkKey)))] })
                .Where(i => !i.Candidates.IsEmpty)];
        }
        return results.ToImmutable();
    }
}
