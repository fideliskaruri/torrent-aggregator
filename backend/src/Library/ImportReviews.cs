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
    public async Task<bool> HoldsAsync(string workId, CancellationToken ct)
    {
        var candidates = (await list(ct)).Where(s => s.Id.StartsWith("adoption:", StringComparison.Ordinal))
            .SelectMany(s => s.Items).SelectMany(i => i.Candidates).ToArray();
        if (candidates.Any(c => c.WorkId == workId || c.WorkKey == workId)) return true;
        if (candidates.Length == 0) return false;
        var identity = await canonical(workId, ct) ?? workId;
        foreach (var candidate in candidates.DistinctBy(c => c.WorkKey))
            if (await canonical(candidate.WorkKey, ct) is { } resolved && resolved == identity) return true;
        return false;
    }
}
