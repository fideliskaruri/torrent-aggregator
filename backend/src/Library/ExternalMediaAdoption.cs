using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed record ExternalAdoptionResult(int Adopted, int AlreadyOwned, int Pending);
public sealed record ExternalAdoptionSource(string Id, string Name, string SavePath, bool Complete,
    ImmutableArray<string> Files);
public sealed record ExternalAdoptionBatch(int Imported, int Paused, int Skipped, int Failed,
    ImmutableArray<string> Errors);

public sealed class ExternalMediaAdoption(MediaImport importer, ImportReviews reviews, ILibraryRepository inventory)
{
    public const string ReviewPrefix = "adoption:external:";
    private static readonly SemaphoreSlim ImportGate = new(1, 1);

    public async Task<bool> AlreadyOwnedAsync(ImmutableArray<string> paths, CancellationToken ct)
    {
        paths = [.. paths.Where(MediaImport.IsVideo)];
        var media = await inventory.MediaAsync(null, ct);
        return !paths.IsEmpty && paths.All(p => media.Any(m => m.PhysicalKey == LibraryPaths.PhysicalKey(p)));
    }

    public async Task<ExternalAdoptionBatch> ImportAsync(IEnumerable<string> ids,
        ImmutableArray<ExternalAdoptionSource> sources, CancellationToken ct)
    {
        await ImportGate.WaitAsync(ct);
        try { return await ImportBatchAsync(ids, sources, ct); }
        finally { ImportGate.Release(); }
    }

    private async Task<ExternalAdoptionBatch> ImportBatchAsync(IEnumerable<string> ids,
        ImmutableArray<ExternalAdoptionSource> sources, CancellationToken ct)
    {
        var imported = 0;
        var skipped = 0;
        var failed = 0;
        var errors = ImmutableArray.CreateBuilder<string>();
        foreach (var id in ids.Distinct(StringComparer.Ordinal))
        {
            var candidate = sources.FirstOrDefault(c => c.Id == id);
            if (candidate is null)
            { failed++; errors.Add("A selected torrent is no longer available. Scan the original client again."); continue; }
            if (!candidate.Complete)
            {
                failed++;
                errors.Add($"{candidate.Name}: unfinished torrents cannot be handed over yet. Finish it in the original client, then import again.");
                continue;
            }
            try
            {
                var result = await AdoptAsync(id, candidate.SavePath, candidate.Files, ct);
                if (result.Pending > 0)
                { failed++; errors.Add($"{candidate.Name}: confirm the matching title in Import before downloading."); }
                else if (result.Adopted > 0) imported++;
                else if (result.AlreadyOwned > 0) skipped++;
                else { failed++; errors.Add($"{candidate.Name}: no supported video files were found."); }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            { failed++; errors.Add($"{candidate.Name}: {ex.Message}"); }
        }
        return new(imported, 0, skipped, failed, errors.ToImmutable());
    }

    private async Task<ExternalAdoptionResult> AdoptAsync(string sourceId, string folder,
        ImmutableArray<string> paths, CancellationToken ct)
    {
        var id = ReviewPrefix + sourceId;
        var scan = await reviews.GetAsync(id, ct);
        if (scan is null)
        {
            await importer.ScanFilesAsync(id, MediaImport.ValidateFolder(folder), paths, update => scan = update, ct);
            await reviews.SaveAsync(scan!, ct);
        }
        var before = await inventory.MediaAsync(null, ct);
        var remaining = await importer.AdoptAsync(scan!, reviews, ct, MediaOrigin.Adopted);
        var after = await inventory.MediaAsync(null, ct);
        var keys = paths.Select(LibraryPaths.PhysicalKey).ToHashSet();
        return new(after.Count(m => keys.Contains(m.PhysicalKey) && before.All(b => b.PhysicalKey != m.PhysicalKey)),
            before.Count(m => keys.Contains(m.PhysicalKey)), remaining.Items.Length);
    }
}
