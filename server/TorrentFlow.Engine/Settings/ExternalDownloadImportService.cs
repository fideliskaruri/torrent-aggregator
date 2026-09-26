using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Data;

namespace TorrentFlow.Engine.Settings;

public sealed record ExternalDownloadImportRequest(IReadOnlyList<string> Ids, bool Acknowledged);
public sealed record ExternalDownloadImportResult(int Imported, int Paused, int Skipped, int Failed, IReadOnlyList<string> Errors);

internal sealed class ExternalDownloadImportService(
    ExternalDownloadScanner scanner, TorrentEngineService engine,
    IDbContextFactory<TorrentFlowDbContext> factory, ILogger<ExternalDownloadImportService> logger,
    ILibraryDownloadRecovery? library = null)
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task<object> DiscoverAsync(CancellationToken ct)
    {
        var scan = await scanner.ScanAsync(ct);
        await using var db = await factory.CreateDbContextAsync(ct);
        var hashes = (await db.EngineTorrents.Where(r => r.UserId == LocalUser.Id)
            .Select(r => r.Hash).ToListAsync(ct)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        return new
        {
            candidates = scan.Candidates.Select(c => new
            {
                c.Id, c.Source, c.Hash, c.Name, c.SizeBytes, c.SavePath, c.DataExists, c.Complete,
                alreadyImported = hashes.Contains(c.Hash),
            }),
            scan.Warnings,
        };
    }

    public async Task<ExternalDownloadImportResult> ImportAsync(ExternalDownloadImportRequest request, CancellationToken ct)
    {
        if (!request.Acknowledged) throw new ArgumentException("Confirm that the other client will not write to these files.");
        if (request.Ids is null || request.Ids.Count is 0 or > 500 || request.Ids.Any(string.IsNullOrWhiteSpace))
            throw new ArgumentException("Select between 1 and 500 torrents to import.");
        await _gate.WaitAsync(ct);
        try
        {
            // IDs are resolved afresh: the caller cannot submit a filesystem path or untrusted torrent bytes.
            var scan = await scanner.ScanAsync(ct);
            var selected = request.Ids.ToHashSet(StringComparer.Ordinal);
            var found = scan.Candidates.Where(c => selected.Contains(c.Id)).ToList();
            var errors = new List<string>();
            var failed = selected.Except(found.Select(c => c.Id)).Count();
            if (failed > 0) errors.Add("Some selected sources changed or disappeared. Scan again.");
            var imported = 0;
            var paused = 0;
            var skipped = 0;
            foreach (var group in found.GroupBy(c => c.Hash, StringComparer.OrdinalIgnoreCase))
            {
                var candidate = group.OrderByDescending(c => c.TorrentBytes is { Length: > 0 })
                    .ThenByDescending(c => c.DataExists).First();
                skipped += group.Count() - 1;
                try
                {
                    var result = await engine.ImportExternalAsync(candidate, ct);
                    if (result.Imported) imported++; else skipped++;
                    if (result.Paused) paused++;
                    if (library is not null) await library.RegisterAsync([candidate.Hash], ct);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
                {
                    logger.LogWarning(ex, "Could not import selected torrent {Hash} from {Source}", candidate.Hash, candidate.Source);
                    errors.Add($"{candidate.Name}: could not import; check Downloads for an error or scan again.");
                    failed++;
                }
            }
            return new(imported, paused, skipped, failed, errors);
        }
        finally { _gate.Release(); }
    }
}
