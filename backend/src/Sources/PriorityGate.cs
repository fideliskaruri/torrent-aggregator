using System.Diagnostics;
using TorrentFlow.Domain;

namespace TorrentFlow.Sources;

internal sealed class PriorityGate
{
    private readonly object sync = new();
    private readonly LinkedList<Waiter> owners = new();
    private readonly LinkedList<Waiter> background = new();
    private int active;
    private int backgroundActive;
    private long nextStart;
    private bool pumping;
    private int strikes;
    private DateTimeOffset? coolingUntil;
    private long coolingEnd;
    private int concurrency = 2;
    private int spacing = 250;
    private readonly int backgroundLimit;

    internal PriorityGate(int backgroundLimit = int.MaxValue) => this.backgroundLimit = backgroundLimit;

    internal DateTimeOffset? Cooldown
    {
        get { lock (sync) return Stopwatch.GetTimestamp() < coolingEnd ? coolingUntil : null; }
    }

    internal void Observe(int status, TimeSpan? retryAfter)
    {
        lock (sync)
        {
            if (status == 429 || status == 503 && retryAfter.HasValue)
            {
                var delay = retryAfter ?? TimeSpan.FromSeconds(Math.Min(300, 30 * Math.Pow(2, Math.Min(strikes++, 4))));
                delay = delay < TimeSpan.Zero ? TimeSpan.Zero : delay;
                var due = DateTimeOffset.UtcNow + delay;
                if (coolingUntil is null || due > coolingUntil)
                {
                    coolingUntil = due;
                    coolingEnd = Stopwatch.GetTimestamp() + (long)(delay.TotalSeconds * Stopwatch.Frequency);
                }
                foreach (var queue in new[] { owners, background })
                {
                    while (queue.First is { } node)
                    {
                        queue.RemoveFirst();
                        node.Value.Completion.TrySetException(new SourceException("CoolingDown",
                            "The site is cooling down.", coolingUntil));
                    }
                }
            }
            else if (status is >= 200 and < 300) strikes = 0;
        }
    }

    internal async Task<IDisposable> EnterAsync(PriorityLane lane, int max, int spacingMs, CancellationToken ct)
    {
        var waiter = new Waiter(lane);
        lock (sync)
        {
            if (Stopwatch.GetTimestamp() < coolingEnd)
                throw new SourceException("CoolingDown", "The site is cooling down.", coolingUntil);
            concurrency = Math.Clamp(max, 1, 24);
            spacing = Math.Max(0, spacingMs);
            waiter.Node = (waiter.Lane == PriorityLane.Owner ? owners : background).AddLast(waiter);
            Wake();
        }
        using var registration = ct.Register(() =>
        {
            lock (sync)
            {
                if (waiter.Node?.List is { } list) list.Remove(waiter.Node);
                waiter.Completion.TrySetCanceled(ct);
                Wake();
            }
        });
        return await waiter.Completion.Task.ConfigureAwait(false);
    }

    private void Wake()
    {
        if (pumping) return;
        pumping = true;
        _ = Task.Run(Pump);
    }

    private async Task Pump()
    {
        while (true)
        {
            int wait;
            lock (sync)
            {
                var queue = owners.Count > 0 ? owners : background;
                if (queue.Count == 0 || active >= concurrency ||
                    queue == background && backgroundActive >= backgroundLimit)
                {
                    pumping = false;
                    return;
                }
                wait = (int)Math.Ceiling(Math.Max(0, nextStart - Stopwatch.GetTimestamp()) * 1000d / Stopwatch.Frequency);
                if (wait == 0)
                {
                    var waiter = queue.First!.Value;
                    queue.RemoveFirst();
                    active++;
                    if (waiter.Lane == PriorityLane.Background) backgroundActive++;
                    nextStart = Stopwatch.GetTimestamp() + (long)(spacing * Stopwatch.Frequency / 1000d);
                    waiter.Completion.SetResult(new Lease(this, waiter.Lane));
                    continue;
                }
            }
            await Task.Delay(wait).ConfigureAwait(false);
        }
    }

    private sealed class Waiter(PriorityLane lane)
    {
        internal PriorityLane Lane { get; } = lane;
        internal TaskCompletionSource<IDisposable> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal LinkedListNode<Waiter>? Node { get; set; }
    }

    private sealed class Lease(PriorityGate gate, PriorityLane lane) : IDisposable
    {
        private int disposed;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0) return;
            lock (gate.sync)
            {
                gate.active--;
                if (lane == PriorityLane.Background) gate.backgroundActive--;
                gate.Wake();
            }
        }
    }
}
