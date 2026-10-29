using System.Collections.Immutable;

namespace TorrentFlow.Domain;

public interface ILibraryDownloadRepository : ILibraryRepository
{
    Task<bool> SavePlacementAsync(ImmutableArray<DownloadFileRow> files,
        ImmutableArray<WorkFolderRow> folders, CancellationToken cancellationToken);
    Task<bool> UpdateBindingsAsync(ImmutableArray<(DownloadFileRow Before, DownloadFileRow After)> files,
        ImmutableArray<WorkFolderRow> folders, CancellationToken cancellationToken);
    Task<ImmutableArray<RowWrite>?> ProposeFiledAsync(
        ImmutableArray<(DownloadFileRow Before, DownloadFileRow After, MediaFileRow Media)> files,
        CancellationToken cancellationToken);
    Task<bool> RemoveDownloadFilesAsync(string downloadId, CancellationToken cancellationToken);
    Task<bool> RemoveLibraryFilesAsync(ImmutableArray<DownloadFileRow> files, ImmutableArray<MediaFileRow> media,
        ImmutableArray<DownloadFileRow> replacements, CancellationToken cancellationToken);
}

public sealed record EngineRecoveryBinding(int FileIndex, string AbsolutePath, bool Selected, bool Filed);
public sealed record EngineRecoveryFiles(string DownloadId, ImmutableArray<EngineRecoveryBinding> Files,
    string? StorageRootPath = null);
public interface IEngineFileState
{
    Task<ImmutableArray<EngineRecoveryFiles>> ReadAsync(CancellationToken cancellationToken);
}
