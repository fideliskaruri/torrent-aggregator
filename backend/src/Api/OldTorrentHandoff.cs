using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Library;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal sealed class OldTorrentHandoff(IServiceScopeFactory scopes, TargetPipeline targets,
    IConfiguration configuration, ILogger<OldTorrentHandoff> logger) : BackgroundService
{
    private readonly SemaphoreSlim kick = new(0, 1);
    // Failed hashes are skipped on timed scans; an explicit kick (a new import) retries them.
    private readonly HashSet<string> failed = new(StringComparer.Ordinal);

    public void Kick()
    {
        lock (failed) failed.Clear();
        try { kick.Release(); }
        catch (SemaphoreFullException) { }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            await RunSafelyAsync(stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
            {
                await kick.WaitAsync(TimeSpan.FromMinutes(15), stoppingToken);
                await RunSafelyAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }

    private async Task RunSafelyAsync(CancellationToken ct)
    {
        try { await RunAsync(ct); }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception ex) { logger.LogError(ex, "The old TorrentFlow handoff scan failed."); }
    }

    private async Task RunAsync(CancellationToken ct)
    {
        var oldApp = OldAppDownloads.Read(configuration);
        if (oldApp.Count == 0) return;

        var scan = new ExternalDownloadScanner().Scan(null, ct, oldApp, clients: false);
        var downloads = (await targets.ReadAsync(ct)).Downloads
            .Select(download => download.Hash.ToLowerInvariant()).ToHashSet(StringComparer.Ordinal);

        await using var scope = scopes.CreateAsyncScope();
        var inventory = scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
        var media = await inventory.MediaAsync(null, ct);
        string[] skip;
        lock (failed) skip = [.. failed];
        foreach (var candidate in scan.Candidates.Where(candidate =>
                     candidate.Source == ExternalDownloadScanner.OldAppSource &&
                     !downloads.Contains(candidate.Hash.ToLowerInvariant()) &&
                     !skip.Contains(candidate.Hash.ToLowerInvariant())))
        {
            ct.ThrowIfCancellationRequested();
            var fileIndices = new Dictionary<string, int>(StringComparer.Ordinal);
            for (var index = 0; index < candidate.Files.Length; index++)
                fileIndices.TryAdd(LibraryPaths.PhysicalKey(candidate.Files[index]), index);

            var rows = ImmutableArray.CreateBuilder<MediaFileRow>();
            var items = ImmutableArray.CreateBuilder<ExternalTransferItem>();
            foreach (var row in media)
            {
                // Only rows the old-app import created; a download the user removed keeps Origin Downloaded.
                if (row.Role != FileRole.Video || row.DownloadId is not null ||
                    row.Origin is not (MediaOrigin.Imported or MediaOrigin.Adopted) ||
                    !fileIndices.TryGetValue(row.PhysicalKey, out var fileIndex))
                    continue;
                rows.Add(row);
                items.Add(new(fileIndex, row.WorkId, row.EpisodeId));
            }
            if (rows.Count == 0) continue;

            try
            {
                var result = await targets.AdmitExternalAsync(new(candidate.Hash, candidate.Name,
                    candidate.TorrentBytes, candidate.Files, items.ToImmutable(), Paused: false,
                    Replaces: rows.ToImmutable()), "local", ct);
                if (!result.Accepted)
                    Fail(candidate, result.Failure?.Message ?? "The engine did not accept the transfer.");
                else if (result.Failure is not null)
                    logger.LogWarning("Handed over old TorrentFlow transfer {Torrent}; it will retry: {Message}",
                        candidate.Name, result.Failure.Message);
                else logger.LogInformation("Handed over old TorrentFlow transfer {Torrent}.", candidate.Name);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex) { Fail(candidate, ex.Message); }
        }
    }

    private void Fail(ExternalDownloadCandidate candidate, string message)
    {
        lock (failed) failed.Add(candidate.Hash.ToLowerInvariant());
        logger.LogWarning("Could not hand over old TorrentFlow transfer {Torrent}: {Message}", candidate.Name, message);
    }
}
