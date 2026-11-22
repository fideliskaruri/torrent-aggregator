using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Store;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace TorrentFlow.Targets;

internal sealed class FilingBlockedException(string message) : IOException(message) { }

internal static class DownloadFiling
{
    private static readonly SemaphoreSlim filingSlots = new(1, 1);
    internal static string Fingerprint(DownloadFileRow file) => Convert.ToHexString(SHA256.HashData(
        Encoding.UTF8.GetBytes(JsonSerializer.Serialize(file))));

    internal static async Task FileAsync(TargetStore store, ILibraryDownloadRepository repository, IEngine engine,
        DownloadRow download, EngineSnapshot? snapshot, ImmutableArray<DownloadFileRow> allFiles,
        ImmutableArray<TargetRow> members, SemaphoreSlim stateGate, CancellationToken ct, ILogger? logger = null)
    {
        await filingSlots.WaitAsync(ct);
        try
        {
            // A retry must never detach an incomplete shared manager to finish an older member.
            if (snapshot is { Complete: false }) return;
            var ids = members.Select(t => t.Id).ToArray();
            ImmutableArray<TargetRow> ready;
            await stateGate.WaitAsync(ct);
            try
            {
                var now = DateTimeOffset.UtcNow;
                ready = [.. (await store.ListAsync<TargetRow>(t => ids.Contains(t.Id), ct)).Where(t =>
                    t.ChosenReleaseHash == download.Hash && !t.IsPaused() &&
                    (t.State == TargetState.Fetching && snapshot?.Complete == true ||
                     t.State == TargetState.Filing && t.ReasonCode != WaitReason.FilingBlocked &&
                     (t.NextTryAt is null || t.NextTryAt <= now)))];
                if (ready.IsEmpty) return;
                allFiles = [.. (await repository.BindingsAsync(ct)).Where(f => f.DownloadId == download.Id)];
                var selected = allFiles.Where(f => f.Selected && !f.Filed && ready.Any(t => t.Id == f.TargetId)).ToArray();
                var operations = await store.ListAsync<FileOperationRow>(o => o.DownloadId == download.Id, ct);
                var claims = await store.ListAsync<FilePathClaimRow>(null, ct);
                var writes = ImmutableArray.CreateBuilder<RowWrite>();
                foreach (var file in selected)
                {
                    var id = "file:" + file.Id;
                    var prior = operations.SingleOrDefault(o => o.Id == id);
                    if (prior is not null && prior.BindingFingerprint != Fingerprint(file))
                        throw new IOException("The file reservation changed. Review the previous publication before retrying.");
                    if (prior is null)
                    {
                        writes.Add(new(new FileOperationRow { Id = id, Kind = FileOperationKind.Rename,
                            DownloadId = download.Id, TargetId = file.TargetId, SourcePath = file.PartialPath,
                            DestinationPath = file.FinalPath, ExpectedBytes = file.ExpectedBytes,
                            BindingFingerprint = Fingerprint(file), State = FileOperationState.Pending,
                            DeleteSource = false, Attempts = 0, CreatedAt = now, UpdatedAt = now }, null, null));
                        foreach (var path in new[] { file.PartialPath, file.FinalPath }.OfType<string>().Distinct())
                        {
                            var key = LibraryPaths.PhysicalKey(path);
                            if (claims.Any(c => c.PhysicalKey == key && c.OperationId != id))
                                throw new IOException("Another file operation owns this destination.");
                            writes.Add(new(new FilePathClaimRow { Id = Guid.NewGuid().ToString("N"), OperationId = id,
                                PhysicalKey = key, CreatedAt = now }, null, null));
                        }
                    }
                }
                foreach (var target in ready)
                    writes.Add(new(target with { State = TargetState.Filing, ResumeState = null, ReasonCode = null,
                        ReasonText = null, NextTryAt = null, UpdatedAt = now, Version = target.Version + 1 }, target.Version, null));
                var current = (await store.ListAsync<DownloadRow>(d => d.Id == download.Id, ct)).Single();
                if (current.Intent != DownloadIntent.Stopped)
                    writes.Add(new(current with { Intent = DownloadIntent.Stopped, Version = current.Version + 1 }, current.Version, null));
                // Every member is recoverable before the engine releases its handles, even if this process stops now.
                await TargetPipeline.CommitAsync(store, writes.ToImmutable(), [], ct);
            }
            finally { stateGate.Release(); }
            var drain = await engine.StopAndReleaseFilesAsync(download.Id, ct);
            if (!drain.WritesDrained || drain.Failure is not null)
            {
                foreach (var target in ready) await FailureAsync(store, download, target.Id,
                    new IOException(drain.Failure?.Message ?? "Could not finish writing the download."), stateGate, ct);
                return;
            }
            foreach (var member in ready)
                await FileTargetAsync(store, repository, engine, download, allFiles, member, stateGate, ct, logger ?? NullLogger.Instance);
        }
        finally { filingSlots.Release(); }
    }

    private static async Task FileTargetAsync(TargetStore store, ILibraryDownloadRepository repository, IEngine engine,
        DownloadRow download, ImmutableArray<DownloadFileRow> allFiles, TargetRow member,
        SemaphoreSlim stateGate, CancellationToken ct, ILogger logger)
    {
        allFiles = [.. (await repository.BindingsAsync(ct)).Where(f => f.DownloadId == download.Id)];
        var selected = allFiles.Where(f => f.Selected && !f.Filed && f.TargetId == member.Id).ToArray();
        if (selected.Length == 0)
        {
            await SettleAsync(store, [.. await repository.BindingsAsync(ct)], new HashSet<string> { member.Id }, download.Hash, stateGate, ct);
            return;
        }
        var guards = new Dictionary<string, PayloadFile>(StringComparer.Ordinal);
        try
        {
            var operations = await store.ListAsync<FileOperationRow>(o => o.DownloadId == download.Id, ct);
            var receipts = new Dictionary<string, FileOperationRow>(StringComparer.Ordinal);
            var digests = new Dictionary<string, string>(StringComparer.Ordinal);
            var verify = new HashSet<int>();
            foreach (var binding in selected)
            {
                var operation = operations.Single(o => o.Id == "file:" + binding.Id);
                if (operation.BindingFingerprint != Fingerprint(binding)) throw new FilingBlockedException("The file reservation changed.");
                var source = binding.PartialPath ?? throw new FilingBlockedException("The file has no reserved partial path.");
                var final = binding.FinalPath ?? throw new FilingBlockedException("The file has no reserved destination.");
                var hasPartial = File.Exists(source);
                if (!hasPartial && operation.State != FileOperationState.Verified)
                    throw new FilingBlockedException("The reserved download file is missing. An existing destination was left untouched.");
                var physical = hasPartial ? source : final;
                var guard = new PayloadFile(physical);
                guards.Add(binding.Id, guard);
                if (guard.Stream.Length != binding.ExpectedBytes) throw new FilingBlockedException("The completed file changed size.");
                if (hasPartial && LibraryPaths.PhysicalKey(source) != LibraryPaths.PhysicalKey(final) &&
                    (File.Exists(final) || Directory.Exists(final)))
                    throw new FilingBlockedException("A file already uses the library destination. It was left untouched.");
                if (binding.Role == FileRole.Video)
                {
                    if (!TorrentFlow.Library.DownloadFiling.RecognizedVideo(guard.Stream))
                        throw new FilingBlockedException("The downloaded file is not a recognized video.");
                }
                if (operation.State == FileOperationState.Verified)
                {
                    if (operation.SourceIdentity != guard.Identity) throw new FilingBlockedException("The completed file was replaced. It was left untouched.");
                    var digest = await guard.DigestAsync(ct);
                    if (digest != operation.ExpectedDigest) throw new FilingBlockedException("The completed file changed. It was left untouched.");
                    digests.Add(binding.Id, digest);
                }
                else verify.Add(binding.FileIndex);
                receipts.Add(binding.Id, operation);
            }
            if (verify.Count > 0)
            {
                var streams = selected.ToDictionary(f => f.FileIndex, f => (Stream)guards[f.Id].Stream);
                var verified = await engine.VerifyFilesAsync(download.Hash,
                    [.. allFiles.Select(f => new FileBinding(f.FileIndex,
                        guards.TryGetValue(f.Id, out var held) ? held.Path : f.Filed ? f.FinalPath! : f.EnginePath ?? f.PartialPath!,
                        verify.Contains(f.FileIndex)))], ct, streams);
                foreach (var file in selected.Where(f => verify.Contains(f.FileIndex)))
                {
                    var proof = verified.SingleOrDefault(v => v.FileIndex == file.FileIndex);
                    if (proof?.Failure is { } failure)
                    {
                        if (failure.Code == "hash_mismatch") throw new FilingBlockedException(failure.Message);
                        throw new IOException(failure.Message);
                    }
                    if (proof?.Digest is null) throw new IOException("The original torrent could not be verified.");
                    digests.Add(file.Id, proof.Digest);
                }
            }
            var verifiedAt = DateTimeOffset.UtcNow;
            foreach (var file in selected)
            {
                var prior = receipts[file.Id];
                var next = prior with { State = FileOperationState.Verified, ExpectedDigest = digests[file.Id],
                    SourceIdentity = guards[file.Id].Identity, Attempts = prior.Attempts + 1, UpdatedAt = verifiedAt };
                await TargetPipeline.CommitAsync(store, [new(next, null, prior)], [], ct);
                receipts[file.Id] = next;
            }

            await stateGate.WaitAsync(ct);
            try
            {
                var target = (await store.ListAsync<TargetRow>(t => t.Id == member.Id, ct)).SingleOrDefault();
                var latestBindings = await repository.BindingsAsync(ct);
                if (target is null || target.State != TargetState.Filing || target.IsPaused() ||
                    target.ChosenReleaseHash != download.Hash || selected.Any(f => latestBindings.SingleOrDefault(b => b.Id == f.Id) != f)) return;
                var work = (await store.ListAsync<WorkRow>(w => w.Id == target.WorkId, ct)).Single();
                var seasons = await store.ListAsync<SeasonRow>(s => s.WorkId == work.Id, ct);
                var seasonIds = seasons.Select(s => s.Id).ToArray();
                var workSnapshot = new WorkSnapshot(work,
                    [.. await store.ListAsync<WorkNameRow>(n => n.WorkId == work.Id, ct)],
                    [.. await store.ListAsync<WorkLinkRow>(l => l.WorkId == work.Id, ct)], [.. seasons],
                    [.. await store.ListAsync<EpisodeRow>(e => seasonIds.Contains(e.SeasonId), ct)]);
                var release = (await store.ListAsync<ReleaseRow>(r => r.Id == download.Hash, ct)).Single();
                var prepared = ImmutableArray.CreateBuilder<(DownloadFileRow Before, DownloadFileRow After, MediaFileRow Media)>();
                foreach (var binding in selected)
                {
                    var guard = guards[binding.Id];
                    guard.MoveTo(binding.FinalPath!);
                    var media = TorrentFlow.Library.DownloadFiling.Media(download, workSnapshot, target,
                        release.Parsed.Quality.Resolution, release.Parsed.Quality.Source, binding, guard.Stream)
                        with { ContentDigest = digests[binding.Id] };
                    prepared.Add((binding, binding with { EnginePath = binding.FinalPath, PartialPath = null,
                        Selected = false, Filed = true, MediaFileId = media.Id }, media));
                }
                var proposed = await repository.ProposeFiledAsync(prepared.ToImmutable(), ct);
                if (proposed is null) throw new IOException("The file reservation changed during publication.");
                var now = DateTimeOffset.UtcNow;
                var writes = ImmutableArray.CreateBuilder<RowWrite>();
                writes.AddRange(proposed.Value);
                writes.Add(new(target with { State = TargetState.Done, ResumeState = null, ReasonCode = null,
                    ReasonText = null, NextTryAt = null, UpdatedAt = now, Version = target.Version + 1 }, target.Version, null));
                foreach (var file in prepared)
                {
                    var receipt = receipts[file.Before.Id];
                    writes.Add(new(receipt with { State = FileOperationState.Done, MediaFileId = file.Media.Id,
                        UpdatedAt = now }, null, receipt));
                }
                var allFiled = latestBindings.Where(f => f.DownloadId == download.Id && f.Role != FileRole.Unwanted)
                    .All(f => f.Filed || selected.Any(s => s.Id == f.Id));
                if (allFiled)
                {
                    var current = (await store.ListAsync<DownloadRow>(d => d.Id == download.Id, ct)).Single();
                    writes.Add(new(current with { Intent = DownloadIntent.Stopped, FinishedAt = now,
                        Version = current.Version + 1 }, current.Version, null));
                }
                writes.AddRange(await RescanJobWritesAsync(store, prepared.ToImmutable(), ct));
                await TargetPipeline.CommitAsync(store, writes.ToImmutable(), [], ct);
                if (allFiled)
                    try { TorrentFlow.Library.DownloadFiling.RemoveUnwanted(latestBindings.Where(f => f.DownloadId == download.Id), download.Hash); }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { logger.LogWarning(ex, "Could not remove unused torrent fragments {DownloadId}", download.Id); }
            }
            finally { stateGate.Release(); }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            logger.LogWarning(ex, "Could not publish download {DownloadId} target {TargetId}", download.Id, member.Id);
            await FailureAsync(store, download, member.Id, ex, stateGate, ct);
        }
        finally { foreach (var guard in guards.Values) guard.Dispose(); }
    }

    private static async Task FailureAsync(TargetStore store, DownloadRow download, string targetId,
        Exception error, SemaphoreSlim stateGate, CancellationToken ct)
    {
        await stateGate.WaitAsync(ct);
        try
        {
            var target = (await store.ListAsync<TargetRow>(t => t.Id == targetId, ct)).SingleOrDefault();
            if (target is null || target.IsPaused() || target.State != TargetState.Filing || target.ChosenReleaseHash != download.Hash) return;
            var now = DateTimeOffset.UtcNow;
            await TargetPipeline.CommitAsync(store, [new(target with {
                ReasonCode = error is FilingBlockedException ? WaitReason.FilingBlocked : WaitReason.FileBusy,
                ReasonText = error is FilingBlockedException ? error.Message : "Could not finish this download's file. It will be retried.",
                NextTryAt = error is FilingBlockedException ? null : now.AddSeconds(30),
                UpdatedAt = now, Version = target.Version + 1 }, target.Version, null)], [], ct);
        }
        finally { stateGate.Release(); }
    }

    // A filing target with nothing left to move is either already complete or has no video to file.
    private static async Task SettleAsync(TargetStore store, ImmutableArray<DownloadFileRow> allFiles,
        IReadOnlySet<string> targetIds, string hash, SemaphoreSlim stateGate, CancellationToken ct)
    {
        await stateGate.WaitAsync(ct);
        try
        {
            var now = DateTimeOffset.UtcNow;
            var writes = (await store.ListAsync<TargetRow>(null, ct))
                .Where(t => targetIds.Contains(t.Id) && t.State == TargetState.Filing && t.ChosenReleaseHash == hash)
                .Select(t =>
                {
                    var hasVideo = allFiles.Any(f => f.TargetId == t.Id && f.Role == FileRole.Video && f.Filed);
                    var next = hasVideo
                        ? t with { State = TargetState.Done, ResumeState = null, ReasonCode = null, ReasonText = null }
                        : t with { ReasonCode = WaitReason.FilingBlocked,
                            ReasonText = "This source has no video file for this episode. Find another source." };
                    return new RowWrite(next with { NextTryAt = null, UpdatedAt = now, Version = t.Version + 1 },
                        t.Version, null);
                }).ToImmutableArray();
            if (!writes.IsEmpty) await TargetPipeline.CommitAsync(store, writes, [], ct);
        }
        finally { stateGate.Release(); }
    }

    private static async Task<ImmutableArray<RowWrite>> RescanJobWritesAsync(TargetStore store,
        ImmutableArray<(DownloadFileRow Before, DownloadFileRow After, MediaFileRow Media)> filed,
        CancellationToken ct)
    {
        var settingsRow = (await store.ListAsync<SettingRow>(row => row.Id == "jellyfin", ct)).SingleOrDefault();
        if (settingsRow is null) return [];
        var settings = SettingsCatalog.Read<JellyfinSettings>(settingsRow);
        if (settings.ServerUrl is null || settings.Credential is null) return [];
        var now = DateTimeOffset.UtcNow;
        return [.. filed.Where(item => item.Before.TargetId is not null)
            .GroupBy(item => item.Before.TargetId!, StringComparer.Ordinal)
            .Select(group => new RowWrite(new JellyfinJobRow
            {
                Id = Guid.NewGuid().ToString("N"),
                Kind = "rescan",
                PayloadJson = JsonSerializer.SerializeToElement(new
                {
                    paths = group.Select(item => Path.GetDirectoryName(item.Media.Path)!)
                        .Distinct(StringComparer.OrdinalIgnoreCase).ToArray(),
                    mediaFileIds = group.Select(item => item.Media.Id).Distinct(StringComparer.Ordinal).ToArray(),
                    updateType = "Created",
                }),
                TargetId = group.Key,
                MediaFileId = null,
                Attempts = 0,
                NextAttemptAt = now,
                CreatedAt = now,
                LastError = null,
                State = "pending",
            }, null, null))];
    }
}
