using System.Collections.Immutable;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed partial class MediaImport
{
    public async Task ScanFilesAsync(string id, string path, IEnumerable<string> files,
        Action<ImportScanView> report, CancellationToken ct)
    {
        var paths = files.Where(IsVideo).Distinct(
            OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal).Take(10001).ToArray();
        if (paths.Length > 10000) throw new IOException("This folder has more than 10,000 videos. Scan a smaller folder.");
        var tracked = await inventory.MediaAsync(null, ct);
        var items = ImmutableArray.CreateBuilder<ImportReviewItem>();
        var matches = new Dictionary<string, MetadataResult>();
        var searches = new Dictionary<string, CatalogResult>();
        report(new(id, path, "scanning", paths.Length, 0, [], null));
        foreach (var file in paths)
        {
            ct.ThrowIfCancellationRequested();
            LibraryPaths.NoLinks(file);
            if (!LibraryPaths.IsInside(path, file)) throw new IOException("The file is outside its original download folder.");
            var info = new FileInfo(file);
            var exists = info.Exists;
            var evidence = ReadEvidence(path, file) with
            {
                Details = exists
                    ? await DetailsAsync(file, ct)
                    : new ImportMediaDetails(null, null, null, "This file has not finished downloading.")
            };
            var nameCandidates = new List<NameCandidate>(evidence.Names.Length);
            foreach (var name in evidence.Names)
            {
                var key = name.Title + ":" + name.Year + ":" + evidence.Kind;
                if (!matches.TryGetValue(key, out var answer))
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    timeout.CancelAfter(TimeSpan.FromSeconds(20));
                    try { answer = await metadata.ResolveAsync(new(null, name.Title, name.Year, evidence.Kind), timeout.Token); }
                    catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                    { answer = new(null, new("CatalogUnavailable", "The catalog did not answer. Choose a title or scan again.", null, false), false, false); }
                    matches[key] = answer;
                }
                nameCandidates.Add(new(name, answer, null, []));
            }

            var decision = Match(evidence, [.. nameCandidates]);
            if (decision.SearchTitle is { } searchTitle && decision.SelectedIndex is { } selectedIndex)
            {
                var selected = nameCandidates[selectedIndex];
                var found = await SearchAsync(searchTitle, evidence.Kind, searches, ct);
                var exact = found.Works.Where(w => w.Work.Kind == evidence.Kind &&
                    w.Names.Any(n => SameName(n.Value, searchTitle))).ToArray();
                var supplemental = evidence.Year is null && selected.Answer.Work is not null
                    ? exact
                    : exact.Length > 0 ? exact : found.Works.Take(6).ToArray();
                var fullWorks = ImmutableArray.CreateBuilder<WorkSnapshot>();
                foreach (var candidate in supplemental)
                    if (await FullWorkAsync(candidate, ct) is { } full) fullWorks.Add(full);
                nameCandidates[selectedIndex] = selected with { Search = found, SearchWorks = fullWorks.ToImmutable() };
                decision = Match(evidence, [.. nameCandidates]);
            }

            var candidates = decision.Candidates;
            var chosen = candidates.Length == 1 && !decision.Guessed ? candidates[0] : null;
            var already = tracked.Any(m => m.PhysicalKey == LibraryPaths.PhysicalKey(file));
            if (!already && chosen is not null)
                already = !(await placement.OwnedAsync(new(chosen.WorkId,
                    chosen.EpisodeId is null ? [] : [chosen.EpisodeId], !evidence.Series), ct)).IsEmpty;
            var stem = Path.GetFileNameWithoutExtension(file);
            var directory = Path.GetDirectoryName(file)!;
            var sidecars = Directory.Exists(directory)
                ? Directory.EnumerateFiles(directory)
                    .Where(p => Subtitles.Contains(Path.GetExtension(p)) &&
                        (Path.GetFileNameWithoutExtension(p).Equals(stem, StringComparison.OrdinalIgnoreCase) ||
                         Path.GetFileNameWithoutExtension(p).StartsWith(stem + ".", StringComparison.OrdinalIgnoreCase)))
                    .Select(p => { LibraryPaths.NoLinks(p); var sidecar = new FileInfo(p); return new ImportSidecar(p, sidecar.Length, sidecar.LastWriteTimeUtc); })
                    .ToImmutableArray()
                : [];
            items.Add(new(Guid.NewGuid().ToString("N"), file, exists ? info.Length : 0,
                exists ? info.LastWriteTimeUtc : DateTimeOffset.UnixEpoch, evidence.Parsed,
                evidence.Parents, candidates.IsEmpty ? ImportConfidence.Unmatched :
                    decision.Confident ? ImportConfidence.Confident : ImportConfidence.NeedsPick,
                candidates, sidecars, already,
                decision.ReviewReason ?? Reason(already, candidates, evidence, decision)));
            report(new(id, path, "scanning", paths.Length, items.Count, items.ToImmutable(), null));
        }
        report(new(id, path, "complete", paths.Length, items.Count, items.ToImmutable(), null));
    }

    private ScanEvidence ReadEvidence(string path, string file)
    {
        var parsed = parser.Parse(Path.GetFileNameWithoutExtension(file)) with { RawName = Path.GetFileName(file) };
        var parents = ImmutableArray.CreateBuilder<ParsedRelease>();
        var parent = Path.GetDirectoryName(file);
        for (var depth = 0; depth < 4 && parent is not null && LibraryPaths.IsInside(path, file); depth++)
        {
            if (parent.Equals(path, StringComparison.OrdinalIgnoreCase)) break;
            parents.Add(parser.Parse(Path.GetFileName(parent)));
            parent = Path.GetDirectoryName(parent);
        }
        var bare = Regex.Match(Path.GetFileNameWithoutExtension(file), @"^(?:E)?(\d{1,4})$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
        var folderSeason = parents.FirstOrDefault(p => !p.Seasons.IsEmpty);
        if (bare.Success && folderSeason is not null && !parents.Any(TitleEvidence))
        {
            var rootTitle = parser.Parse(Path.GetFileName(path.TrimEnd(Path.DirectorySeparatorChar)));
            if (TitleEvidence(rootTitle)) parents.Add(rootTitle);
        }
        if (bare.Success && folderSeason is not null && parents.Any(TitleEvidence) &&
            int.TryParse(bare.Groups[1].Value, out var number) && number > 0)
            parsed = parsed with { Title = "", Seasons = folderSeason.Seasons, Episodes = [number],
                AbsoluteNumbers = [], Kind = ReleaseKind.Episode };
        var series = !parsed.Episodes.IsEmpty || !parsed.AbsoluteNumbers.IsEmpty;
        var parentEvidence = parents.ToImmutable();
        var names = new[] { parsed }.Concat(parentEvidence).Where(TitleEvidence).ToImmutableArray();
        return new(parsed, parentEvidence, names, series,
            series ? WorkKind.Series : WorkKind.Film,
            parsed.Year ?? parentEvidence.FirstOrDefault(p => p.Year is not null)?.Year);
    }

    private static MatchDecision Match(ScanEvidence evidence, ImmutableArray<NameCandidate> candidates)
    {
        MetadataResult? match = null;
        var matchedIndex = -1;
        for (var i = 0; i < candidates.Length; i++)
        {
            var answer = candidates[i].Answer;
            if (match?.Work is null && (answer.Work is not null || match is null ||
                answer.Failure?.Code == "ambiguous" && match.Failure?.Code != "ambiguous"))
            {
                match = answer;
                matchedIndex = i;
            }
        }

        var searchTitle = matchedIndex >= 0 &&
            (match?.Work is not null && evidence.Year is null || match?.Failure?.Code == "ambiguous")
                ? candidates[matchedIndex].Name.Title : null;
        var found = matchedIndex >= 0 ? candidates[matchedIndex].Search : null;
        var nameCandidates = ImmutableArray.CreateBuilder<ImportCandidate>();
        var confident = false;
        var guessed = false;
        string? reviewReason = null;
        if (match?.Work is { } work)
        {
            nameCandidates.AddRange(Candidates(work, evidence.Parsed, evidence.Parents));
            if (evidence.Series && nameCandidates is [{ EpisodeId: null }])
            {
                nameCandidates.Clear();
                nameCandidates.AddRange(Candidates(work, evidence.Parsed, evidence.Parents, true));
                guessed = true;
            }
            confident = !guessed && nameCandidates.Count == 1 &&
                (!evidence.Series || nameCandidates[0].EpisodeId is not null) && match.Complete &&
                work.Names.Any(n => evidence.Names.Any(p => p.Title.Trim().Equals(n.Value.Trim(), StringComparison.OrdinalIgnoreCase))) &&
                evidence.Parsed.Episodes.Length <= 1 && evidence.Parsed.AbsoluteNumbers.Length <= 1 &&
                !evidence.Parsed.Unsafe && !evidence.Parsed.Sample;
            if (evidence.Year is null)
            {
                var exact = found?.Works.Where(w => w.Work.Kind == evidence.Kind &&
                    w.Names.Any(n => SameName(n.Value, candidates[matchedIndex].Name.Title)))
                    .DistinctBy(w => w.Work.WorkKey).ToArray() ?? [];
                var fullExact = candidates[matchedIndex].SearchWorks
                    .Where(w => exact.Any(e => e.Work.WorkKey == w.Work.WorkKey)).ToArray();
                var unique = exact.Length == 1 ? fullExact.FirstOrDefault() : null;
                if (unique?.Work.Id != work.Work.Id || found is null || found.Partial || found.Stale)
                {
                    confident = false;
                    reviewReason = exact.Length > 1 ? "Several titles have this name. Pick the right one." :
                        "The catalog could not confirm a unique title without a year. Pick the right one.";
                    foreach (var alternate in fullExact)
                        nameCandidates.AddRange(Candidates(alternate, evidence.Parsed, evidence.Parents));
                }
            }
            if (candidates.Any(a => !work.Names.Any(n => SameName(n.Value, a.Name.Title)) ||
                a.Name.Year is { } nameYear && work.Work.Year != nameYear ||
                a.Answer.Work is { } other && other.Work.Id != work.Work.Id))
            {
                confident = false;
                reviewReason = "The file name and folder name disagree. Pick the right title.";
                foreach (var other in candidates.Select(a => a.Answer.Work).OfType<WorkSnapshot>())
                    nameCandidates.AddRange(Candidates(other, evidence.Parsed, evidence.Parents));
            }
            var expected = evidence.Series
                ? work.Episodes.FirstOrDefault(e => e.Id == nameCandidates.FirstOrDefault()?.EpisodeId)?.RuntimeMinutes
                : work.Work.RuntimeMinutes;
            if (evidence.Details?.RuntimeSeconds is not { } seconds)
            { confident = false; reviewReason ??= evidence.Details?.Error; }
            else if (expected is not > 0)
            { confident = false; reviewReason ??= "The catalog has no runtime to check. Pick the right title."; }
            else if (Math.Abs(seconds / 60 - expected.Value) >
                (evidence.Series ? expected.Value * .5 : Math.Max(expected.Value * .25, 20)))
            { confident = false; reviewReason ??= "The file runtime does not fit this title. Pick the right title."; }
        }
        else if (match?.Failure?.Code == "ambiguous" && found is not null)
        {
            var exact = found.Works.Where(w => w.Work.Kind == evidence.Kind &&
                w.Names.Any(n => SameName(n.Value, candidates[matchedIndex].Name.Title))).ToArray();
            var options = exact.Length > 0 ? exact : found.Works.ToArray();
            foreach (var option in options.Take(6))
                if (candidates[matchedIndex].SearchWorks.FirstOrDefault(w => w.Work.WorkKey == option.Work.WorkKey) is { } full)
                    nameCandidates.AddRange(Candidates(full, evidence.Parsed, evidence.Parents));
        }
        var uniqueCandidates = nameCandidates.DistinctBy(c => (c.WorkId, c.EpisodeId)).ToImmutableArray();
        return new(uniqueCandidates, uniqueCandidates.Length == 1 && !guessed ? uniqueCandidates[0] : null,
            confident, guessed, reviewReason, matchedIndex, searchTitle, match);
    }

    private static bool SameName(string left, string right) =>
        left.Trim().Equals(right.Trim(), StringComparison.OrdinalIgnoreCase);

    private static bool TitleEvidence(ParsedRelease parsed) => !string.IsNullOrWhiteSpace(parsed.Title) &&
        !new[] { "Movies", "Films", "TV", "Anime", "Anime Movies", "Incoming", "Downloads" }
            .Contains(parsed.Title.Trim(), StringComparer.OrdinalIgnoreCase);

    private async Task<CatalogResult> SearchAsync(string title, WorkKind kind,
        Dictionary<string, CatalogResult> cache, CancellationToken ct)
    {
        var key = title + ":" + kind;
        if (cache.TryGetValue(key, out var result)) return result;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        try { result = await metadata.SearchAsync(new(title, kind == WorkKind.Series ? "series" : "films", 100), timeout.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { result = new([], true, false, []); }
        cache[key] = result;
        return result;
    }

    private async Task<WorkSnapshot?> FullWorkAsync(WorkSnapshot candidate, CancellationToken ct) =>
        (await metadata.GetWorkAsync(candidate.Work.WorkKey, false, ct)).Work;

    private static ImmutableArray<ImportCandidate> Candidates(WorkSnapshot work, ParsedRelease parsed,
        ImmutableArray<ParsedRelease> parents, bool guesses = false)
    {
        var title = work.Names.FirstOrDefault(n => n.Label == NameLabel.English)?.Value ??
            work.Names.FirstOrDefault()?.Value ?? work.Work.WorkKey;
        if (work.Work.Kind == WorkKind.Film)
            return [new(work.Work.Id, title, work.Work.Year, WorkKind.Film, null, null, null, work.Work.WorkKey)];
        var seasons = parsed.Seasons.IsEmpty ? parents.FirstOrDefault(p => !p.Seasons.IsEmpty)?.Seasons ?? [] : parsed.Seasons;
        var episodes = work.Episodes.Where(e => e.MappingStatus == MappingStatus.Confirmed &&
            (parsed.AbsoluteNumbers.Contains(e.AbsoluteNumber ?? -1) ||
             parsed.Episodes.Contains(e.Number) && work.Seasons.Any(s => s.Id == e.SeasonId &&
                 s.MappingStatus == MappingStatus.Confirmed && seasons.Contains(s.Number)))).ToArray();
        if (episodes.Length == 0 && guesses)
        {
            var seasonIds = work.Seasons.Where(s => s.MappingStatus == MappingStatus.Confirmed &&
                (seasons.IsEmpty || seasons.Contains(s.Number))).Select(s => s.Id).ToHashSet();
            episodes = [.. work.Episodes.Where(e => e.MappingStatus == MappingStatus.Confirmed && seasonIds.Contains(e.SeasonId))
                .OrderBy(e => work.Seasons.Single(s => s.Id == e.SeasonId).Number).ThenBy(e => e.Number).Take(200)];
        }
        return episodes.Length == 0
            ? [new(work.Work.Id, title, work.Work.Year, WorkKind.Series, null, null, null, work.Work.WorkKey)]
            : [.. episodes.Select(e => new ImportCandidate(work.Work.Id, title, work.Work.Year, WorkKind.Series,
                e.Id, work.Seasons.Single(s => s.Id == e.SeasonId).Number, e.Number, work.Work.WorkKey))];
    }

    private static string Reason(bool already, ImmutableArray<ImportCandidate> candidates,
        ScanEvidence evidence, MatchDecision match)
    {
        if (already) return "Already in your library";
        if (candidates.IsEmpty)
            return match.Metadata?.Failure?.Code == "CatalogUnavailable" ? "The catalog did not answer. Scan again later"
                : "No title matched this name";
        var first = candidates[0];
        var label = first.Year is null ? first.Title : $"{first.Title} ({first.Year})";
        if (match.Confident)
            return first.EpisodeId is null ? $"Matched {label}" : $"Matched {first.Title}, season {first.Season} episode {first.Episode}";
        var works = candidates.Select(c => c.WorkId).Distinct().Count();
        if (works > 1) return candidates.All(c => c.Kind == WorkKind.Film)
            ? "Several films match this name" : $"{works} titles match this name";
        if (evidence.Parsed.Episodes.Length > 1 || evidence.Parsed.AbsoluteNumbers.Length > 1)
            return "This file holds several episodes";
        if (evidence.Parsed.Sample) return "This looks like a sample clip";
        if (match.Guessed)
        {
            var season = evidence.Parsed.Seasons.IsEmpty
                ? evidence.Parents.FirstOrDefault(p => !p.Seasons.IsEmpty)?.Seasons ?? []
                : evidence.Parsed.Seasons;
            if (candidates.All(c => c.Season == candidates[0].Season) && candidates[0].Season is { } number &&
                (season.IsEmpty || season.Contains(number))) return $"Season {number} has {candidates.Length} episodes";
            return evidence.Parsed.Episodes.IsEmpty && evidence.Parsed.AbsoluteNumbers.IsEmpty
                ? "No episode number in this name" : "That episode is not in the catalog";
        }
        return $"The name only partly matches {label}";
    }

    private sealed record ScanEvidence(ParsedRelease Parsed, ImmutableArray<ParsedRelease> Parents,
        ImmutableArray<ParsedRelease> Names, bool Series, WorkKind Kind, int? Year,
        ImportMediaDetails? Details = null);
    private sealed record NameCandidate(ParsedRelease Name, MetadataResult Answer, CatalogResult? Search,
        ImmutableArray<WorkSnapshot> SearchWorks);
    private sealed record MatchDecision(ImmutableArray<ImportCandidate> Candidates, ImportCandidate? Match,
        bool Confident, bool Guessed, string? ReviewReason, int? SelectedIndex, string? SearchTitle,
        MetadataResult? Metadata);
}
