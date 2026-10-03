using System.Collections.Immutable;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed class MediaImport(IParser parser, IMetadata metadata, ILibraryPlacement placement,
    ILibraryRepository inventory)
{
    private readonly Dictionary<string, (long Bytes, DateTime Mtime, ImportMediaDetails Details)> mediaDetails = [];
    private static readonly HashSet<string> Videos = new(StringComparer.OrdinalIgnoreCase)
        { ".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm", ".mpg", ".mpeg", ".ts", ".m2ts", ".wmv" };
    private static readonly HashSet<string> Subtitles = new(StringComparer.OrdinalIgnoreCase)
        { ".srt", ".ass", ".ssa", ".vtt", ".sub", ".idx" };

    public static bool IsVideo(string path) => Videos.Contains(Path.GetExtension(path));

    public static string ValidateFolder(string path)
    {
        if (!Path.IsPathFullyQualified(path)) throw new ArgumentException("Choose an absolute folder path.");
        path = Path.GetFullPath(path);
        LibraryPaths.NoLinks(path);
        if (!Directory.Exists(path)) throw new IOException("This folder is unavailable. Reconnect the drive or choose another folder.");
        return path;
    }

    private static IEnumerable<string> Walk(string path)
    {
        LibraryPaths.NoLinks(path);
        foreach (var file in Directory.EnumerateFiles(path))
        {
            LibraryPaths.NoLinks(file);
            yield return file;
        }

        foreach (var folder in Directory.EnumerateDirectories(path))
        {
            if ((File.GetAttributes(folder) & FileAttributes.ReparsePoint) != 0) continue;
            foreach (var file in Walk(folder)) yield return file;
        }
    }

    public async Task<ImportScanView> AdoptAsync(ImportScanView scan, ImportReviews reviews, CancellationToken ct,
        MediaOrigin origin = MediaOrigin.Imported)
    {
        var tracked = await inventory.MediaAsync(null, ct);
        var roots = await placement.RootsAsync(ct);
        foreach (var item in scan.Items)
        {
            var physical = LibraryPaths.PhysicalKey(item.Path);
            if (tracked.Any(m => m.PhysicalKey == physical))
            {
                await reviews.DecideAsync(scan.Id, item.Id, "already-owned", ct);
                continue;
            }
            if (item.Group != ImportConfidence.Confident || item.Candidates.Length != 1) continue;
            LibraryPaths.NoLinks(item.Path);
            var info = new FileInfo(item.Path);
            if (!info.Exists || info.Length != item.Bytes || info.LastWriteTimeUtc != item.MtimeUtc.UtcDateTime)
                continue;
            var pick = item.Candidates[0];
            var root = roots.Where(r => LibraryPaths.IsInside(r.Path, item.Path))
                .OrderByDescending(r => r.Path.Length).FirstOrDefault();
            var now = DateTimeOffset.UtcNow;
            var quality = item.Parsed.Quality;
            var details = await DetailsAsync(item.Path, ct);
            var file = new MediaFileRow("adopted:" + physical, pick.WorkId, pick.EpisodeId, root?.Id,
                item.Path, physical, FileRole.Video, null, item.Bytes, item.MtimeUtc,
                VideoDimensions.Resolution(details.Width, details.Height) ??
                    quality.Resolution ?? item.Parents.Select(p => p.Quality.Resolution).FirstOrDefault(r => r is not null),
                quality.Source, Path.GetExtension(item.Path).TrimStart('.'), quality.Codec, null, details.Width, details.Height,
                null, details.RuntimeSeconds, null, [], origin, null, null, now, now, null,
                FilePresence.Present, null, null, null, 1);
            if (await placement.RecordAsync(file, null, ct) is null)
                await reviews.DecideAsync(scan.Id, item.Id, "adopted", ct);
        }
        await reviews.SaveAsync(scan with { State = "complete" }, ct);
        return (await reviews.GetAsync(scan.Id, ct))!;
    }
    public Task ScanAsync(string id, string path, Action<ImportScanView> report, CancellationToken ct) =>
        ScanFilesAsync(id, path, Walk(path), report, ct);

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
            var kind = series ? WorkKind.Series : WorkKind.Film;
            var evidence = new[] { parsed }.Concat(parents).Where(TitleEvidence).ToArray();
            MetadataResult? match = null;
            var matchedName = parsed;
            var year = parsed.Year ?? parents.FirstOrDefault(p => p.Year is not null)?.Year;
            var answers = new List<(ParsedRelease Name, MetadataResult Answer)>();
            foreach (var name in evidence)
            {
                var nameYear = name.Year;
                var key = name.Title + ":" + nameYear + ":" + kind;
                if (!matches.TryGetValue(key, out var answer))
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    timeout.CancelAfter(TimeSpan.FromSeconds(20));
                    try { answer = await metadata.ResolveAsync(new(null, name.Title, nameYear, kind), timeout.Token); }
                    catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                    { answer = new(null, new("CatalogUnavailable", "The catalog did not answer. Choose a title or scan again.", null, false), false, false); }
                    matches[key] = answer;
                }
                answers.Add((name, answer));
                if (match?.Work is null && (answer.Work is not null || match is null ||
                    answer.Failure?.Code == "ambiguous" && match.Failure?.Code != "ambiguous"))
                { match = answer; matchedName = name; }
            }
            var candidates = ImmutableArray.CreateBuilder<ImportCandidate>();
            var confident = false;
            var guessed = false;
            string? reviewReason = null;
            var details = await DetailsAsync(file, ct);
            if (match?.Work is { } work)
            {
                candidates.AddRange(Candidates(work, parsed, parents.ToImmutable()));
                if (series && candidates is [{ EpisodeId: null }])
                {
                    candidates.Clear();
                    candidates.AddRange(Candidates(work, parsed, parents.ToImmutable(), true));
                    guessed = true;
                }
                confident = !guessed && candidates.Count == 1 && (!series || candidates[0].EpisodeId is not null) && match.Complete &&
                    work.Names.Any(n => evidence.Any(p => p.Title.Trim().Equals(n.Value.Trim(), StringComparison.OrdinalIgnoreCase))) &&
                    parsed.Episodes.Length <= 1 && parsed.AbsoluteNumbers.Length <= 1 && !parsed.Unsafe && !parsed.Sample;
                if (year is null)
                {
                    var found = await SearchAsync(matchedName.Title, kind, searches, ct);
                    var exact = found.Works.Where(w => w.Work.Kind == kind &&
                        w.Names.Any(n => SameName(n.Value, matchedName.Title))).DistinctBy(w => w.Work.WorkKey).ToArray();
                    var unique = exact.Length == 1 ? await FullWorkAsync(exact[0], ct) : null;
                    if (unique?.Work.Id != work.Work.Id || found.Partial || found.Stale)
                    {
                        confident = false;
                        reviewReason = exact.Length > 1 ? "Several titles have this name. Pick the right one." :
                            "The catalog could not confirm a unique title without a year. Pick the right one.";
                        foreach (var alternate in exact)
                            if (await FullWorkAsync(alternate, ct) is { } full)
                                candidates.AddRange(Candidates(full, parsed, parents.ToImmutable()));
                    }
                }
                if (answers.Any(a => !work.Names.Any(n => SameName(n.Value, a.Name.Title)) ||
                    a.Name.Year is { } nameYear && work.Work.Year != nameYear ||
                    a.Answer.Work is { } other && other.Work.Id != work.Work.Id))
                {
                    confident = false;
                    reviewReason = "The file name and folder name disagree. Pick the right title.";
                    foreach (var other in answers.Select(a => a.Answer.Work).OfType<WorkSnapshot>())
                        candidates.AddRange(Candidates(other, parsed, parents.ToImmutable()));
                }
                var expected = series ? work.Episodes.FirstOrDefault(e => e.Id == candidates.FirstOrDefault()?.EpisodeId)?.RuntimeMinutes :
                    work.Work.RuntimeMinutes;
                if (details.RuntimeSeconds is not { } seconds)
                { confident = false; reviewReason ??= details.Error; }
                else if (expected is not > 0)
                { confident = false; reviewReason ??= "The catalog has no runtime to check. Pick the right title."; }
                else if (Math.Abs(seconds / 60 - expected.Value) >
                    (series ? expected.Value * .5 : Math.Max(expected.Value * .25, 20)))
                { confident = false; reviewReason ??= "The file runtime does not fit this title. Pick the right title."; }
            }
            else if (match?.Failure?.Code == "ambiguous")
            {
                var found = await SearchAsync(matchedName.Title, kind, searches, ct);
                var exact = found.Works.Where(w => w.Work.Kind == kind &&
                    w.Names.Any(n => SameName(n.Value, matchedName.Title))).ToArray();
                foreach (var workCandidate in (exact.Length > 0 ? exact : found.Works.ToArray()).Take(6))
                    if (await FullWorkAsync(workCandidate, ct) is { } full)
                        candidates.AddRange(Candidates(full, parsed, parents.ToImmutable()));
            }
            var uniqueCandidates = candidates.DistinctBy(c => (c.WorkId, c.EpisodeId)).ToImmutableArray();
            candidates.Clear();
            candidates.AddRange(uniqueCandidates);
            var chosen = candidates.Count == 1 && !guessed ? candidates[0] : null;
            var already = tracked.Any(m => m.PhysicalKey == LibraryPaths.PhysicalKey(file));
            if (!already && chosen is not null)
                already = !(await placement.OwnedAsync(new(chosen.WorkId,
                    chosen.EpisodeId is null ? [] : [chosen.EpisodeId], !series), ct)).IsEmpty;
            var stem = Path.GetFileNameWithoutExtension(file);
            var sidecars = Directory.EnumerateFiles(Path.GetDirectoryName(file)!)
                .Where(p => Subtitles.Contains(Path.GetExtension(p)) &&
                    (Path.GetFileNameWithoutExtension(p).Equals(stem, StringComparison.OrdinalIgnoreCase) ||
                     Path.GetFileNameWithoutExtension(p).StartsWith(stem + ".", StringComparison.OrdinalIgnoreCase)))
                .Select(p => { LibraryPaths.NoLinks(p); var s = new FileInfo(p); return new ImportSidecar(p, s.Length, s.LastWriteTimeUtc); })
                .ToImmutableArray();
            items.Add(new(Guid.NewGuid().ToString("N"), file, info.Length, info.LastWriteTimeUtc, parsed,
                parents.ToImmutable(), candidates.Count == 0 ? ImportConfidence.Unmatched :
                    confident ? ImportConfidence.Confident : ImportConfidence.NeedsPick,
                candidates.ToImmutable(), sidecars, already,
                reviewReason ?? Reason(already, candidates.ToImmutable(), parsed, parents.ToImmutable(), match, confident, guessed)));
            report(new(id, path, "scanning", paths.Length, items.Count, items.ToImmutable(), null));
        }

        report(new(id, path, "complete", paths.Length, items.Count, items.ToImmutable(), null));
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

    private async Task<ImportMediaDetails> DetailsAsync(string path, CancellationToken ct)
    {
        var file = new FileInfo(path);
        if (mediaDetails.TryGetValue(path, out var cached) && cached.Bytes == file.Length && cached.Mtime == file.LastWriteTimeUtc)
            return cached.Details;
        var details = await ImportMediaDetails.ReadAsync(path, ct);
        mediaDetails[path] = (file.Length, file.LastWriteTimeUtc, details);
        return details;
    }

    // One short, plain reason per review item, shown as is on the review screen.
    private static string Reason(bool already, ImmutableArray<ImportCandidate> candidates, ParsedRelease parsed,
        ImmutableArray<ParsedRelease> parents, MetadataResult? match, bool confident, bool guessed)
    {
        if (already) return "Already in your library";
        if (candidates.IsEmpty)
            return match?.Failure?.Code == "CatalogUnavailable" ? "The catalog did not answer. Scan again later"
                : "No title matched this name";
        var first = candidates[0];
        var label = first.Year is null ? first.Title : $"{first.Title} ({first.Year})";
        if (confident)
            return first.EpisodeId is null ? $"Matched {label}" : $"Matched {first.Title}, season {first.Season} episode {first.Episode}";
        var works = candidates.Select(c => c.WorkId).Distinct().Count();
        if (works > 1) return candidates.All(c => c.Kind == WorkKind.Film)
            ? "Several films match this name" : $"{works} titles match this name";
        if (parsed.Episodes.Length > 1 || parsed.AbsoluteNumbers.Length > 1) return "This file holds several episodes";
        if (parsed.Sample) return "This looks like a sample clip";
        if (guessed)
        {
            var season = parsed.Seasons.IsEmpty ? parents.FirstOrDefault(p => !p.Seasons.IsEmpty)?.Seasons ?? [] : parsed.Seasons;
            if (candidates.All(c => c.Season == candidates[0].Season) && candidates[0].Season is { } number &&
                (season.IsEmpty || season.Contains(number)))
                return $"Season {number} has {candidates.Length} episodes";
            return parsed.Episodes.IsEmpty && parsed.AbsoluteNumbers.IsEmpty
                ? "No episode number in this name" : "That episode is not in the catalog";
        }
        return $"The name only partly matches {label}";
    }

    private static ImmutableArray<ImportCandidate> Candidates(WorkSnapshot work, ParsedRelease parsed,
        ImmutableArray<ParsedRelease> parents, bool guesses = false)
    {
        var title = work.Names.FirstOrDefault(n => n.Label == NameLabel.English)?.Value ??
            work.Names.FirstOrDefault()?.Value ?? work.Work.WorkKey;
        if (work.Work.Kind == WorkKind.Film) return [new(work.Work.Id, title, work.Work.Year, WorkKind.Film,
            null, null, null, work.Work.WorkKey)];
        var seasons = parsed.Seasons.IsEmpty ? parents.FirstOrDefault(p => !p.Seasons.IsEmpty)?.Seasons ?? [] : parsed.Seasons;
        var episodes = work.Episodes.Where(e => e.MappingStatus == MappingStatus.Confirmed &&
            (parsed.AbsoluteNumbers.Contains(e.AbsoluteNumber ?? -1) ||
             parsed.Episodes.Contains(e.Number) && work.Seasons.Any(s => s.Id == e.SeasonId &&
                 s.MappingStatus == MappingStatus.Confirmed && seasons.Contains(s.Number)))).ToArray();
        if (episodes.Length == 0 && guesses)
        {
            // Offer the season's episodes (or the whole show) so the owner can pick the right one.
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

    public async Task<ImportConfirmResult> ConfirmAsync(ImportScanView scan, ImportConfirmInput input, CancellationToken ct)
    {
        if (scan.State != "complete") throw new ArgumentException("Wait for the scan to finish before confirming.");
        if (input.Items.IsDefaultOrEmpty ||
            input.Items.Any(i => i is null || string.IsNullOrWhiteSpace(i.ItemId) || string.IsNullOrWhiteSpace(i.WorkId)) ||
            input.Items.Select(i => i.ItemId).Distinct().Count() != input.Items.Length)
            throw new ArgumentException("Choose files once to import.");
        var resolved = new List<(ImportReviewItem Item, ImportSelection Pick)>();
        foreach (var pick in input.Items)
        {
            var item = scan.Items.SingleOrDefault(i => i.Id == pick.ItemId) ??
                throw new ArgumentException("A selected file is not in this scan. Scan the folder again.");
            var work = (await metadata.GetWorkAsync(pick.WorkId, false, ct)).Work ??
                throw new ArgumentException("Choose a title that is available in the catalog.");
            if (work.Work.Kind == WorkKind.Film ? pick.EpisodeId is not null :
                !work.Episodes.Any(e => e.Id == pick.EpisodeId && e.MappingStatus == MappingStatus.Confirmed))
                throw new ArgumentException("Choose the exact episode from the catalog.");
            resolved.Add((item, pick));
        }
        var results = ImmutableArray.CreateBuilder<ImportItemResult>();
        foreach (var (item, pick) in resolved)
        {
            try
            {
                Stable(new(item.Path, item.Bytes, item.MtimeUtc));
                ValidateVideo(item.Path);
                var physical = LibraryPaths.PhysicalKey(item.Path);
                var tracked = (await inventory.MediaAsync(null, ct)).SingleOrDefault(m => m.PhysicalKey == physical);
                if (tracked is not null)
                {
                    results.Add(new(item.Id, tracked.Path, false, null, true));
                    continue;
                }
                var scope = new TargetScope(pick.WorkId, pick.EpisodeId is null ? [] : [pick.EpisodeId],
                    pick.EpisodeId is null);
                if (!(await placement.OwnedAsync(scope, ct)).IsEmpty)
                {
                    results.Add(new(item.Id, item.Path, false, null, true));
                    continue;
                }
                var roots = await placement.RootsAsync(ct);
                var root = roots.Where(r => LibraryPaths.IsInside(r.Path, item.Path))
                    .OrderByDescending(r => r.Path.Length).FirstOrDefault();
                var details = await DetailsAsync(item.Path, ct);
                var quality = new Quality(item.Parsed.Quality.Resolution ??
                    item.Parents.Select(p => p.Quality.Resolution).FirstOrDefault(v => v is not null),
                    item.Parsed.Quality.Source ?? item.Parents.Select(p => p.Quality.Source).FirstOrDefault(v => v is not null),
                    item.Parsed.Quality.Codec ?? item.Parents.Select(p => p.Quality.Codec).FirstOrDefault(v => v is not null),
                    item.Parsed.Quality.Hdr ?? item.Parents.Select(p => p.Quality.Hdr).FirstOrDefault(v => v is not null));
                var now = DateTimeOffset.UtcNow;
                var media = new MediaFileRow("import:" + scan.Id + ":" + item.Id, pick.WorkId, pick.EpisodeId,
                    root?.Id, item.Path, physical, FileRole.Video, null, item.Bytes, item.MtimeUtc,
                    VideoDimensions.Resolution(details.Width, details.Height) ?? quality.Resolution,
                    quality.Source, Path.GetExtension(item.Path).TrimStart('.'), quality.Codec, null,
                    details.Width, details.Height, quality.Hdr, details.RuntimeSeconds, null, [],
                    MediaOrigin.Imported, null, null, now, now, null, FilePresence.Present, null, now, null, 1);
                var failure = await placement.RecordAsync(media, null, ct);
                results.Add(new(item.Id, failure is null ? item.Path : null, failure is null, failure?.Message));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            {
                results.Add(new(item.Id, null, false, ex.Message));
            }
        }
        return new(results.ToImmutable());
    }

    private static void Stable(ImportSidecar file)
    {
        LibraryPaths.NoLinks(file.Path);
        var actual = new FileInfo(file.Path);
        if (!actual.Exists || actual.Length != file.Bytes || actual.LastWriteTimeUtc != file.MtimeUtc.UtcDateTime)
            throw new IOException("A scanned file changed. Scan the folder again before importing.");
    }

    private static void ValidateVideo(string path)
    {
        using var stream = File.OpenRead(path);
        Span<byte> header = stackalloc byte[16];
        if (!VideoSignature.Recognized(header[..stream.Read(header)]))
            throw new IOException("This file is not a recognized video. Choose the actual video file.");
    }

    public async Task<ImportRescanResult> RescanAsync(string rootId, CancellationToken ct)
    {
        var checkedRoot = await placement.CheckRootAsync(rootId, ct);
        var root = checkedRoot.Root ?? throw new ArgumentException(checkedRoot.Failure?.Message);
        var files = (await inventory.MediaAsync(null, ct)).Where(m => m.RootId == rootId).ToArray();
        var now = DateTimeOffset.UtcNow;
        var updates = ImmutableArray.CreateBuilder<MediaFileRow>();
        var online = root.Online;
        HashSet<string> disk = [];
        if (online)
        {
            try { disk = Walk(root.Path).Select(LibraryPaths.PhysicalKey).ToHashSet(); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            { online = false; }
        }
        foreach (var file in files)
        {
            try
            {
                LibraryPaths.NoLinks(file.Path);
                var info = new FileInfo(file.Path);
                if (!online) updates.Add(file with { Status = FilePresence.Offline, Version = file.Version + 1 });
                else if (disk.Contains(file.PhysicalKey) && info.Exists && info.Length == file.Bytes)
                    updates.Add(file with { Status = FilePresence.Present, LastSeenAt = now,
                        MissingSince = null, MissingConfirmedAt = null, Version = file.Version + 1 });
                else updates.Add(file with { Status = FilePresence.Missing, MissingSince = file.MissingSince ?? now,
                    MissingConfirmedAt = file.MissingConfirmedAt ??
                        (file.MissingSince <= now.AddHours(-6) ? now : null), Version = file.Version + 1 });
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            { online = false; break; }
        }
        if (!online)
        {
            updates.Clear();
            updates.AddRange(files.Select(f => f with { Status = FilePresence.Offline, Version = f.Version + 1 }));
        }
        var updatedRoot = root with { Online = online, UpdatedAt = now, Version = root.Version + 1 };
        if (!await inventory.SaveRootCheckAsync(updatedRoot, root.Version, updates.ToImmutable(), ct))
            throw new IOException("The library changed during the scan. Scan the drive again.");
        var dropped = online ? await placement.PruneMissingAsync(now, ct) : 0;
        var remaining = (await inventory.MediaAsync(null, ct)).Where(m => m.RootId == rootId).ToArray();
        return new(rootId, online, remaining.Count(m => m.Status == FilePresence.Present),
            remaining.Count(m => m.Status == FilePresence.Offline), remaining.Count(m => m.Status == FilePresence.Missing),
            dropped, root.LastError);
    }
}
