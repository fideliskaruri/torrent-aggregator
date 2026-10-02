namespace TorrentFlow.Library.Features.Grabs;

/// <summary>
/// Keeps a work's grabs and the renumbering of its stored rows apart (<see cref="AnimeNumberingReconciler"/>). Any number
/// of grabs and wanted runs of one work share it (a show's seasons run side by side, and a run's grabs nest inside it);
/// renumbering takes it alone and never waits: while any grab of the work is in flight it is skipped and tried again
/// later, so a grab never settles a target under a key that moved meanwhile. Keyed by work id.
/// </summary>
public static class WorkGrabGate
{
    private const int Renumbering = -1;
    private static readonly Dictionary<string, int> holders = new(StringComparer.Ordinal);

    /// <summary>Enters as a grab, waiting out a renumbering of the work (which takes a moment and no network).</summary>
    public static async Task<IDisposable> EnterAsync(string workId, CancellationToken ct)
    {
        while (true)
        {
            lock (holders)
            {
                var count = holders.GetValueOrDefault(workId);
                if (count != Renumbering)
                {
                    holders[workId] = count + 1;
                    return new Exit(workId);
                }
            }
            await Task.Delay(50, ct);
        }
    }

    /// <summary>Takes the work alone for a renumbering; null while any grab of it is in flight.</summary>
    public static IDisposable? TryRenumber(string workId)
    {
        lock (holders)
        {
            if (holders.ContainsKey(workId)) return null;
            holders[workId] = Renumbering;
            return new Exit(workId);
        }
    }

    private sealed class Exit(string workId) : IDisposable
    {
        private int done;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref done, 1) == 1) return;
            lock (holders)
            {
                var count = holders.GetValueOrDefault(workId);
                if (count is Renumbering or <= 1) holders.Remove(workId);
                else holders[workId] = count - 1;
            }
        }
    }
}
