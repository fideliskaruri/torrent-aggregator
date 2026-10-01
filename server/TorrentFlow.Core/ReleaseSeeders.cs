namespace TorrentFlow.Core;

/// <summary>Seeder thresholds shared by availability badges, the title page and release ranking.</summary>
public static class ReleaseSeeders
{
    /// <summary>
    /// A release with at least this many seeders is "viable": the title shows as fetchable and ranking prefers it.
    /// Not the same as ReleaseRanking.UsableSeeders (10), which splits weak from well-seeded viable releases.
    /// </summary>
    public const int MinViable = 3;

    public static bool IsViable(int seeders) => seeders >= MinViable;
}
