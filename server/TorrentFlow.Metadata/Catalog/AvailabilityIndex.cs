using System.Text.RegularExpressions;

namespace TorrentFlow.Metadata.Catalog;

/// <summary>availability.ts AvailabilitySignal.</summary>
public sealed record AvailabilitySignal(int PeakSeeders, string BestRelease);

/// <summary>
/// src/lib/catalog/availability.ts: chart-derived swarm evidence keyed by work, with a ±1 year name fallback so a
/// TMDB "2024" film still finds a release named "2023".
/// </summary>
public sealed partial class AvailabilityIndex
{
    private const int YearSlack = 1;
    private readonly Dictionary<string, AvailabilitySignal> _byKey = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<(int? Year, AvailabilitySignal Signal)>> _byName = new(StringComparer.Ordinal);

    public int Size { get; }

    public static readonly AvailabilityIndex Empty = new([]);

    [GeneratedRegex(@"^\d{4}$")] private static partial Regex FourDigits();

    public AvailabilityIndex(IReadOnlyList<ChartWork> works)
    {
        Size = works.Count;
        foreach (var work in works)
        {
            var signal = new AvailabilitySignal(work.PeakSeeders, work.BestRelease);
            if (!_byKey.TryGetValue(work.WorkKey, out var existing) || signal.PeakSeeders > existing.PeakSeeders) _byKey[work.WorkKey] = signal;
            if (NameIndexKey(work.WorkKey) is { } nameKey)
            {
                if (!_byName.TryGetValue(nameKey, out var bucket)) _byName[nameKey] = bucket = [];
                bucket.Add((work.Year, signal));
            }
        }
    }

    private static string? NameIndexKey(string workKey)
    {
        var cut = workKey.LastIndexOf(':');
        if (cut <= 0) return null;
        var tail = workKey[(cut + 1)..];
        return tail.Length != 0 && !FourDigits().IsMatch(tail) ? null : workKey[..cut];
    }

    public AvailabilitySignal? Match(string workKey, int? year)
    {
        if (string.IsNullOrEmpty(workKey)) return null;
        if (_byKey.TryGetValue(workKey, out var exact)) return exact;
        if (NameIndexKey(workKey) is not { } nameKey || !_byName.TryGetValue(nameKey, out var bucket)) return null;
        AvailabilitySignal? best = null;
        foreach (var (candidateYear, signal) in bucket)
        {
            if (year is not null && candidateYear is not null && Math.Abs(candidateYear.Value - year.Value) > YearSlack) continue;
            if (best is null || signal.PeakSeeders > best.PeakSeeders) best = signal;
        }
        return best;
    }
}
