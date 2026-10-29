namespace TorrentFlow.Domain;

public readonly record struct ReleaseGate(bool Coming, bool InTheatricalWindow,
    DateTimeOffset? ReleaseAt, DateTimeOffset? AvailableAt);

public static class ReleaseAvailability
{
    public static DateTimeOffset? ReleaseDate(WorkSnapshot work) =>
        work.PremiereAt ?? work.Work.TheatricalAt ??
        work.Episodes.Where(episode => episode.AirAt is not null &&
                work.Seasons.Any(season => season.Id == episode.SeasonId && season.Number > 0))
            .MinBy(episode => episode.AirAt)?.AirAt;

    public static bool HunterReleased(WorkSnapshot work, DateTimeOffset now)
    {
        var releaseAt = ReleaseDate(work);
        return releaseAt is null
            ? work.Work.Year is { } year && year < now.Year
            : releaseAt <= now;
    }

    public static bool InTheatricalWindow(WorkSnapshot work, DateTimeOffset now)
    {
        if (work.Work.Kind != WorkKind.Film) return false;
        if (work.InTheatricalWindow is { } cached) return cached;

        var theatricalAt = work.Work.TheatricalAt;
        if (theatricalAt is null || theatricalAt > now) return false;
        var homeAt = new[] { work.Work.DigitalAt, work.Work.PhysicalAt }
            .OfType<DateTimeOffset>().Order().Cast<DateTimeOffset?>().FirstOrDefault();
        return homeAt is { } date ? date > now : theatricalAt > now.AddDays(-21);
    }

    public static ReleaseGate BrowseGate(WorkSnapshot work, DateTimeOffset now)
    {
        var releaseAt = ReleaseDate(work);
        var coming = releaseAt > now ||
            work.Work.Kind == WorkKind.Film && releaseAt is null &&
            work.Work.Year is { } year && year >= now.Year;
        if (coming) return new(true, false, releaseAt, releaseAt);

        var inTheatricalWindow = InTheatricalWindow(work, now);
        if (!inTheatricalWindow) return new(false, false, releaseAt, null);

        var homeAt = new[] { work.Work.DigitalAt, work.Work.PhysicalAt }
            .OfType<DateTimeOffset>().Where(date => date > now).Order().Cast<DateTimeOffset?>().FirstOrDefault();
        DateTimeOffset? fallbackAt = work.Work.TheatricalAt is { } theatricalAt
            ? theatricalAt.AddDays(21) : null;
        return new(false, true, releaseAt, homeAt ?? (fallbackAt > now ? fallbackAt : null));
    }
}
