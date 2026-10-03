using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Engine;

public interface IExternalEngineAdmission
{
    Task<ImmutableArray<TorrentFile>> PrepareExternalAsync(byte[] torrentBytes, string hash, CancellationToken ct);
    Task<EngineResult> AdmitExternalAsync(EngineAdmission admission, CancellationToken ct);
}
