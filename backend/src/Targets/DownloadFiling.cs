using System.Collections.Immutable;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Library;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

internal static class DownloadFiling
{
    internal static async Task FileAsync(TargetStore store, ILibraryDownloadRepository repository, IEngine engine,
        DownloadRow download, EngineSnapshot? snapshot, ImmutableArray<DownloadFileRow> allFiles,
        ImmutableArray<TargetRow> members, SemaphoreSlim stateGate, CancellationToken ct)
    {
        var retrying = download.Intent == DownloadIntent.Stopped &&
            members.Any(t => t.State == TargetState.Filing);
        if (snapshot?.Complete != true && !retrying) return;

        var selected = allFiles.Where(f => f.Selected && !f.Filed && f.TargetId is not null &&
            members.Any(t => t.Id == f.TargetId && t.State is not (TargetState.Paused or TargetState.Removed or TargetState.Done)))
            .ToArray();
        if (selected.Length == 0) return;

        await stateGate.WaitAsync(ct);
        try
        {
            var latestDownload = (await store.ListAsync<DownloadRow>(row => row.Id == download.Id, ct)).Single();
            var latestTargets = (await store.ListAsync<TargetRow>(null, ct))
                .Where(t => members.Any(member => member.Id == t.Id)).ToArray();
            var now = DateTimeOffset.UtcNow;
            var writes = ImmutableArray.CreateBuilder<RowWrite>();
            if (latestDownload.Intent != DownloadIntent.Stopped)
                writes.Add(new(latestDownload with { Intent = DownloadIntent.Stopped,
                    Version = latestDownload.Version + 1 }, latestDownload.Version, null));
            var selectedTargets = selected.Select(f => f.TargetId).OfType<string>().ToHashSet();
            foreach (var target in latestTargets.Where(t => selectedTargets.Contains(t.Id) &&
                t.State is not (TargetState.Removed or TargetState.Done)))
                if (target.State != TargetState.Filing || target.ReasonCode is not null || target.ReasonText is not null)
                    writes.Add(new(target with { State = TargetState.Filing, ResumeState = null,
                        ReasonCode = null, ReasonText = null, NextTryAt = null, UpdatedAt = now,
                        Version = target.Version + 1 }, target.Version, null));
            if (writes.Count > 0) await TargetPipeline.CommitAsync(store, writes.ToImmutable(), [], ct);
        }
        finally { stateGate.Release(); }

        try
        {
            if (snapshot is not null)
            {
                var stopped = await engine.StopAndReleaseFilesAsync(download.Id, ct);
                if (!stopped.WritesDrained || stopped.Failure is not null)
                    throw new IOException(stopped.Failure?.Message ?? "The download could not stop writing. Trying again.");
            }
            var workIds = selected.Select(f => members.Single(t => t.Id == f.TargetId).WorkId).Distinct().ToArray();
            if (workIds.Length != 1) throw new IOException("A download cannot file files from multiple catalog works.");
            var workId = workIds[0];
            var work = (await store.ListAsync<WorkRow>(row => row.Id == workId, ct)).Single();
            var seasons = await store.ListAsync<SeasonRow>(row => row.WorkId == workId, ct);
            var seasonIds = seasons.Select(row => row.Id).ToArray();
            var workSnapshot = new WorkSnapshot(work,
                [.. await store.ListAsync<WorkNameRow>(row => row.WorkId == workId, ct)],
                [.. await store.ListAsync<WorkLinkRow>(row => row.WorkId == workId, ct)],
                [.. seasons],
                [.. await store.ListAsync<EpisodeRow>(row => seasonIds.Contains(row.SeasonId), ct)]);
            var release = (await store.ListAsync<ReleaseRow>(row => row.Id == download.Hash, ct)).Single();
            var prepared = ImmutableArray.CreateBuilder<(DownloadFileRow Before, DownloadFileRow After, MediaFileRow Media)>();
            foreach (var binding in selected)
            {
                var source = binding.PartialPath ?? throw new IOException("A selected download file has no partial path.");
                var final = binding.FinalPath ?? throw new IOException("A selected download file has no final path.");
                LibraryPaths.NoLinks(source);
                LibraryPaths.NoLinks(final);
                var physical = File.Exists(source) ? source : final;
                var validation = TorrentFlow.Library.DownloadFiling.ValidatePartial(binding,
                    new(binding.FileIndex, binding.ExpectedBytes, binding.ExpectedBytes, 0, true, physical, true));
                if (validation is not null) throw new IOException(validation.Message);
                if (File.Exists(source))
                {
                    if (File.Exists(final) || Directory.Exists(final))
                        throw new IOException("A file already uses the library destination. Review it before retrying.");
                    File.Move(source, final);
                }

                var digest = await TorrentFlow.Library.DownloadFiling.DigestAsync(final, ct);
                var target = members.Single(t => t.Id == binding.TargetId);
                var media = TorrentFlow.Library.DownloadFiling.Media(download, workSnapshot, target,
                    release.Parsed.Quality.Resolution, release.Parsed.Quality.Source, binding) with
                    { ContentDigest = digest };
                prepared.Add((binding, binding with { EnginePath = final, PartialPath = null,
                    Selected = false, Filed = true, MediaFileId = media.Id }, media));
            }

            await stateGate.WaitAsync(ct);
            try
            {
                var filedWrites = await repository.ProposeFiledAsync(prepared.ToImmutable(), ct);
                if (filedWrites is null) return;
                var latestDownload = (await store.ListAsync<DownloadRow>(row => row.Id == download.Id, ct)).Single();
                var latestBindings = await repository.BindingsAsync(ct);
                var completedIds = prepared.Select(p => p.Before.TargetId).OfType<string>().Distinct().ToArray();
                var latestTargets = (await store.ListAsync<TargetRow>(null, ct))
                    .Where(t => completedIds.Contains(t.Id)).ToArray();
                var now = DateTimeOffset.UtcNow;
                var writes = ImmutableArray.CreateBuilder<RowWrite>();
                foreach (var target in latestTargets)
                {
                    var targetFiles = latestBindings.Where(f => f.TargetId == target.Id && f.Role != FileRole.Unwanted);
                    if (!targetFiles.Any(f => f.Role == FileRole.Video) ||
                        targetFiles.Any(f => !f.Filed && prepared.All(p => p.Before.Id != f.Id))) continue;
                    writes.Add(new(target with { State = TargetState.Done, ResumeState = null, ReasonCode = null,
                        ReasonText = null, NextTryAt = null, UpdatedAt = now, Version = target.Version + 1 },
                        target.Version, null));
                    writes.Add(new(new AttemptRow { Id = Guid.NewGuid().ToString("N"), TargetId = target.Id,
                        WorkId = target.WorkId, ReleaseHash = download.Hash, ActorUserId = target.CreatedBy,
                        Kind = AttemptKind.File, StartedAt = now, EndedAt = now, Outcome = "Done",
                        ReasonCode = null, ReasonText = null, Decision = null, LegacyContext = null,
                        BatchId = target.BatchId, DownloadId = download.Id, DeadlineAt = null, Swap = null },
                        null, null));
                }
                var allFiled = latestBindings.Where(f => f.DownloadId == download.Id && f.Role != FileRole.Unwanted)
                    .All(f => f.Filed || prepared.Any(p => p.Before.Id == f.Id));
                if (allFiled)
                    writes.Add(new(latestDownload with { Intent = DownloadIntent.Stopped,
                        FinishedAt = now, Version = latestDownload.Version + 1 }, latestDownload.Version, null));
                writes.AddRange(filedWrites.Value);
                await TargetPipeline.CommitAsync(store, writes.ToImmutable(), [], ct);
            }
            finally { stateGate.Release(); }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            await stateGate.WaitAsync(ct);
            try
            {
                var now = DateTimeOffset.UtcNow;
                var latestTargets = (await store.ListAsync<TargetRow>(null, ct))
                    .Where(t => members.Any(member => member.Id == t.Id) &&
                        t.State is not (TargetState.Removed or TargetState.Done)).ToArray();
                var writes = latestTargets.Select(t => new RowWrite(t with
                {
                    State = TargetState.Filing, ReasonCode = WaitReason.FileBusy,
                    ReasonText = $"{ex.Message} Close any app using the file and it will be retried.",
                    UpdatedAt = now, Version = t.Version + 1,
                }, t.Version, null)).ToImmutableArray();
                if (!writes.IsEmpty) await TargetPipeline.CommitAsync(store, writes, [], ct);
            }
            finally { stateGate.Release(); }
        }
    }
}
