using System.Collections.Immutable;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using Microsoft.Extensions.DependencyInjection;

namespace TorrentFlow.Targets;

public sealed partial class TargetPipeline
{
    public Task DeleteDownloadFilesAsync(string hash, CancellationToken ct) =>
        transfers.DeleteFilesAsync(hash, ct);
}

internal sealed partial class TargetTransfers
{
    internal async Task DeleteFilesAsync(string hash, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var catalog = new CatalogState(store);
            var download = (await catalog.ReadAsync<DownloadRow>(CatalogState.Query(), ct))
                .SingleOrDefault(d => d.Hash.Equals(hash, StringComparison.OrdinalIgnoreCase));
            if (download is null) return;
            var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
            var files = (await repository.BindingsAsync(ct)).Where(f => f.DownloadId == download.Id).ToImmutableArray();
            var library = scope.ServiceProvider.GetRequiredService<ILibraryPlacement>();
            var root = (await library.RootsAsync(ct)).Single(r => r.Id == download.RootId);
            await engine.DetachAsync(download.Id, ct);
            await DownloadFiling.DeletePayloadAsync(files, root.Path, hash,
                await repository.FilingOperationsAsync(ct), await repository.MediaAsync(null, ct), ct);
            if (!await repository.RemoveDownloadFilesAsync(download.Id, ct))
                throw new IOException("The download files changed while removing them. Try again.");
        }
        finally { gate.Release(); }
    }
}
