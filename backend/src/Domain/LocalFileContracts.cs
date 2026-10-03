namespace TorrentFlow.Domain;

public enum LocalFileError { Invalid, Forbidden, Missing, Conflict, Gone, TooLarge, Failed }
public sealed record LocalFileResult(object Body, LocalFileError? Error = null);

public interface ILocalFiles
{
    LocalFileResult Browse(string? path);
    Task<LocalFileResult> OpenFolderAsync(string? path, string? category, bool reveal, CancellationToken ct);
    Task<LocalFileResult> OpenDownloadAsync(string id, string mode, CancellationToken ct);
}
