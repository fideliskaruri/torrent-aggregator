using System.Collections.Immutable;
using System.Security.Cryptography;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed class DownloadFiling
{
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
        var operations = await repository.FilingOperationsAsync(ct);
        var result = ImmutableArray.CreateBuilder<EngineRecoveryFiles>();
        foreach (var group in files.GroupBy(f => f.DownloadId))
        {
            var recovered = ImmutableArray.CreateBuilder<EngineRecoveryBinding>();
            foreach (var file in group)
            {
                var path = file.EnginePath!;
                var filed = file.Filed;
                var operation = operations.SingleOrDefault(o => o.Id == $"file:{file.Id}");
                if (!file.Filed && operation is not null && file.FinalPath is { } final &&
                    !File.Exists(file.PartialPath) && File.Exists(final))
                {
                    if (await DigestAsync(final, ct) != operation.ExpectedDigest)
                    {
                        // Keep the missing partial binding protected. Engine reports the failed
                        // hash check as waiting instead of binding or overwriting this other file.
                        recovered.Add(new(file.FileIndex, path, false, true));
                        continue;
                    }
                    path = final;
                    filed = true;
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
            output.Add(new($"{downloadId}:{file.Index}", downloadId, file.Index, false, null, path,
                null, LibraryPaths.PhysicalKey(path), null, FileRole.Unwanted, file.Bytes, path, false));
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

    public static MediaFileRow Media(DownloadFilingContext context, DownloadFileRow binding)
    {
        var target = context.Targets.Single(t => t.Id == binding.TargetId);
        var now = DateTimeOffset.UtcNow;
        var path = binding.FinalPath!;
        LibraryPaths.NoLinks(path);
        (int? Width, int? Height) dimensions = binding.Role == FileRole.Video ? VideoDimensions.Read(path) : (null, null);
        return new($"downloaded:{binding.DownloadId}:{binding.FileIndex}", target.WorkId, target.EpisodeId,
            context.Download.RootId, path, LibraryPaths.PhysicalKey(path), binding.Role, null,
            binding.ExpectedBytes, File.GetLastWriteTimeUtc(path),
            VideoDimensions.Resolution(dimensions.Width, dimensions.Height) ?? context.Resolution, context.Source,
            Path.GetExtension(path).TrimStart('.'), null, null, dimensions.Width, dimensions.Height, null, null, null, [],
            MediaOrigin.Downloaded, binding.DownloadId, binding.FileIndex, now, now, null,
            FilePresence.Present, null, now, null, 1);
    }

    public static async Task DeletePayloadAsync(ImmutableArray<DownloadFileRow> bindings, string itemFolder, string hash,
        ImmutableArray<FileOperationRow> operations, ImmutableArray<MediaFileRow> media, CancellationToken ct)
    {
        foreach (var file in bindings)
        {
            var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (file.PartialPath is { } partial) paths.Add(partial);
            if (file.EnginePath is { } enginePath && enginePath != file.FinalPath) paths.Add(enginePath);
            if (file.FinalPath is { } final && File.Exists(final))
            {
                var operation = operations.SingleOrDefault(o => o.Id == $"file:{file.Id}");
                var digest = media.SingleOrDefault(m => m.Id == file.MediaFileId)?.ContentDigest ?? operation?.ExpectedDigest;
                if (file.Filed || file.EnginePath == final || operation is not null && !File.Exists(file.PartialPath))
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
        }
        var unwanted = LibraryPaths.Within(itemFolder, Path.Combine(".unwanted", hash));
        Prune(unwanted);
        var hidden = Path.GetDirectoryName(unwanted)!;
        if (Directory.Exists(hidden) && Directory.EnumerateFileSystemEntries(hidden).All(p => Path.GetFileName(p) == ".ignore"))
        {
            File.Delete(Path.Combine(hidden, ".ignore"));
            Directory.Delete(hidden);
        }
        foreach (var path in bindings.Where(b => b.FinalPath is not null).Select(b => Path.GetDirectoryName(b.FinalPath!)!).Distinct())
            Prune(path);
        Prune(itemFolder);
    }

    private static void Prune(string path)
    {
        LibraryPaths.NoLinks(path);
        if (!Directory.Exists(path)) return;
        foreach (var child in Directory.EnumerateDirectories(path)) Prune(child);
        if (!Directory.EnumerateFileSystemEntries(path).Any()) Directory.Delete(path);
    }
}
