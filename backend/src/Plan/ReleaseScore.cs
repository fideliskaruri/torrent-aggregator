using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Plan;

public sealed partial class ReleasePlanner
{
    private static PlanResult Select(PlanInput input, TargetRow[] targets, List<Option> options, List<Rejection> rejections)
    {
        var missing = targets.Where(t => !input.Owned.Any(o =>
                o.WorkId == t.WorkId && o.EpisodeId == t.EpisodeId && o.Videos.Any(v => v.Role == FileRole.Video &&
                    (v.Status is FilePresence.Present or FilePresence.Offline ||
                     v.Status == FilePresence.Missing && v.MissingConfirmedAt is null))))
            .Select(t => t.Id).ToHashSet(StringComparer.Ordinal);
        var picked = new List<Option>();
        while (options.Count > 0)
        {
            var eligible = options.Where(o => o.Target is null || missing.Contains(o.Target.Id)).ToArray();
            if (eligible.Length == 0) break;
            var seasonCover = input.Work?.Work.Kind == WorkKind.Series && eligible.Any(o =>
                o.Candidate.Release.Parsed.Pack || o.Candidate.Release.Parsed.Kind is
                    ReleaseKind.SeasonPack or ReleaseKind.MultiSeason or ReleaseKind.CompleteSeries);
            var best = eligible.OrderBy(o => o.ResolutionClass).ThenBy(o => o.ResolutionDistance)
                .ThenByDescending(o => o.Candidate.TrustedSeeders ?? 0).ThenByDescending(o => o.Source)
                .ThenByDescending(o => Coverage(o, eligible))
                .ThenBy(o => seasonCover ? Reservation(o, eligible) : 0)
                .ThenByDescending(o => o.Candidate.Observations.Select(v => v.UploadedAt).Max())
                .ThenBy(o => o.Candidate.Release.Id, StringComparer.Ordinal).First();
            // Choose the best option for an item. The next pass considers the remaining scope,
            // so a pack's weaker per-item policy never displaces a stronger single.
            picked.Add(best);
            if (best.Target is null) break;
            missing.Remove(best.Target.Id);
            options.Remove(best);
        }
        foreach (var option in options.Where(o => o.Target is null || !missing.Contains(o.Target.Id)))
            if (!picked.Contains(option))
                rejections.Add(new(option.Candidate.Release.Id, option.Target?.Id,
                    "lower_ranked", "Another eligible source has a better quality, seed count, or coverage fit."));
        var assignments = picked.GroupBy(o => o.Candidate.Release.Id, StringComparer.OrdinalIgnoreCase).Select(g =>
        {
            var first = g.First();
            var files = g.SelectMany(o => o.Files).Distinct().ToImmutableArray();
            var torrentFiles = first.Candidate.Release.Files ?? [];
            var quality = first.Resolution is { } resolution
                ? $"{resolution}p ({QualityFit(first.ResolutionClass)})" : "quality unknown";
            var seeders = first.Candidate.TrustedSeeders ?? 0;
            var text = $"{quality}, {seeders} seeders, {first.Candidate.Release.Parsed.Quality.Source ?? "source unknown"}; " +
                $"{g.Count()} missing item(s) covered.";
            return new Assignment(g.Key, [.. g.Where(o => o.Target is not null).Select(o => o.Target!.Id)],
                files, FileEligibility.Reservation(torrentFiles, files.Select(f => f.FileIndex), first.PieceLength), text);
        }).ToImmutableArray();
        foreach (var target in targets.Where(t => missing.Contains(t.Id)))
            rejections.Add(new("", target.Id, "uncovered_item",
                "No eligible source was selected for this item. Review the source reasons or try again later."));
        return new(assignments, [.. rejections], [.. targets.Where(t => missing.Contains(t.Id)).Select(t => t.Id)]);

        int Coverage(Option o, Option[] available) => available.Where(x => SameRank(o, x) &&
            x.Candidate.Release.Id == o.Candidate.Release.Id).Select(x => x.Target?.Id).Distinct().Count();
        long Reservation(Option o, Option[] available)
        {
            var selection = available.Where(x => SameRank(o, x) && x.Candidate.Release.Id == o.Candidate.Release.Id)
                .SelectMany(x => x.Files).Select(f => f.FileIndex);
            return FileEligibility.Reservation(o.Candidate.Release.Files ?? [], selection, o.PieceLength);
        }
    }

    private static bool SameRank(Option a, Option b) =>
        a.ResolutionClass == b.ResolutionClass && a.ResolutionDistance == b.ResolutionDistance && a.Source == b.Source;
    private static string QualityFit(int fit) => fit switch
        { 0 => "preferred", 1 => "nearest above preferred", 2 => "below preferred, no better eligible option", _ => "not stated" };
    private static int SourceRank(string? source) => source?.ToLowerInvariant().Replace("-", "").Replace(" ", "") switch
        { "remux" => 6, "bluray" or "bdrip" => 5, "webdl" => 4, "webrip" => 3, "hdtv" => 2, "dvdrip" or "dvd" => 1, _ => 0 };
}
