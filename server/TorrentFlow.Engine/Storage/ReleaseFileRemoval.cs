namespace TorrentFlow.Engine.Storage;

/// <summary>What deleting one release may remove from disk (port of <c>release-file-removal.ts</c>).</summary>
internal sealed record ReleaseRemovalPlan(IReadOnlyList<string> Files, string? Folder, string? FolderReason);

/// <summary>
/// Physically removes a deleted release's files and, when the release created its own folder, that whole folder —
/// sidecar junk (posters, tracker spam, <c>.part</c> files) included — then prunes the empty folders it leaves behind,
/// down and up, never at or above the download root. A shared category or show folder is never removed: any path
/// another transfer still records inside it keeps it.
/// </summary>
internal static class ReleaseFileRemoval
{
    private static StringComparison Comparison => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    public static bool IsInsideOrEqual(string child, string root)
    {
        var c = Path.TrimEndingDirectorySeparator(Path.GetFullPath(child));
        var r = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        return string.Equals(c, r, Comparison) || c.StartsWith(r + Path.DirectorySeparatorChar, Comparison);
    }

    public static bool IsStrictlyInside(string child, string root) =>
        IsInsideOrEqual(child, root) && !string.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(child)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)), Comparison);

    /// <summary>The deepest directory holding every file, or null when they share none.</summary>
    public static string? CommonAncestorDir(IEnumerable<string> files)
    {
        List<string>? prefix = null;
        foreach (var file in files)
        {
            var dir = Path.GetDirectoryName(Path.GetFullPath(file));
            if (dir is null) return null;
            var parts = dir.Split(Path.DirectorySeparatorChar, StringSplitOptions.None).ToList();
            if (prefix is null) { prefix = parts; continue; }
            var i = 0;
            while (i < prefix.Count && i < parts.Count && string.Equals(prefix[i], parts[i], Comparison)) i++;
            prefix = prefix.Take(i).ToList();
            if (prefix.Count == 0) return null;
        }
        if (prefix is null || prefix.Count == 0) return null;
        var joined = string.Join(Path.DirectorySeparatorChar, prefix);
        return Path.GetFullPath(joined.EndsWith(':') ? joined + Path.DirectorySeparatorChar : joined);
    }

    /// <summary>
    /// Pure. Recorded files inside the save path or the download root may go. The release's folder goes too when it
    /// is strictly inside the root, inside-or-equal the save path, holds nothing another transfer records, and is the
    /// release's own container: strictly below the save path, or at least two levels below the root. The last rule is
    /// stricter than Next, whose plan would take a whole category folder (<c>Other/</c>) with a single-file release.
    /// </summary>
    public static ReleaseRemovalPlan Plan(IEnumerable<string> ownedFiles, string? savePath, string? baseRoot, IEnumerable<string> otherPaths)
    {
        savePath = string.IsNullOrWhiteSpace(savePath) ? null : Path.GetFullPath(savePath.Trim());
        baseRoot = string.IsNullOrWhiteSpace(baseRoot) ? null : Path.GetFullPath(baseRoot.Trim());
        var files = new List<string>();
        var seen = new HashSet<string>(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        foreach (var raw in ownedFiles)
        {
            if (string.IsNullOrWhiteSpace(raw)) continue;
            var full = Path.GetFullPath(raw.Trim());
            if (!seen.Add(full)) continue;
            if ((savePath is not null && IsStrictlyInside(full, savePath)) || (baseRoot is not null && IsStrictlyInside(full, baseRoot)))
                files.Add(full);
        }

        if (baseRoot is null) return new(files, null, "no download root to bound the delete");
        if (files.Count == 0) return new(files, null, "no recorded files to prove folder ownership");
        var candidate = CommonAncestorDir(files);
        if (candidate is null) return new(files, null, "files share no common folder");
        if (!IsStrictlyInside(candidate, baseRoot)) return new(files, null, "folder is the download root or above it");
        if (savePath is not null && !IsInsideOrEqual(candidate, savePath)) return new(files, null, "folder is above the recorded save path");
        var depth = Path.GetRelativePath(baseRoot, candidate).Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries).Length;
        if (depth < 2 && !(savePath is not null && IsStrictlyInside(candidate, savePath)))
            return new(files, null, "folder is a category folder");
        foreach (var other in otherPaths)
            if (!string.IsNullOrWhiteSpace(other) && IsInsideOrEqual(other.Trim(), candidate))
                return new(files, null, "folder is shared with another download");
        return new(files, candidate, null);
    }

    /// <summary>Never throws: files first (and their half-written siblings), then the proven-own folder.</summary>
    public static void Execute(ReleaseRemovalPlan plan)
    {
        foreach (var file in plan.Files)
        {
            TryDeleteFile(file);
            TryDeleteFile(file + ".part");
            TryDeleteFile(file + ".!qB");
        }
        if (plan.Folder is { } folder)
        {
            try
            {
                if (Directory.Exists(folder) && !new DirectoryInfo(folder).Attributes.HasFlag(FileAttributes.ReparsePoint))
                    Directory.Delete(folder, recursive: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
    }

    /// <summary>Removes empty directories below <paramref name="start"/>, deepest first; links are never followed.</summary>
    public static void PruneEmptyDescendants(string? start, string? stopAt, int maxDepth = 8)
    {
        if (string.IsNullOrWhiteSpace(start) || string.IsNullOrWhiteSpace(stopAt)) return;
        var root = Path.GetFullPath(stopAt);
        var from = Path.GetFullPath(start);
        if (!IsInsideOrEqual(from, root) || !Directory.Exists(from)) return;
        var visits = 0;
        void Walk(string dir, int depth)
        {
            if (depth > maxDepth || visits++ > 2000) return;
            IEnumerable<DirectoryInfo> children;
            try { children = new DirectoryInfo(dir).EnumerateDirectories().ToList(); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return; }
            foreach (var child in children)
            {
                if (child.Attributes.HasFlag(FileAttributes.ReparsePoint)) continue;
                Walk(child.FullName, depth + 1);
                try { if (!child.EnumerateFileSystemInfos().Any()) child.Delete(); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
            }
        }
        Walk(from, 0);
    }

    private static void TryDeleteFile(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
