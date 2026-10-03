using TorrentFlow.Domain;

namespace TorrentFlow.Find;

internal sealed class SearchBudget
{
    private readonly object sync = new();
    private readonly LinkedList<Waiter> owners = new();
    private readonly LinkedList<Waiter> background = new();
    private int active;
    private int backgroundActive;

    internal async Task<IDisposable> EnterAsync(PriorityLane lane, CancellationToken ct)
    {
        var waiter = new Waiter(lane);
        lock (sync)
        {
            waiter.Node = (lane == PriorityLane.Owner ? owners : background).AddLast(waiter);
            Drain();
        }
        using var cancellation = ct.Register(() =>
        {
            lock (sync)
            {
                if (waiter.Node?.List is { } list) list.Remove(waiter.Node);
                waiter.Completion.TrySetCanceled(ct);
                Drain();
            }
        });
        return await waiter.Completion.Task.ConfigureAwait(false);
    }

    private void Drain()
    {
        while (active < 8)
        {
            var queue = owners.Count > 0 ? owners : background;
            if (queue.Count == 0 || queue == background && backgroundActive >= 2) return;
            var waiter = queue.First!.Value;
            queue.RemoveFirst();
            active++;
            if (waiter.Lane == PriorityLane.Background) backgroundActive++;
            waiter.Completion.SetResult(new Lease(this, waiter.Lane));
        }
    }

    private sealed class Waiter(PriorityLane lane)
    {
        internal PriorityLane Lane { get; } = lane;
        internal LinkedListNode<Waiter>? Node { get; set; }
        internal TaskCompletionSource<IDisposable> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private sealed class Lease(SearchBudget budget, PriorityLane lane) : IDisposable
    {
        private int disposed;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0) return;
            lock (budget.sync)
            {
                budget.active--;
                if (lane == PriorityLane.Background) budget.backgroundActive--;
                budget.Drain();
            }
        }
    }
}
