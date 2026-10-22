using System.Collections.Immutable;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;
using TorrentFlow.Find;
using TorrentFlow.Library;
using TorrentFlow.Plan;

namespace TorrentFlow.Targets;

public sealed record ExternalWorkChoice(string WorkKey, string Title, int? Year, string Kind, string? Poster);
public sealed record ExternalIdentityResult(bool Confident, WorkSnapshot? Work,
    ImmutableArray<string> EpisodeIds, bool Film, string? Summary,
    ImmutableArray<ExternalWorkChoice> Choices, ParsedRelease Parsed);

public sealed class ExternalIdentity(IParser parser, IMetadata metadata)
{
    private static readonly Regex PackTitleSuffix = new(
        @"[\s:,.-]*(?:\bthe\s+)?\b(?:complete(?:\s+(?:tv\s+|cartoon\s+)?(?:series|seasons?|collection|box\s*set))?|full\s+series|tv\s+series|box\s*set|batch|collection)\s*$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex PackSuffix = new(
        @"\s+(?:(?:complete\s+)?(?:series|season)\s*(?:pack)?|complete|batch|collection)\s*$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public async Task<ExternalIdentityResult> IdentifyAsync(string hash, string? displayName,
        ImmutableArray<TorrentFile>? files, string? workKey, CancellationToken ct)
    {
        var parsed = ParseIdentity(displayName, files);
        var name = parsed.Title.Trim();
        var coordinate = HasCoordinates(parsed) || files is { } items &&
            items.Where(IsVideo).Any(file => HasCoordinates(ParseLeaf(file.RelativePath)));
        var kind = coordinate ? WorkKind.Series : WorkKind.Film;

        MetadataResult? resolved;
        CatalogResult? search = null;
        if (!string.IsNullOrWhiteSpace(workKey))
        {
            resolved = await WithTimeout(token => metadata.GetWorkAsync(workKey, false, token), ct);
            if (resolved?.Work is { } chosen)
            {
                var scope = Scope(chosen, parsed, files);
                var film = chosen.Work.Kind == WorkKind.Film;
                return new(false, chosen, scope, film,
                    scope.IsEmpty && !film ? null : Summary(chosen, scope), [], parsed);
            }
            return new(false, null, [], kind == WorkKind.Film, null, [], parsed);
        }

        if (name.Length == 0)
            return new(false, null, [], kind == WorkKind.Film, null, [], parsed);

        var stripped = PackTitleSuffix.Replace(name, "").Trim();
        var candidateStripped = PackSuffix.Replace(name, "").Trim();
        var titleMatches = new[] { SearchQueries.Fold(name), SearchQueries.Fold(stripped),
                SearchQueries.Fold(candidateStripped) }
            .Where(v => v.Length > 0).Distinct(StringComparer.Ordinal).ToArray();
        var resolveTask = WithTimeout(token => metadata.ResolveAsync(
            new(null, name, parsed.Year, kind), token), ct);
        var searchTask = WithTimeout(token => metadata.SearchAsync(
            new(stripped.Length > 0 ? stripped : name, kind == WorkKind.Series ? "series" : "films", 20), token), ct);
        await Task.WhenAll(resolveTask, searchTask);
        resolved = await resolveTask;
        search = await searchTask;

        var exactHits = search?.Works.Where(work => work.Work.Kind == kind &&
                work.Names.Any(n => titleMatches.Contains(SearchQueries.Fold(n.Value), StringComparer.Ordinal)))
            .DistinctBy(work => work.Work.Id, StringComparer.Ordinal).ToArray() ?? [];
        var choices = (search?.Works ?? []).Where(work => work.Work.Kind == kind)
            .DistinctBy(work => work.Work.Id, StringComparer.Ordinal).Take(6)
            .Select(ToChoice).ToImmutableArray();
        var work = resolved?.Work;
        var exactName = work is not null && work.Names.Any(n =>
            titleMatches.Contains(SearchQueries.Fold(n.Value), StringComparer.Ordinal));
        var yearMatched = work is not null && parsed.Year is { } year && work.Work.Year == year;
        var filmYearOkay = kind != WorkKind.Film || parsed.Year is null || yearMatched;
        var notAmbiguous = resolved?.Failure?.Code != "ambiguous";
        var scopeIds = work is null ? [] : Scope(work, parsed, files);
        var confident = work is not null && resolved!.Complete && notAmbiguous && exactName &&
            work.Work.Kind == kind && filmYearOkay && (yearMatched || exactHits.Length == 1) &&
            (kind == WorkKind.Film || !scopeIds.IsEmpty);
        var hits = exactHits.Where(h => parsed.Year is not { } y || h.Work.Year == y).ToArray();
        if (!confident && hits.Length is >= 1 and <= 4)
        {
            // Same-name titles (Bluey 2018 and 1976): only one usually has the episodes this torrent holds.
            var full = await Task.WhenAll(hits.Select(hit =>
                WithTimeout(token => metadata.GetWorkAsync(hit.Work.WorkKey, false, token), ct)));
            var covering = full.Select(r => r?.Work).OfType<WorkSnapshot>().Where(w => w.Work.Kind == kind)
                .Select(w => (Work: w, Scope: Scope(w, parsed, files)))
                .Where(x => kind == WorkKind.Film || !x.Scope.IsEmpty)
                .OrderByDescending(x => x.Scope.Length).ToArray();
            // Larger scope only means something when it comes from the real file list.
            if (covering.Length == 1 || covering.Length > 1 && kind == WorkKind.Series &&
                files is { IsDefaultOrEmpty: false } && covering[0].Scope.Length > covering[1].Scope.Length)
            {
                work = covering[0].Work;
                scopeIds = covering[0].Scope;
                confident = true;
            }
        }
        return new(confident, work, scopeIds, kind == WorkKind.Film,
            confident && work is not null ? Summary(work, scopeIds) : null,
            confident ? [] : choices, parsed);
    }

    private ParsedRelease ParseIdentity(string? displayName, ImmutableArray<TorrentFile>? files)
    {
        var parsed = TryParse(displayName);
        if (!string.IsNullOrWhiteSpace(parsed.Title)) return parsed;
        var root = MetadataRoot(files);
        parsed = TryParse(root);
        if (!string.IsNullOrWhiteSpace(parsed.Title)) return parsed;
        var largest = files is { } list ? list.Where(IsVideo).OrderByDescending(f => f.Bytes)
            .ThenBy(f => f.Index).FirstOrDefault() : null;
        parsed = TryParse(largest?.RelativePath);
        return parsed;
    }

    private ParsedRelease TryParse(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) name = "";
        try { return parser.Parse(name); }
        catch (ArgumentException)
        {
            return parser.Parse("");
        }
    }

    private ImmutableArray<string> Scope(WorkSnapshot work, ParsedRelease parsed,
        ImmutableArray<TorrentFile>? files)
    {
        if (work.Work.Kind == WorkKind.Film) return [];
        PlanFileMetadata? fileMetadata = null;
        if (files is { } list && !list.IsDefaultOrEmpty)
        {
            var parsedFiles = list.DistinctBy(f => f.Index).ToImmutableDictionary(f => f.Index,
                f => ParseLeaf(f.RelativePath));
            var parsedDirectories = list.DistinctBy(f => f.Index).ToImmutableDictionary(f => f.Index, f =>
            {
                var path = f.RelativePath.Replace('\\', '/');
                var slash = path.LastIndexOf('/');
                return TryParse(slash < 0 ? "" : path[..slash]);
            });
            fileMetadata = new(parsed.RawName, null, parsedFiles)
                { ParsedDirectories = parsedDirectories };
        }
        return ReleasePlanner.ExternalEpisodeScope(work, parsed, files, fileMetadata, DateTimeOffset.UtcNow);
    }

    private string Summary(WorkSnapshot work, ImmutableArray<string> episodeIds)
    {
        var title = work.Names.OrderBy(n => n.Ordinal).FirstOrDefault(n => n.Label == NameLabel.English)?.Value
            ?? work.Names.OrderBy(n => n.Ordinal).FirstOrDefault()?.Value ?? work.Work.WorkKey;
        if (work.Work.Kind == WorkKind.Film) return work.Work.Year is { } year ? $"{title} ({year})" : title;
        var episodes = work.Episodes.Where(e => episodeIds.Contains(e.Id, StringComparer.Ordinal)).ToArray();
        var seasons = work.Seasons.Where(s => episodes.Any(e => e.SeasonId == s.Id))
            .OrderBy(s => s.Number).ToArray();
        var label = seasons.Length == 1 ? $"season {seasons[0].Number}" : "series";
        return $"{title} {label} ({episodes.Length} {(episodes.Length == 1 ? "episode" : "episodes")})";
    }

    private static ExternalWorkChoice ToChoice(WorkSnapshot work)
    {
        var title = work.Names.OrderBy(n => n.Ordinal).FirstOrDefault(n => n.Label == NameLabel.English)?.Value
            ?? work.Names.OrderBy(n => n.Ordinal).FirstOrDefault()?.Value ?? work.Work.WorkKey;
        return new(work.Work.WorkKey, title, work.Work.Year,
            work.Work.Kind == WorkKind.Series ? "series" : "film", work.Work.PosterUrl);
    }

    private static bool HasCoordinates(ParsedRelease release) =>
        !release.Seasons.IsEmpty || !release.Episodes.IsEmpty || !release.AbsoluteNumbers.IsEmpty ||
        !release.Ranges.IsEmpty || !release.EpisodeRanges.IsEmpty || !release.AbsoluteRanges.IsEmpty ||
        release.Kind is ReleaseKind.SeasonPack or ReleaseKind.MultiSeason or ReleaseKind.CompleteSeries;

    private static bool IsVideo(TorrentFile file) => MediaImport.IsVideo(file.RelativePath);

    private ParsedRelease ParseLeaf(string path) =>
        TryParse(path.Replace('\\', '/').Split('/').LastOrDefault() ?? "");

    private static string MetadataRoot(ImmutableArray<TorrentFile>? files)
    {
        if (files is not { } list || list.IsDefaultOrEmpty) return "";
        var paths = list.Select(f => f.RelativePath.Replace('\\', '/').Split('/',
            StringSplitOptions.RemoveEmptyEntries)).ToArray();
        if (paths.Length == 0 || paths.Any(parts => parts.Length < 2)) return "";
        var roots = paths.Select(parts => parts[0])
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        return roots.Length == 1 ? roots[0] : "";
    }

    private static async Task<T?> WithTimeout<T>(Func<CancellationToken, Task<T>> action,
        CancellationToken ct) where T : class
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(20));
        try { return await action(deadline.Token).WaitAsync(deadline.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return null; }
        catch (Exception ex) when (ex is HttpRequestException or IOException) { return null; }
    }
}
