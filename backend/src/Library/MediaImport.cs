using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed partial class MediaImport(IParser parser, IMetadata metadata, ILibraryPlacement placement,
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

    public async Task<ImportScanView> AdoptAsync(ImportScanView scan,
        Func<string, string, string, CancellationToken, Task> decide, CancellationToken ct,
        MediaOrigin origin = MediaOrigin.Imported)
    {
        var tracked = await inventory.MediaAsync(null, ct);
        var roots = await placement.RootsAsync(ct);
        foreach (var item in scan.Items)
        {
            if (tracked.Any(m => m.PhysicalKey == LibraryPaths.PhysicalKey(item.Path)))
            {
                await decide(scan.Id, item.Id, "already-owned", ct);
                continue;
            }
            if (item.Group != ImportConfidence.Confident || item.Candidates.Length != 1) continue;
            LibraryPaths.NoLinks(item.Path);
            var info = new FileInfo(item.Path);
            if (!info.Exists || info.Length != item.Bytes || info.LastWriteTimeUtc != item.MtimeUtc.UtcDateTime) continue;
            if (await Track(item, item.Candidates[0].WorkId, item.Candidates[0].EpisodeId, roots, origin, ct) is null)
                await decide(scan.Id, item.Id, "adopted", ct);
        }
        return scan with { State = "complete" };
    }

    public Task ScanAsync(string id, string path, Action<ImportScanView> report, CancellationToken ct) =>
        ScanFilesAsync(id, path, Walk(path), report, ct);

    public async Task<ImportConfirmResult> ConfirmAsync(ImportScanView scan, ImportConfirmInput input,
        CancellationToken ct)
    {
        if (scan.State != "complete") throw new ArgumentException("Wait for the scan to finish before confirming.");
        if (input.Items.IsDefaultOrEmpty ||
            input.Items.Any(i => i is null || string.IsNullOrWhiteSpace(i.ItemId) || string.IsNullOrWhiteSpace(i.WorkId)) ||
            input.Items.Select(i => i.ItemId).Distinct().Count() != input.Items.Length)
            throw new ArgumentException("Choose files once to import.");
        var roots = await placement.RootsAsync(ct);
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
                var failure = await Track(item, pick.WorkId, pick.EpisodeId, roots, MediaOrigin.Imported, ct);
                results.Add(new(item.Id, failure is null ? item.Path : null, failure is null, failure?.Message));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            {
                results.Add(new(item.Id, null, false, ex.Message));
            }
        }
        return new(results.ToImmutable());
    }

    private async Task<Failure?> Track(ImportReviewItem item, string workId, string? episodeId,
        ImmutableArray<StorageRootRow> roots, MediaOrigin origin, CancellationToken ct)
    {
        var root = roots.FirstOrDefault(r => LibraryPaths.IsInside(r.Path, item.Path));
        var details = await DetailsAsync(item.Path, ct);
        T? Inherit<T>(Func<Quality, T?> get) => get(item.Parsed.Quality) ??
            item.Parents.Select(p => get(p.Quality)).FirstOrDefault(v => v is not null);
        var physical = LibraryPaths.PhysicalKey(item.Path);
        var now = DateTimeOffset.UtcNow;
        var media = new MediaFileRow
        {
            Id = "media:" + physical, WorkId = workId, EpisodeId = episodeId, RootId = root?.Id,
            Path = item.Path, PhysicalKey = physical, Role = FileRole.Video, ParentMediaFileId = null,
            Bytes = item.Bytes, MtimeUtc = item.MtimeUtc,
            Resolution = VideoDimensions.Resolution(details.Width, details.Height) ?? Inherit(q => q.Resolution),
            Source = Inherit(q => q.Source), Container = Path.GetExtension(item.Path).TrimStart('.'),
            VideoCodec = Inherit(q => q.Codec), VideoProfile = null, Width = details.Width, Height = details.Height,
            Hdr = Inherit(q => q.Hdr), RuntimeSeconds = details.RuntimeSeconds, BitrateBps = null, Tracks = [],
            Origin = origin, DownloadId = null, FileIndex = null, AddedAt = now, LastSeenAt = now,
            MissingSince = null, Status = FilePresence.Present, MissingConfirmedAt = null,
            VerifiedAt = now, ContentDigest = null, Version = 1,
        };
        return await placement.RecordAsync(media, null, ct);
    }

    private async Task<ImportMediaDetails> DetailsAsync(string path, CancellationToken ct)
    {
        var file = new FileInfo(path);
        if (mediaDetails.TryGetValue(path, out var cached) && cached.Bytes == file.Length &&
            cached.Mtime == file.LastWriteTimeUtc) return cached.Details;
        var details = await ImportMediaDetails.ReadAsync(path, ct);
        mediaDetails[path] = (file.Length, file.LastWriteTimeUtc, details);
        return details;
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
