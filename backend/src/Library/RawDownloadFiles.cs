using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public static class RawDownloadFiles
{
    public static string Destination(StorageRootRow root, string hash) =>
        LibraryPaths.Within(root.Path, Path.Combine("Downloads", hash));

    public static ImmutableArray<FileBinding> Bindings(string hash, string root,
        ImmutableArray<TorrentFile> files, int[] selected, bool recovery = false)
    {
        if (selected.Any(i => files.All(f => f.Index != i)))
            throw new ArgumentException("A selected file index does not exist.");
        return [.. files.Select(f =>
        {
            var keep = selected.Length == 0 || selected.Contains(f.Index);
            var relative = f.RelativePath.Replace('/', Path.DirectorySeparatorChar);
            var path = LibraryPaths.Within(root, Path.Combine(keep ? "" : $".unwanted\\{hash}\\{f.Index}", relative));
            SafePath(path);
            if (!recovery && (File.Exists(path) || File.Exists(path + ".partial")))
                throw new ArgumentException("A destination file already exists. Choose an empty folder.");
            return new FileBinding(f.Index, path + ".partial", keep);
        })];
    }

    public static void SafePath(string path) => LibraryPaths.NoLinks(path);

    public static void DeletePayload(string root, string hash, IEnumerable<string> paths)
    {
        foreach (var path in paths)
        {
            SafePath(path);
            if (!LibraryPaths.IsInside(root, path))
                throw new IOException("The download file is outside its folder.");
            if (File.Exists(path)) File.Delete(path);
        }
        PruneUnwanted(root, hash);
        var unwanted = LibraryPaths.Within(root, ".unwanted");
        if (Directory.Exists(unwanted) && Directory.EnumerateFileSystemEntries(unwanted)
            .All(p => Path.GetFileName(p) == ".ignore"))
        {
            File.Delete(Path.Combine(unwanted, ".ignore"));
            Directory.Delete(unwanted);
        }
    }

    public static void CompletePublication(EngineSnapshot snapshot, string root)
    {
        foreach (var file in snapshot.Files)
        {
            SafePath(file.PhysicalPath!);
            if (!LibraryPaths.IsInside(root, file.PhysicalPath!))
                throw new IOException("The download file is outside its folder.");
            if (file.Selected)
            {
                var path = file.PhysicalPath![..^".partial".Length];
                if (!File.Exists(path)) throw new IOException("A completed file is missing.");
            }
            else if (File.Exists(file.PhysicalPath)) File.Delete(file.PhysicalPath!);
        }
        PruneUnwanted(root, snapshot.Hash);
    }

    public static void PruneUnwanted(string root, string hash)
    {
        var unwanted = LibraryPaths.Within(root, Path.Combine(".unwanted", hash));
        if (Directory.Exists(unwanted)) Prune(unwanted);
        static void Prune(string path)
        {
            SafePath(path);
            foreach (var child in Directory.EnumerateDirectories(path)) Prune(child);
            if (!Directory.EnumerateFileSystemEntries(path).Any()) Directory.Delete(path);
        }
    }
}
