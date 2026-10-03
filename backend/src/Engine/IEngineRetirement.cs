namespace TorrentFlow.Engine;

public interface IEngineRetirement
{
    Task ForgetAsync(string downloadId, CancellationToken ct);
}
