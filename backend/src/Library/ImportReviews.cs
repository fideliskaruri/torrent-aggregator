using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

// The host binds these narrow persistence functions to Store without a module reference.
public sealed class ImportReviews(
    Func<string, CancellationToken, Task<ImportScanView?>> get,
    Func<CancellationToken, Task<ImmutableArray<ImportScanView>>> list,
    Func<ImportScanView, CancellationToken, Task> save,
    Func<string, string, string, CancellationToken, Task> decide)
{
    public Task<ImportScanView?> GetAsync(string id, CancellationToken ct) => get(id, ct);
    public Task<ImmutableArray<ImportScanView>> ListAsync(CancellationToken ct) => list(ct);
    public Task SaveAsync(ImportScanView scan, CancellationToken ct) => save(scan, ct);
    public Task DecideAsync(string id, string item, string decision, CancellationToken ct) => decide(id, item, decision, ct);
}
