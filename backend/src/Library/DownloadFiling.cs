using System.Collections.Immutable;
using System.Security.Cryptography;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed class DownloadFiling
{
    public static ImmutableArray<string> PayloadPaths(IEnumerable<DownloadFileRow> bindings,
        IEnumerable<MediaFileRow>? media = null)
    {
        var files = bindings.ToArray();
        var paths = files.SelectMany(b => new[] { b.PartialPath, b.FinalPath, b.EnginePath,
                b.FinalPath is null ? null : b.FinalPath + ".partial" }).OfType<string>()
            .Concat((media ?? []).Where(m => files.Any(f => f.DownloadId == m.DownloadId &&
                (f.MediaFileId == m.Id || f.FileIndex == m.FileIndex))).Select(m => m.Path))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var directory in UnwantedFolders(files))
            if (Directory.Exists(directory)) Collect(directory);
        return [.. paths.Where(File.Exists)];

        void Collect(string directory)
        {
            LibraryPaths.NoLinks(directory);
            foreach (var path in Directory.EnumerateFileSystemEntries(directory))
            {
                LibraryPaths.NoLinks(path);
                if (Directory.Exists(path)) Collect(path);
                else paths.Add(path);
            }
        }
    }

    private static IEnumerable<string> UnwantedFolders(IEnumerable<DownloadFileRow> bindings)
    {
        var folders = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in bindings.Where(f => f.Role == FileRole.Unwanted))
        {
            for (var directory = Path.GetDirectoryName(file.EnginePath ?? file.PartialPath);
                 directory is not null; directory = Path.GetDirectoryName(directory))
                if (Path.GetFileName(Path.GetDirectoryName(directory)) == ".unwanted")
                { folders.Add(directory); break; }
        }
        return folders;
    }

    public static ImmutableArray<DownloadFileRow> RetireBindings(ImmutableArray<DownloadFileRow> files,
        ImmutableArray<DownloadFileRow> allFiles, string rootPath, string hash)
    {
        var unwanted = UnwantedFolders(allFiles).FirstOrDefault() ??
            LibraryPaths.Within(rootPath, Path.Combine(".unwanted", hash));
        if (!LibraryPaths.IsInside(rootPath, unwanted) || Path.GetFileName(unwanted) != hash)
            throw new IOException("The pack fragment folder is outside its library.");
        return [.. files.Select(f =>
        {
            var path = LibraryPaths.Within(unwanted, Path.Combine(
                f.FileIndex.ToString(System.Globalization.CultureInfo.InvariantCulture), "removed.partial"));
            return f with { TargetId = null, Selected = false, Filed = false, MediaFileId = null,
                PartialPath = path, FinalPath = null, EnginePath = path,
                PhysicalKey = LibraryPaths.PhysicalKey(path), Role = FileRole.Unwanted };
        })];
    }

    public static async Task<string> DigestAsync(string path, CancellationToken ct)
    {
        LibraryPaths.NoLinks(path);
        await using var stream = File.OpenRead(path);
        using var observed = DeletionMeasurement.Time("sha");
        DeletionMeasurement.Add("shaCalls");
        DeletionMeasurement.Add("shaBytes", stream.Length);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, ct));
    }

    public static async Task<ImmutableArray<EngineRecoveryFiles>> RecoveryAsync(ILibraryDownloadRepository repository,
        CancellationToken ct)
    {
        var files = await repository.BindingsAsync(ct);
        var result = ImmutableArray.CreateBuilder<EngineRecoveryFiles>();
        foreach (var group in files.GroupBy(f => f.DownloadId))
        {
            var recovered = ImmutableArray.CreateBuilder<EngineRecoveryBinding>();
            foreach (var file in group)
            {
                var path = file.EnginePath ?? file.PartialPath!;
                var filed = file.Filed;
                if (!filed && file.FinalPath is { } final && !File.Exists(file.PartialPath) && File.Exists(final))
                {
                    path = final;
                    recovered.Add(new(file.FileIndex, path, false, false));
                    continue;
                }
                recovered.Add(new(file.FileIndex, path, file.Selected && !filed, filed));
            }
            result.Add(new(group.Key, recovered.ToImmutable()));
        }
        return result.ToImmutable();
    }
    public static ImmutableArray<DownloadFileRow> BindUnwanted(string downloadId, string hash,
        string itemFolder, ImmutableArray<TorrentFile> metadata, ImmutableArray<DownloadFileRow> selected)
    {
        var output = selected.Select(f => f with { Id = $"{downloadId}:{f.FileIndex}", DownloadId = downloadId }).ToList();
        var unwanted = LibraryPaths.Within(itemFolder, Path.Combine(".unwanted", hash));
        foreach (var file in metadata.Where(f => selected.All(s => s.FileIndex != f.Index)))
        {
            var relative = string.Join(Path.DirectorySeparatorChar,
                file.RelativePath.Split(['/', '\\']).Select(LibraryPaths.SafeLeaf));
            var path = LibraryPaths.Within(unwanted, Path.Combine(file.Index.ToString(System.Globalization.CultureInfo.InvariantCulture),
                relative + ".partial"));
            output.Add(new DownloadFileRow
            {
                Id = $"{downloadId}:{file.Index}",
                DownloadId = downloadId,
                FileIndex = file.Index,
                Selected = false,
                TargetId = null,
                PartialPath = path,
                FinalPath = null,
                PhysicalKey = LibraryPaths.PhysicalKey(path),
                MediaFileId = null,
                Role = FileRole.Unwanted,
                ExpectedBytes = file.Bytes,
                EnginePath = path,
                Filed = false,
            });
        }
        return [.. output.OrderBy(f => f.FileIndex)];
    }

    public static Failure? ValidatePartial(DownloadFileRow binding, EngineFileSnapshot file, Action<Exception>? readFailure = null)
    {
        if (!file.AllTouchingPiecesComplete)
            return new("HashIncomplete", "Wait for every piece touching this file to pass its hash check.", null, false);
        try
        {
            var path = file.PhysicalPath!;
            LibraryPaths.NoLinks(path);
            var info = new FileInfo(path);
            if (!info.Exists || info.Length != binding.ExpectedBytes)
                return new("FileChanged", "The completed file is missing or changed. Check the folder.", null, true);
            if (binding.Role == FileRole.Video)
            {
                if (info.Length < 1024 * 1024)
                    return new("InvalidVideo", "The downloaded video is too small.", null, true);
                using var stream = File.OpenRead(path);
                Span<byte> header = stackalloc byte[16];
                if (!VideoSignature.Recognized(header[..stream.Read(header)]))
                    return new("InvalidVideo", "The downloaded file is not a recognized video.", null, true);
            }
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        { readFailure?.Invoke(ex); return new("FileBusy", "The completed file cannot be read. Close any app using it and try again.", null, false); }
    }

    public static bool RecognizedVideo(FileStream stream)
    {
        Span<byte> header = stackalloc byte[16];
        stream.Position = 0;
        return stream.Length >= 1024 * 1024 && VideoSignature.Recognized(header[..stream.Read(header)]);
    }

    public static MediaFileRow Media(DownloadRow download, WorkSnapshot work, TargetRow target,
        int? resolution, string? source, DownloadFileRow binding, FileStream? verifiedStream = null)
    {
        var now = DateTimeOffset.UtcNow;
        var path = binding.FinalPath!;
        LibraryPaths.NoLinks(path);
        var details = binding.Role == FileRole.Video && verifiedStream is not null ? VideoDimensions.ReadDetails(verifiedStream) : (null, null, (double?)null);
        (int? Width, int? Height) dimensions = binding.Role != FileRole.Video ? (null, null) : verifiedStream is null ? VideoDimensions.Read(path) : (details.Item1, details.Item2);
        var physicalKey = LibraryPaths.PhysicalKey(path);
        var identity = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(physicalKey)));
        return new MediaFileRow
        {
            Id = $"downloaded:{identity}",
            WorkId = target.WorkId,
            EpisodeId = target.EpisodeId,
            RootId = download.RootId,
            Path = path,
            PhysicalKey = LibraryPaths.PhysicalKey(path),
            Role = binding.Role,
            ParentMediaFileId = null,
            Bytes = binding.ExpectedBytes,
            MtimeUtc = File.GetLastWriteTimeUtc(path),
            Resolution = VideoDimensions.Resolution(dimensions.Width, dimensions.Height) ?? resolution,
            Source = source,
            Container = Path.GetExtension(path).TrimStart('.'),
            VideoCodec = null,
            VideoProfile = null,
            Width = dimensions.Width,
            Height = dimensions.Height,
            Hdr = null,
            RuntimeSeconds = null,
            BitrateBps = null,
            Tracks = [],
            Origin = MediaOrigin.Downloaded,
            DownloadId = binding.DownloadId,
            FileIndex = binding.FileIndex,
            AddedAt = now,
            LastSeenAt = now,
            MissingSince = null,
            Status = FilePresence.Present,
            MissingConfirmedAt = null,
            VerifiedAt = now,
            ContentDigest = null,
            Version = 1,
        };
    }

    public static async Task DeletePayloadAsync(ImmutableArray<DownloadFileRow> bindings, string itemFolder, string hash,
        ImmutableArray<MediaFileRow> media, CancellationToken ct, ImmutableArray<FileOperationRow> operations = default)
    {
        if (operations.IsDefault) operations = [];
        var ownedMedia = media.Where(m => bindings.Any(f => f.DownloadId == m.DownloadId &&
            (f.MediaFileId == m.Id || f.FileIndex == m.FileIndex))).ToArray();
        var paths = new Dictionary<string, (string? Digest, string? Identity)>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in ownedMedia.Where(m => File.Exists(m.Path)))
        {
            if (LibraryPaths.PhysicalKey(file.Path) != file.PhysicalKey || file.ContentDigest is null)
                throw new IOException("A library file has no valid ownership proof. It was left untouched.");
            paths[file.Path] = (file.ContentDigest, operations.SingleOrDefault(o => o.MediaFileId == file.Id)?.SourceIdentity);
        }
        foreach (var file in bindings)
        {
            if (file.PartialPath is { } partial) paths.TryAdd(partial, (null, null));
            if (file.EnginePath is { } enginePath && enginePath != file.FinalPath) paths.TryAdd(enginePath, (null, null));
            var operation = operations.SingleOrDefault(o => o.Id == "file:" + file.Id);
            if (file.FinalPath is { } final && File.Exists(final))
            {
                if (file.Filed || file.EnginePath == final)
                {
                    if (!paths.ContainsKey(final)) throw new IOException("The final file has no library ownership proof. It was left untouched.");
                }
                else if (operation is { State: FileOperationState.Verified or FileOperationState.Done, SourceIdentity: not null, ExpectedDigest: not null } &&
                    operation.SourcePath == file.PartialPath && operation.DestinationPath == final &&
                    operation.TargetId == file.TargetId && operation.ExpectedBytes == file.ExpectedBytes &&
                    operation.BindingFingerprint == Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
                        System.Text.Encoding.UTF8.GetBytes(System.Text.Json.JsonSerializer.Serialize(file)))))
                    paths[final] = (operation.ExpectedDigest, operation.SourceIdentity);
                else if (!File.Exists(file.PartialPath))
                    throw new IOException("An existing destination cannot be identified as this download. It was left untouched.");
            }
        }
        // Validate the whole batch before deleting any payload. Each guard survives its one checksum and delete.
        var guards = new List<PayloadFile>();
        try
        {
            foreach (var (path, proof) in paths)
            {
                LibraryPaths.NoLinks(path);
                if (!LibraryPaths.IsInside(itemFolder, path)) throw new IOException("The deletion path is outside the title folder.");
                if (!File.Exists(path)) continue;
                var guard = new PayloadFile(path);
                guards.Add(guard);
                DeletionMeasurement.Add("guardedFiles");
                if (proof.Identity is not null && guard.Identity != proof.Identity ||
                    proof.Digest is not null && await guard.DigestAsync(ct) != proof.Digest)
                    throw new IOException("A recorded file changed. It was left untouched. Review it before removing it.");
            }
            ct.ThrowIfCancellationRequested();
            foreach (var guard in guards) guard.Delete();
        }
        finally { foreach (var guard in guards) guard.Dispose(); }
        foreach (var directory in UnwantedFolders(bindings))
        {
            if (Path.GetFileName(directory) != hash || !LibraryPaths.IsInside(itemFolder, directory))
                throw new IOException("The unwanted fragments do not belong to this download.");
            if (Directory.Exists(directory)) DeleteTree(directory);
        }
        var directories = bindings.SelectMany(b => new[] { b.PartialPath, b.FinalPath, b.EnginePath })
            .OfType<string>().Concat(ownedMedia.Select(m => m.Path))
            .Select(p => Path.GetDirectoryName(p)!).Concat(UnwantedFolders(bindings).Select(Path.GetDirectoryName).OfType<string>())
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        foreach (var directory in directories)
        {
            var current = directory;
            while (LibraryPaths.IsInside(itemFolder, current) && Directory.Exists(current))
            {
                LibraryPaths.NoLinks(current);
                if (Path.GetFileName(current) == ".unwanted" &&
                    Directory.EnumerateFileSystemEntries(current).All(p => Path.GetFileName(p) == ".ignore"))
                    File.Delete(Path.Combine(current, ".ignore"));
                if (Directory.EnumerateFileSystemEntries(current).Any()) break;
                Directory.Delete(current);
                current = Path.GetDirectoryName(current)!;
            }
        }
    }

    public static void RemoveUnwanted(IEnumerable<DownloadFileRow> bindings, string hash)
    {
        foreach (var directory in UnwantedFolders(bindings))
        {
            if (Path.GetFileName(directory) != hash)
                throw new IOException("The unwanted fragments do not belong to this download.");
            if (Directory.Exists(directory)) DeleteTree(directory);
            var parent = Path.GetDirectoryName(directory)!;
            if (Directory.Exists(parent) &&
                Directory.EnumerateFileSystemEntries(parent).All(p => Path.GetFileName(p) == ".ignore"))
            {
                LibraryPaths.NoLinks(parent);
                File.Delete(Path.Combine(parent, ".ignore"));
                Directory.Delete(parent);
            }
        }
    }

    private static void DeleteTree(string directory)
    {
        LibraryPaths.NoLinks(directory);
        foreach (var path in Directory.EnumerateFileSystemEntries(directory))
        {
            LibraryPaths.NoLinks(path);
            if (Directory.Exists(path)) DeleteTree(path);
            else File.Delete(path);
        }
        Directory.Delete(directory);
    }
}
