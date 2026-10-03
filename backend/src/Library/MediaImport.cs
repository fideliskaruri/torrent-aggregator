using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed class MediaImport(IParser parser, IMetadata metadata, ILibraryPlacement placement,
    ILibraryRepository inventory, ILibraryImportRepository operations)
{
    private static readonly HashSet<string> Videos = new(StringComparer.OrdinalIgnoreCase)
        { ".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm", ".mpg", ".mpeg", ".ts", ".m2ts", ".wmv" };
    private static readonly HashSet<string> Subtitles = new(StringComparer.OrdinalIgnoreCase)
        { ".srt", ".ass", ".ssa", ".vtt", ".sub", ".idx" };

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

    public async Task ScanAsync(string id, string path, Action<ImportScanView> report, CancellationToken ct)
    {
        var paths = Walk(path).Where(p => Videos.Contains(Path.GetExtension(p))).Take(10001).ToArray();
        if (paths.Length > 10000) throw new IOException("This folder has more than 10,000 videos. Scan a smaller folder.");
        var tracked = await inventory.MediaAsync(null, ct);
        var items = ImmutableArray.CreateBuilder<ImportReviewItem>();
        var matches = new Dictionary<string, MetadataResult>();
        report(new(id, path, "scanning", paths.Length, 0, [], null));
        foreach (var file in paths)
        {
            ct.ThrowIfCancellationRequested();
            var info = new FileInfo(file);
            var parsed = parser.Parse(Path.GetFileName(file));
            var parents = ImmutableArray.CreateBuilder<ParsedRelease>();
            var parent = Path.GetDirectoryName(file);
            for (var depth = 0; depth < 4 && parent is not null && LibraryPaths.IsInside(path, file); depth++)
            {
                if (parent.Equals(path, StringComparison.OrdinalIgnoreCase)) break;
                parents.Add(parser.Parse(Path.GetFileName(parent)));
                parent = Path.GetDirectoryName(parent);
            }
            var series = !parsed.Episodes.IsEmpty || !parsed.AbsoluteNumbers.IsEmpty;
            var kind = series ? WorkKind.Series : WorkKind.Film;
            var evidence = new[] { parsed }.Concat(parents).Where(p => !string.IsNullOrWhiteSpace(p.Title)).ToArray();
            MetadataResult? match = null;
            var matchedName = parsed;
            var year = parsed.Year ?? parents.FirstOrDefault(p => p.Year is not null)?.Year;
            foreach (var name in evidence)
            {
                var key = name.Title + ":" + year + ":" + kind;
                if (!matches.TryGetValue(key, out var answer))
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    timeout.CancelAfter(TimeSpan.FromSeconds(20));
                    try { answer = await metadata.ResolveAsync(new(null, name.Title, year, kind), timeout.Token); }
                    catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                    { answer = new(null, new("CatalogUnavailable", "The catalog did not answer. Choose a title or scan again.", null, false), false, false); }
                    matches[key] = answer;
                }
                match = answer;
                matchedName = name;
                if (answer.Work is not null || answer.Failure?.Code == "ambiguous") break;
            }
            var candidates = ImmutableArray.CreateBuilder<ImportCandidate>();
            var confident = false;
            var guessed = false;
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
            }
            else if (match?.Failure?.Code == "ambiguous")
            {
                var found = await metadata.SearchAsync(new(matchedName.Title, series ? "series" : "films", 6), ct);
                foreach (var workCandidate in found.Works) candidates.AddRange(Candidates(workCandidate, parsed, parents.ToImmutable()));
            }
            var chosen = candidates.Count == 1 && !guessed ? candidates[0] : null;
            var duplicateKey = chosen is not null && (!series || chosen.EpisodeId is not null)
                ? chosen.WorkId + ":" + (chosen.EpisodeId ?? "film") : null;
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
                candidates.ToImmutable(), sidecars, already, duplicateKey,
                Reason(already, candidates.ToImmutable(), parsed, parents.ToImmutable(), match, confident, guessed)));
            report(new(id, path, "scanning", paths.Length, items.Count, items.ToImmutable(), null));
        }
        var duplicates = items.Where(i => i.DuplicateKey is not null).GroupBy(i => i.DuplicateKey)
            .Where(g => g.Count() > 1).Select(g => g.Key).ToHashSet();
        report(new(id, path, "complete", paths.Length, items.Count,
            [.. items.Select(i => duplicates.Contains(i.DuplicateKey) ? i with
                { Group = ImportConfidence.NeedsPick, Message = i.Candidates[0].EpisodeId is null
                    ? "Two files for the same film" : "Two files for the same episode" } : i)], null));
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
        if (works > 1) return $"{works} titles match this name";
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
        if (!Enum.IsDefined(input.Mode) || input.Items.IsDefaultOrEmpty ||
            input.Items.Any(i => i is null || string.IsNullOrWhiteSpace(i.ItemId) || string.IsNullOrWhiteSpace(i.WorkId)) ||
            input.Items.Select(i => i.ItemId).Distinct().Count() != input.Items.Length)
            throw new ArgumentException("Choose files once and select track, move or copy.");
        var resolved = new List<(ImportReviewItem Item, WorkSnapshot Work, ImportSelection Pick)>();
        foreach (var pick in input.Items)
        {
            var item = scan.Items.SingleOrDefault(i => i.Id == pick.ItemId) ??
                throw new ArgumentException("A selected file is not in this scan. Scan the folder again.");
            var work = (await metadata.GetWorkAsync(pick.WorkId, false, ct)).Work ??
                throw new ArgumentException("Choose a title that is available in the catalog.");
            if (work.Work.Kind == WorkKind.Film ? pick.EpisodeId is not null :
                !work.Episodes.Any(e => e.Id == pick.EpisodeId && e.MappingStatus == MappingStatus.Confirmed))
                throw new ArgumentException("Choose the exact episode from the catalog.");
            if (resolved.Any(r => r.Pick.WorkId == pick.WorkId && r.Pick.EpisodeId == pick.EpisodeId))
                throw new ArgumentException("Two selected files match one item. Choose one; the other file will be left untouched.");
            resolved.Add((item, work, pick));
        }
        var results = ImmutableArray.CreateBuilder<ImportItemResult>();
        foreach (var (item, work, pick) in resolved)
        {
            try { results.Add(await ImportOneAsync(scan.Id, item, work, pick, input, ct)); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            {
                foreach (var operation in (await operations.ImportOperationsAsync(ct)).Where(o =>
                    o.Id.StartsWith("import:" + scan.Id + ":" + item.Id + ":", StringComparison.Ordinal) &&
                    o.State is not FileOperationState.Done and not FileOperationState.NeedsOwner))
                    await operations.SaveImportOperationAsync(operation with { State = FileOperationState.NeedsOwner,
                        ResumeStage = operation.State, LastError = ex.Message, UpdatedAt = DateTimeOffset.UtcNow }, ct);
                results.Add(new(item.Id, null, false, ex.Message));
            }
        }
        return new(results.ToImmutable());
    }

    private async Task<ImportItemResult> ImportOneAsync(string scanId, ImportReviewItem item, WorkSnapshot work,
        ImportSelection pick, ImportConfirmInput input, CancellationToken ct)
    {
        var prior = await operations.ImportOperationAsync("import:" + scanId + ":" + item.Id + ":0", ct);
        if (prior is not null)
            return prior.State == FileOperationState.Done
                ? new(item.Id, prior.DestinationPath, false, null, true)
                : new(item.Id, prior.DestinationPath, false,
                    "An earlier import needs review. Check the original and destination paths before retrying.");
        var tracked = (await inventory.MediaAsync(null, ct)).SingleOrDefault(m =>
            m.PhysicalKey == LibraryPaths.PhysicalKey(item.Path));
        if (tracked is not null) return new(item.Id, tracked.Path, false, null, true);
        var files = new[] { new ImportSidecar(item.Path, item.Bytes, item.MtimeUtc) }.Concat(item.Sidecars).ToArray();
        foreach (var file in files) Stable(file);
        ValidateVideo(item.Path);
        var now = DateTimeOffset.UtcNow;
        var mediaId = "import:" + scanId + ":" + item.Id;
        var destinations = files.Select(f => f.Path).ToArray();
        string? rootId = (await placement.RootsAsync(ct)).FirstOrDefault(r => LibraryPaths.IsInside(r.Path, item.Path))?.Id;
        WorkFolderRow? folder = null;
        if (input.Mode != ImportMode.TrackInPlace)
        {
            var target = new TargetRow(mediaId, pick.WorkId, pick.EpisodeId,
                TargetKind.Acquire, TargetState.Done,
                null, null, null, null, null, null, null, null, null, false, 0, null, "owner",
                IntentOrigin.Owner, null, null, null, null, null, null, 0, null, 1, null, null, now, now, 1);
            var torrentFiles = files.Select((f, i) => new TorrentFile(i, Path.GetFileName(f.Path), f.Bytes, 0)).ToImmutableArray();
            var selections = files.Select((_, i) => new SelectedFile(mediaId, i, i == 0 ? FileRole.Video : FileRole.Subtitle)).ToImmutableArray();
            var placed = await placement.PlaceAsync(new(work, [target],
                new(mediaId, [mediaId], selections, files.Sum(f => f.Bytes), "import"),
                torrentFiles, [], [], input.RootId, null, null), ct);
            if (placed.Failure is not null) return new(item.Id, null, false, placed.Failure.Message);
            rootId = placed.RootId;
            folder = placed.Folders.SingleOrDefault();
            destinations = placed.Files.OrderBy(f => f.FileIndex).Select(f => f.FinalPath!).ToArray();
        }
        else if (pick.EpisodeId is not null && !(await inventory.FoldersAsync(ct)).Any(f => f.WorkId == work.Work.Id))
        {
            var actual = Path.GetDirectoryName(item.Path)!;
            if (System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(actual), @"^Season \d+$",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase, TimeSpan.FromMilliseconds(100)))
                actual = Path.GetDirectoryName(actual)!;
            var root = (await placement.RootsAsync(ct)).SingleOrDefault(r => r.Id == rootId);
            folder = new(Guid.NewGuid().ToString("N"), work.Work.Id, rootId,
                root is null ? null : Path.GetRelativePath(root.Path, actual), root is null ? actual : null, now, now, 1);
        }
        var opRows = ImmutableArray.CreateBuilder<FileOperationRow>();
        var media = ImmutableArray.CreateBuilder<MediaFileRow>();
        var quality = new Quality(item.Parsed.Quality.Resolution ??
            item.Parents.Select(p => p.Quality.Resolution).FirstOrDefault(v => v is not null),
            item.Parsed.Quality.Source ?? item.Parents.Select(p => p.Quality.Source).FirstOrDefault(v => v is not null),
            item.Parsed.Quality.Codec ?? item.Parents.Select(p => p.Quality.Codec).FirstOrDefault(v => v is not null),
            item.Parsed.Quality.Hdr ?? item.Parents.Select(p => p.Quality.Hdr).FirstOrDefault(v => v is not null));
        for (var i = 0; i < files.Length; i++)
        {
            var source = files[i];
            var destination = destinations[i];
            var opId = mediaId + ":" + i;
            var existingOp = await operations.ImportOperationAsync(opId, ct);
            if (existingOp is not null)
                return new(item.Id, existingOp.DestinationPath, false,
                    existingOp.State == FileOperationState.Done ? "Already in your library" :
                        "An earlier import needs review. The original was retained; check both paths before retrying.");
            var digest = await DownloadFiling.DigestAsync(source.Path, ct);
            Stable(source);
            var operation = new FileOperationRow(opId,
                input.Mode == ImportMode.Move ? FileOperationKind.Move :
                    input.Mode == ImportMode.Copy ? FileOperationKind.Copy : FileOperationKind.Import,
                null, null, null, source.Path, destination, source.Bytes, digest,
                FileOperationState.Pending, input.Mode == ImportMode.Move, 0, null, null,
                now, now, null, null, null, null);
            var claims = new[] { source.Path, destination, destination + ".partial" }
                .Select(LibraryPaths.PhysicalKey).Distinct().ToImmutableArray();
            if (!await operations.ClaimImportAsync(operation, claims, ct))
                throw new IOException("Another operation uses this file. Wait for it to finish and scan again.");
            if (input.Mode != ImportMode.TrackInPlace)
            {
                if (rootId is null || (await placement.CheckRootAsync(rootId, ct)).Root is not { Online: true, Enabled: true })
                    throw new IOException("The library drive is offline. Reconnect it and scan again; the original was kept.");
                LibraryPaths.NoLinks(destination);
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                await using (var from = new FileStream(source.Path, FileMode.Open, FileAccess.Read, FileShare.Read))
                await using (var to = new FileStream(destination + ".partial", FileMode.CreateNew, FileAccess.Write, FileShare.None))
                { await from.CopyToAsync(to, ct); await to.FlushAsync(ct); to.Flush(true); }
                if (new FileInfo(destination + ".partial").Length != source.Bytes ||
                    await DownloadFiling.DigestAsync(destination + ".partial", ct) != digest)
                    throw new IOException("The copied file did not verify. The original was kept; check the drive.");
                Stable(source);
                LibraryPaths.NoLinks(destination);
                File.Move(destination + ".partial", destination, false);
            }
            operation = operation with { State = FileOperationState.Verified, UpdatedAt = DateTimeOffset.UtcNow };
            await operations.SaveImportOperationAsync(operation, ct);
            opRows.Add(operation);
            media.Add(new(i == 0 ? mediaId : mediaId + ":" + i, pick.WorkId, pick.EpisodeId, rootId,
                destination, LibraryPaths.PhysicalKey(destination), i == 0 ? FileRole.Video : FileRole.Subtitle,
                i == 0 ? null : mediaId, source.Bytes, File.GetLastWriteTimeUtc(destination),
                i == 0 ? quality.Resolution : null, i == 0 ? quality.Source : null,
                Path.GetExtension(destination).TrimStart('.'), i == 0 ? quality.Codec : null,
                null, null, null, i == 0 ? quality.Hdr : null, null, null, [],
                MediaOrigin.Imported, null, null, now, now, null, FilePresence.Present, null, now, digest, 1));
        }
        var committedOps = opRows.Select((o, i) => o with { State = FileOperationState.InventoryCommitted,
            MediaFileId = media[i].Id, UpdatedAt = DateTimeOffset.UtcNow }).ToImmutableArray();
        if (rootId is not null && (await placement.CheckRootAsync(rootId, ct)).Root is not { Online: true })
            throw new IOException("The library drive became unavailable. Reconnect it and review both paths; the original was kept.");
        for (var i = 0; i < files.Length; i++)
        {
            Stable(files[i]);
            LibraryPaths.NoLinks(destinations[i]);
            if (new FileInfo(destinations[i]).Length != files[i].Bytes ||
                await DownloadFiling.DigestAsync(destinations[i], ct) != committedOps[i].ExpectedDigest)
                throw new IOException("The destination changed before it could be recorded. The original was kept; review both paths.");
        }
        if (!await operations.CommitImportAsync(media.ToImmutable(), folder, committedOps, ct))
            throw new IOException("The library changed while importing. The originals were kept; review the destination files.");
        for (var i = 0; i < files.Length; i++)
        {
            if (input.Mode == ImportMode.Move)
            {
                Stable(files[i]);
                if (await DownloadFiling.DigestAsync(files[i].Path, ct) != committedOps[i].ExpectedDigest ||
                    await DownloadFiling.DigestAsync(destinations[i], ct) != committedOps[i].ExpectedDigest)
                    throw new IOException("A file changed before removal. Both copies were kept; review them.");
                LibraryPaths.NoLinks(files[i].Path);
                File.Delete(files[i].Path);
            }
            await operations.SaveImportOperationAsync(committedOps[i] with
                { State = FileOperationState.Done, MediaFileId = null, UpdatedAt = DateTimeOffset.UtcNow }, ct);
        }
        return new(item.Id, destinations[0], true, null);
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
