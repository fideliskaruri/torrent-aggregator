using System.Collections.Immutable;

namespace TorrentFlow.Domain;

public interface ILibraryDownloadRepository : ILibraryRepository
{
    Task<bool> SavePlacementAsync(ImmutableArray<DownloadFileRow> files,
        ImmutableArray<WorkFolderRow> folders, CancellationToken cancellationToken);
    Task<bool> CommitFiledAsync(DownloadFileRow before, DownloadFileRow after,
        MediaFileRow media, CancellationToken cancellationToken);
    Task<LibraryWriteProposal?> ProposeFiledAsync(DownloadFileRow before, DownloadFileRow after,
        MediaFileRow media, CancellationToken cancellationToken);
    Task<bool> BeginFilingAsync(DownloadFileRow binding, string digest, CancellationToken cancellationToken);
    Task<ImmutableArray<FileOperationRow>> FilingOperationsAsync(CancellationToken cancellationToken);
    Task<bool> RemoveDownloadFilesAsync(string downloadId, CancellationToken cancellationToken);
    Task<bool> RemoveLibraryFilesAsync(ImmutableArray<DownloadFileRow> files, ImmutableArray<MediaFileRow> media,
        ImmutableArray<DownloadFileRow> replacements, CancellationToken cancellationToken);
}

public abstract class LibraryWriteProposal
{
    protected LibraryWriteProposal() { }
}

public sealed record DownloadFilingContext(DownloadRow Download, WorkSnapshot Work,
    ImmutableArray<TargetRow> Targets, int? Resolution, string? Source);

public sealed record EngineRecoveryBinding(int FileIndex, string AbsolutePath, bool Selected, bool Filed);
public sealed record EngineRecoveryFiles(string DownloadId, ImmutableArray<EngineRecoveryBinding> Files);
public interface IEngineFileState
{
    Task<ImmutableArray<EngineRecoveryFiles>> ReadAsync(CancellationToken cancellationToken);
}

public interface IEngineFilePublisher
{
    Task<EngineResult> PublishFilingAsync(EngineFilingPermit permit, CancellationToken cancellationToken);
}
