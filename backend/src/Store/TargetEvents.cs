using System.Collections.Immutable;
using System.Threading.Channels;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

internal sealed class TargetEvents : ITargetEvents
{
    private readonly Channel<ImmutableArray<StoreRow>> channel = Channel.CreateUnbounded<ImmutableArray<StoreRow>>(
        new UnboundedChannelOptions { SingleReader = true, AllowSynchronousContinuations = false });

    public void Publish(ImmutableArray<StoreRow> rows)
    {
        var changes = rows.Where(r => r is TargetRow or DownloadRow or RequestRow).ToImmutableArray();
        if (!changes.IsEmpty) channel.Writer.TryWrite(changes);
    }

    public IAsyncEnumerable<ImmutableArray<StoreRow>> ReadAllAsync(CancellationToken cancellationToken) =>
        channel.Reader.ReadAllAsync(cancellationToken);
}
