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

    public static Failure? ValidatePartial(DownloadFileRow binding, EngineFileSnapshot file)
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
        { return new("FileBusy", "The completed file cannot be read. Close any app using it and try again.", null, false); }
    }

    public static MediaFileRow Media(DownloadRow download, WorkSnapshot work, TargetRow target,
        int? resolution, string? source, DownloadFileRow binding)
    {
        var now = DateTimeOffset.UtcNow;
        var path = binding.FinalPath!;
        LibraryPaths.NoLinks(path);
        (int? Width, int? Height) dimensions = binding.Role == FileRole.Video ? VideoDimensions.Read(path) : (null, null);
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
        ImmutableArray<MediaFileRow> media, CancellationToken ct)
    {
        var ownedMedia = media.Where(m => bindings.Any(f => f.DownloadId == m.DownloadId &&
            (f.MediaFileId == m.Id || f.FileIndex == m.FileIndex))).ToArray();
        foreach (var file in ownedMedia.Where(m => File.Exists(m.Path)))
        {
            LibraryPaths.NoLinks(file.Path);
            if (!LibraryPaths.IsInside(itemFolder, file.Path) ||
                LibraryPaths.PhysicalKey(file.Path) != file.PhysicalKey || file.ContentDigest is null ||
                await DigestAsync(file.Path, ct) != file.ContentDigest)
                throw new IOException("A recorded library file changed. It was left untouched. Review it before removing it.");
        }
        foreach (var file in bindings)
        {
            var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (file.PartialPath is { } partial) paths.Add(partial);
            if (file.EnginePath is { } enginePath && enginePath != file.FinalPath) paths.Add(enginePath);
            if (file.FinalPath is { } final && File.Exists(final))
            {
                var digest = media.SingleOrDefault(m => m.Id == file.MediaFileId)?.ContentDigest;
                if (file.Filed || file.EnginePath == final)
                {
                    if (digest is null || await DigestAsync(final, ct) != digest)
                        throw new IOException("The file at the final path changed. It was left untouched. Review it before removing it.");
                    paths.Add(final);
                }
            }
            foreach (var path in paths)
            {
                LibraryPaths.NoLinks(path);
                if (!LibraryPaths.IsInside(itemFolder, path)) throw new IOException("The deletion path is outside the title folder.");
                if (File.Exists(path)) File.Delete(path);
            }
            if (file.FinalPath is { } ownedFinal)
            {
                var partialSibling = ownedFinal + ".partial";
                if (File.Exists(partialSibling) && !media.Any(m => m.Path.Equals(partialSibling, StringComparison.OrdinalIgnoreCase)))
                {
                    LibraryPaths.NoLinks(partialSibling);
                    if (!LibraryPaths.IsInside(itemFolder, partialSibling)) throw new IOException("The partial is outside the title folder.");
                    File.Delete(partialSibling);
                }
            }
        }
        foreach (var file in ownedMedia)
            if (File.Exists(file.Path)) File.Delete(file.Path);
        foreach (var directory in UnwantedFolders(bindings))
        {
            if (Path.GetFileName(directory) != hash || !LibraryPaths.IsInside(itemFolder, directory))
                throw new IOException("The unwanted fragments do not belong to this download.");
            if (Directory.Exists(directory)) DeleteUnwanted(directory);
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

        static void DeleteUnwanted(string directory)
        {
            LibraryPaths.NoLinks(directory);
            foreach (var path in Directory.EnumerateFileSystemEntries(directory))
            {
                LibraryPaths.NoLinks(path);
                if (Directory.Exists(path)) DeleteUnwanted(path);
                else File.Delete(path);
            }
            Directory.Delete(directory);
        }
    }
}
