using System.Collections.Immutable;

namespace TorrentFlow.Domain;

/// <summary>Committed state only. Notification failures must never fail a target command.</summary>
public interface ITargetEvents
{
    void Publish(ImmutableArray<StoreRow> rows);
    IAsyncEnumerable<ImmutableArray<StoreRow>> ReadAllAsync(CancellationToken cancellationToken);
}
