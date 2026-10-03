using System.Collections.Immutable;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Find;

internal sealed partial class CandidatePool(IParser parser, WorkSnapshot? work, TargetScope? scope)
{
    private readonly Dictionary<string, Candidate> candidates = new(StringComparer.Ordinal);
    private readonly Dictionary<string, FindRejection> rejections = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Dictionary<string, ReleaseObservationRow>> observationsByHash = new(StringComparer.Ordinal);
    internal ImmutableArray<Candidate> Candidates => [.. candidates.Values.OrderBy(c => c.Release.Id, StringComparer.Ordinal)];
    internal ImmutableArray<FindRejection> Rejections => [.. rejections.Values];

    internal void Add(SourceResult result, string query)
    {
        foreach (var raw in result.Results)
        {
            var hash = parser.NormalizeInfoHash(raw.Hash) ?? parser.NormalizeInfoHash(raw.Magnet ?? "");
            var now = result.Diagnostics?.StartedAt ?? DateTimeOffset.UtcNow;
            if (hash is not null)
            {
                if (!observationsByHash.TryGetValue(hash, out var seen))
                    observationsByHash[hash] = seen = new(StringComparer.Ordinal);
                var observation = new ReleaseObservationRow(hash + ":" + result.SourceId + ":" + query,
                    hash, result.SourceId, raw.SourceItemId, query, raw.ListedSeeders, raw.ListedLeechers,
                    raw.UploadedAt, now, raw.TorrentUri, raw.WebSeeds);
                seen[observation.Id] = observation;
                if (candidates.TryGetValue(hash, out var known))
                    candidates[hash] = WithObservations(known, seen.Values);
            }
            ParsedRelease? parse = null;
            string? code = null;
            string? reason = null;
            if (hash is null) { code = "invalid_hash"; reason = "The listing has no valid infohash."; }
            else if (raw.Name.Length > TorrentFlow.Parser.ReleaseParser.MaximumNameLength)
            { code = "invalid_name"; reason = "The release name exceeds the parser limit."; }
            else parse = parser.Parse(raw.Name);
            var coverage = ImmutableArray<string>.Empty;
            if (code is null && work is not null && scope is not null)
                (code, reason, coverage) = Filter(parse!);
            if (code is not null)
            {
                var rejection = new FindRejection(hash ?? raw.Hash, raw.Name, result.SourceId, query, code, reason!);
                rejections[rejection.Hash + "\0" + raw.Name + "\0" + result.SourceId + "\0" + query] = rejection;
                continue;
            }
            if (!candidates.TryGetValue(hash!, out var existing))
            {
                var release = new ReleaseRow(hash!, raw.Name, parse!, raw.Bytes, raw.TorrentUri,
                    raw.Magnet, null, null, null, now, now);
                existing = new(release, [], null) { CoveredEpisodeIds = coverage, CoversFilm = scope?.Film == true };
            }
            // Conflicting names for one hash must not erase explicit safety/language evidence.
            var retained = MergeFlags(existing.Release.Parsed, parse!);
            candidates[hash!] = WithObservations(existing with
            {
                Release = existing.Release with
                {
                    FirstSeenAt = existing.Release.FirstSeenAt < now ? existing.Release.FirstSeenAt : now,
                    LastSeenAt = existing.Release.LastSeenAt > now ? existing.Release.LastSeenAt : now,
                    Parsed = retained,
                    Magnet = existing.Release.Magnet ?? raw.Magnet,
                    TorrentUri = existing.Release.TorrentUri ?? raw.TorrentUri
                },
                CoveredEpisodeIds = [.. existing.CoveredEpisodeIds.Union(coverage)]
            }, observationsByHash[hash!].Values);
        }
    }

    internal static ParsedRelease MergeFlags(ParsedRelease current, ParsedRelease incoming)
    {
        if ((!incoming.Unsafe || current.Unsafe) && (!incoming.ClearlyForeign || current.ClearlyForeign) &&
            (!incoming.Cam || current.Cam) && (!incoming.Sample || current.Sample) &&
            !incoming.LanguageMarkers.Except(current.LanguageMarkers).Any()) return current;
        return current with
        {
            Unsafe = current.Unsafe || incoming.Unsafe,
            ClearlyForeign = current.ClearlyForeign || incoming.ClearlyForeign,
            Foreign = current.ClearlyForeign || incoming.ClearlyForeign ? ForeignStatus.Yes : current.Foreign,
            LanguageMarkers = [.. current.LanguageMarkers.Union(incoming.LanguageMarkers)],
            Cam = current.Cam || incoming.Cam,
            Sample = current.Sample || incoming.Sample
        };
    }

    private static Candidate WithObservations(Candidate candidate, IEnumerable<ReleaseObservationRow> seen)
    {
        var observations = seen.ToImmutableArray();
        var counts = observations.Where(o => o.ListedSeeders is >= 0).Select(o => o.ListedSeeders!.Value).ToArray();
        return candidate with
        {
            Observations = observations, ConservativeListedSeeders = counts.Length == 0 ? null : counts.Min()
        };
    }

    internal void Scrapes(IReadOnlyDictionary<string, int> scrapes)
    {
        foreach (var (hash, count) in scrapes)
            if (count >= 0 && candidates.TryGetValue(hash, out var candidate))
                candidates[hash] = candidate with { ScrapedSeeders = count };
    }

    private (string? Code, string? Reason, ImmutableArray<string> Coverage) Filter(ParsedRelease parsed)
    {
        var title = SearchQueries.Fold(PackSuffix().Replace(parsed.Title, ""));
        if (!SearchQueries.IdentityNames(work!).Contains(title, StringComparer.Ordinal))
            return ("title_mismatch", $"Parsed title '{parsed.Title}' does not match any catalog name at word boundaries.", []);
        var requested = work!.Episodes.Where(e => scope!.EpisodeIds.Contains(e.Id)).ToArray();
        var years = requested.Where(e => e.AirAt.HasValue).Select(e => e.AirAt!.Value.Year)
            .Append(work.Work.Year ?? 0);
        if (parsed.Year is { } year && work.Work.Year.HasValue && !years.Any(y => Math.Abs(y - year) <= 1))
            return ("year_mismatch", $"Release year {year} is outside the catalog year tolerance (one year).", []);
        if (scope!.Film)
            return parsed.Kind == ReleaseKind.Movie
                ? (null, null, [])
                : ("kind_mismatch", $"A film cannot use a {parsed.Kind} release.", []);
        if (parsed.Kind is ReleaseKind.Movie or ReleaseKind.Other or ReleaseKind.Special)
            return ("kind_mismatch", $"An episode scope cannot use a {parsed.Kind} release.", []);
        var covered = requested.Where(e => Covers(parsed, e)).Select(e => e.Id).ToImmutableArray();
        return covered.IsEmpty
            ? ("scope_mismatch", "The parsed season/episode/absolute range does not cover any requested item.", [])
            : (null, null, covered);
    }

    private bool Covers(ParsedRelease parse, EpisodeRow e)
    {
        var season = work!.Seasons.First(s => s.Id == e.SeasonId);
        if (season.MappingStatus != MappingStatus.Confirmed || e.MappingStatus != MappingStatus.Confirmed) return false;
        if (!parse.Seasons.IsEmpty)
        {
            if (!parse.Seasons.Contains(season.Number)) return false;
            if (parse.Pack) return true;
            return parse.Episodes.Contains(e.Number) || parse.EpisodeRanges.Any(r => e.Number >= r.First && e.Number <= r.Last);
        }
        if (parse.Kind == ReleaseKind.CompleteSeries) return true;
        if (work.Work.Anime == true && e.AbsoluteNumber is { } absolute)
            return parse.AbsoluteNumbers.Contains(absolute) ||
                parse.AbsoluteRanges.Any(r => absolute >= r.First && absolute <= r.Last);
        return false;
    }

    [GeneratedRegex(@"\s+(?:(?:complete\s+)?(?:series|season)\s*(?:pack)?|complete|batch|collection)\s*$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PackSuffix();
}
