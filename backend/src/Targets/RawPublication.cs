using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

public sealed partial class RawDownloads
{
    private void StartPublication(DownloadRow download, RawIntentRow raw, CancellationToken ct)
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!publications.TryAdd(raw.Id, completion.Task)) return;
        var cancellation = CancellationTokenSource.CreateLinkedTokenSource(ct);
        publicationCancellations[raw.Id] = cancellation;
        _ = Task.Run(RunAsync, CancellationToken.None);
        async Task RunAsync()
        {
            var acquired = false;
            try
            {
                await publicationSlot.WaitAsync(cancellation.Token); acquired = true;
                await using var scope = scopes.CreateAsyncScope();
                var store = scope.ServiceProvider.GetRequiredService<TargetStore>();
                var repository = (ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
                var current = (await store.ListAsync<RawIntentRow>(r => r.Id == raw.Id, cancellation.Token)).SingleOrDefault();
                if (current is null || current.State is RawDownloadState.Paused or RawDownloadState.Done or RawDownloadState.Removed) return;
                raw = current;
                await PublishDurablyAsync(store, repository, download, raw, cancellation.Token);
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
            catch (Exception ex) { logger.LogError(ex, "Raw download publication failed for {DownloadId}", download.Id); }
            finally
            {
                if (acquired) publicationSlot.Release();
                publications.TryRemove(raw.Id, out _);
                if (publicationCancellations.TryRemove(raw.Id, out var pending)) pending.Dispose();
                completion.TrySetResult();
            }
        }
    }

    internal Task WaitForPublicationsAsync() => Task.WhenAll(publications.Values);

    private async Task PublishDurablyAsync(TargetStore store, ILibraryDownloadRepository repository,
        DownloadRow download, RawIntentRow raw, CancellationToken ct)
    {
        var files = (await repository.BindingsAsync(ct)).Where(f => f.DownloadId == download.Id).ToImmutableArray();
        if (files.IsEmpty) throw new IOException("The raw download reservations are missing.");
        var selected = files.Where(f => f.Selected || f.Filed).ToArray();
        var operations = await store.ListAsync<FileOperationRow>(o => o.DownloadId == download.Id, ct);
        if (operations.Any(o => o.NextTryAt > DateTimeOffset.UtcNow)) return;
        var now = DateTimeOffset.UtcNow;
        var pending = new List<RowWrite>();
        foreach (var file in selected)
        {
            var prior = operations.SingleOrDefault(o => o.Id == "file:" + file.Id);
            if (prior is not null && prior.BindingFingerprint != DownloadFiling.Fingerprint(file))
                throw new IOException("The raw download reservation changed.");
            if (prior is not null) continue;
            var operation = new FileOperationRow { Id = "file:" + file.Id, DownloadId = download.Id,
                Kind = FileOperationKind.Rename, SourcePath = file.PartialPath, DestinationPath = file.FinalPath,
                ExpectedBytes = file.ExpectedBytes, BindingFingerprint = DownloadFiling.Fingerprint(file),
                State = FileOperationState.Pending, DeleteSource = false, Attempts = 0, CreatedAt = now, UpdatedAt = now };
            pending.Add(new(operation, null, null));
            foreach (var path in new[] { file.PartialPath, file.FinalPath }.OfType<string>().Distinct())
                pending.Add(new(new FilePathClaimRow { Id = Guid.NewGuid().ToString("N"), OperationId = operation.Id,
                    PhysicalKey = LibraryPaths.PhysicalKey(path), CreatedAt = now }, null, null));
        }
        if (raw.State != RawDownloadState.Publishing)
            pending.Add(new(raw with { State = RawDownloadState.Publishing, UpdatedAt = now, Version = raw.Version + 1 }, raw.Version, null));
        await CommitAsync(store, pending, [], ct);
        raw = (await store.ListAsync<RawIntentRow>(r => r.Id == raw.Id, ct)).Single();
        var guards = new Dictionary<int, PayloadFile>();
        try
        {
            var drain = await engine.StopAndReleaseFilesAsync(download.Id, ct);
            if (!drain.WritesDrained || drain.Failure is not null)
                throw new IOException(drain.Failure?.Message ?? "The raw download could not stop writing.");
            operations = await store.ListAsync<FileOperationRow>(o => o.DownloadId == download.Id, ct);
            var verify = new HashSet<int>();
            foreach (var file in selected)
            {
                var operation = operations.Single(o => o.Id == "file:" + file.Id);
                var partial = file.PartialPath!;
                var hasPartial = File.Exists(partial);
                if (!hasPartial && operation.State != FileOperationState.Verified)
                    throw new IOException("The reserved raw file is missing. An existing destination was left untouched.");
                var guard = new PayloadFile(hasPartial ? partial : file.FinalPath!);
                guards.Add(file.FileIndex, guard);
                if (guard.Stream.Length != file.ExpectedBytes) throw new IOException("The raw file changed size.");
                if (hasPartial && partial != file.FinalPath && (File.Exists(file.FinalPath) || Directory.Exists(file.FinalPath)))
                    throw new IOException("A file already uses the raw destination. It was left untouched.");
                if (operation.State == FileOperationState.Verified)
                {
                    if (guard.Identity != operation.SourceIdentity || await guard.DigestAsync(ct) != operation.ExpectedDigest)
                        throw new IOException("The raw file changed after verification. It was left untouched.");
                }
                else verify.Add(file.FileIndex);
            }
            var proof = verify.Count == 0 ? ImmutableArray<VerifiedPayload>.Empty : await engine.VerifyFilesAsync(download.Hash,
                [.. files.Select(f => new FileBinding(f.FileIndex, guards.TryGetValue(f.FileIndex, out var held)
                    ? held.Path : f.EnginePath!, verify.Contains(f.FileIndex)))], ct,
                guards.ToDictionary(p => p.Key, p => (Stream)p.Value.Stream));
            var verified = new List<FileOperationRow>();
            foreach (var file in selected)
            {
                var prior = operations.Single(o => o.Id == "file:" + file.Id);
                var result = proof.SingleOrDefault(p => p.FileIndex == file.FileIndex);
                if (verify.Contains(file.FileIndex) && (result?.Digest is null || result.Failure is not null))
                    throw new IOException(result?.Failure?.Message ?? "The raw file could not be verified.");
                var next = prior with { State = FileOperationState.Verified, SourceIdentity = guards[file.FileIndex].Identity,
                    ExpectedDigest = result?.Digest ?? prior.ExpectedDigest, Attempts = prior.Attempts + 1,
                    NextTryAt = null, LastError = null, UpdatedAt = DateTimeOffset.UtcNow };
                await CommitAsync(store, [new(next, null, prior)], [], ct);
                verified.Add(next);
            }
            foreach (var file in selected) guards[file.FileIndex].MoveTo(file.FinalPath!);
            now = DateTimeOffset.UtcNow;
            download = (await store.ListAsync<DownloadRow>(d => d.Id == download.Id, ct)).Single();
            await CommitAsync(store,
                [new(raw with { State = RawDownloadState.Done, UpdatedAt = now, Version = raw.Version + 1 }, raw.Version, null),
                 new(download with { Intent = DownloadIntent.Stopped, FinishedAt = now, Version = download.Version + 1 }, download.Version, null),
                 .. verified.Select(o => new RowWrite(o with { State = FileOperationState.Done, UpdatedAt = now }, null, o))], [], ct);
            RawDownloadFiles.PruneUnwanted(raw.ExplicitDirectory!, download.Hash);
            await engine.SaveDevStateAsync(ct);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            foreach (var prior in await store.ListAsync<FileOperationRow>(o => o.DownloadId == download.Id, ct))
                await CommitAsync(store, [new(prior with { NextTryAt = DateTimeOffset.UtcNow.AddSeconds(30),
                    LastError = ex.Message, UpdatedAt = DateTimeOffset.UtcNow }, null, prior)], [], ct);
            throw;
        }
        finally { foreach (var guard in guards.Values) guard.Dispose(); }
    }
}
