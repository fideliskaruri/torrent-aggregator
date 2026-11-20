using System.Collections.Concurrent;
using System.Diagnostics;

namespace TorrentFlow.Domain;

/// <summary>Bounded, operation-scoped observations. No paths, payloads or persistent history.</summary>
public sealed class DeletionMeasurement : IDisposable
{
    private static readonly AsyncLocal<DeletionMeasurement?> Current = new();
    private readonly DeletionMeasurement? previous;
    private readonly ConcurrentDictionary<string, long> counters = new(StringComparer.Ordinal);
    private readonly Stopwatch timer = Stopwatch.StartNew();
    public string OperationId { get; } = Guid.NewGuid().ToString("N");
    public double ElapsedMilliseconds => timer.Elapsed.TotalMilliseconds;
    public IReadOnlyDictionary<string, long> Counters => counters;
    public DeletionMeasurement() { previous = Current.Value; Current.Value = this; }
    public static void Add(string counter, long amount = 1) => Current.Value?.counters.AddOrUpdate(counter, amount, (_, n) => n + amount);
    public static IDisposable Time(string stage) => new Stage(stage);
    public void Dispose() { timer.Stop(); Current.Value = previous; }
    private sealed class Stage(string name) : IDisposable
    {
        private readonly long started = Stopwatch.GetTimestamp();
        public void Dispose() => Add(name + "Ticks", Stopwatch.GetElapsedTime(started).Ticks);
    }
}
