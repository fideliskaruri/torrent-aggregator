namespace TorrentFlow.Domain;

public sealed class SourceRequestBudget(int limit, SourceRequestBudget? parent = null)
{
    private int used;
    private readonly TaskCompletionSource completed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public int Limit { get; } = limit > 0 ? limit : throw new ArgumentOutOfRangeException(nameof(limit));
    public int Used => Volatile.Read(ref used);
    public Task Finished => completed.Task;
    public bool TryAcquire()
    {
        while (true)
        {
            var current = Used;
            if (current >= Limit) return false;
            if (Interlocked.CompareExchange(ref used, current + 1, current) != current) continue;
            if (parent is null || parent.TryAcquire()) return true;
            Interlocked.Decrement(ref used);
            return false;
        }
    }
    public void Finish() => completed.TrySetResult();
}
