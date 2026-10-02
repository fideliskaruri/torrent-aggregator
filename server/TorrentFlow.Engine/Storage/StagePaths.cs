using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using TorrentFlow.Engine.Controllers;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Engine.Storage;

/// <summary>
/// The one path resolver for staged downloads (docs/english-gates-plan.md section 1). A transfer's payload is written to
/// <c>&lt;download root&gt;\.staging\&lt;hash&gt;</c>, outside every library folder, so Jellyfin never sees a file before
/// the gate. Promotion is only ever a rename (<see cref="NoCopyMove"/>): when the final path is on another device than the
/// download root (proven by <see cref="SameDevice"/>, never by drive letters), the stage is a <c>.staging</c> folder next
/// to the library root that holds it, if that one is on the final path's device; otherwise the promotion waits for the
/// owner. The <c>.staging</c> folder is hidden and carries an empty <c>.ignore</c> file, so Jellyfin skips it even inside
/// a library.
/// </summary>
internal static partial class StagePaths
{
    public const string FolderName = ".staging";
    private const string IgnoreFile = ".ignore";
    private static readonly TimeSpan ProbeTtl = TimeSpan.FromMinutes(10);
    private static readonly ConcurrentDictionary<string, (bool Same, DateTime At)> Probed = new();

    private static StringComparison PathComparison => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
    private static StringComparer PathComparer => OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    [GeneratedRegex("^(?:[0-9a-f]{40}|[0-9a-f]{64})$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex HashName();

    /// <summary>The stage folder for a transfer whose files are promoted into <paramref name="finalPath"/>.</summary>
    public static string For(string finalPath, ClientConfig config, string hash) =>
        Path.Combine(StagingRoot(finalPath, config), hash.ToLowerInvariant());

    /// <summary>
    /// The <c>.staging</c> folder on <paramref name="finalPath"/>'s device: the download root's, else the one next to the
    /// library root holding the final path. When neither is (a library mounted from another drive), the download root's:
    /// its promotion is then held for the owner instead of copied.
    /// </summary>
    public static string StagingRoot(string finalPath, ClientConfig config)
    {
        var final = Path.GetFullPath(finalPath);
        var candidates = new List<string>();
        if (config.DownloadRoot is { } root) candidates.Add(Path.Combine(Path.GetFullPath(root), FolderName));
        if (FoldersController.LibraryRoots(config).Where(r => FoldersController.IsWithin(final, r)).OrderByDescending(r => r.Length).FirstOrDefault() is { } library
            && Path.GetDirectoryName(library.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)) is { } parent)
            candidates.Add(Path.Combine(parent, FolderName));
        if (candidates.Count == 0) return Path.Combine(Path.GetPathRoot(final)!, FolderName);
        string? unknown = null;
        foreach (var candidate in candidates.Distinct(PathComparer))
        {
            switch (SameDevice(candidate, final))
            {
                case true: return candidate;
                case null: unknown ??= candidate; break;
            }
        }
        return unknown ?? candidates[0];
    }

    /// <summary>
    /// Whether a file can be renamed from <paramref name="from"/> to <paramref name="to"/> without copying, proven by
    /// renaming an empty probe folder between the nearest existing folders with <see cref="NoCopyMove"/>. Drive letters
    /// and path roots can't tell: a junction or a mounted folder shares C:\ with another disk, and on Linux every path
    /// starts with /. Null when it couldn't be tried (nothing there yet, no write access). Answers are kept ten minutes.
    /// </summary>
    public static bool? SameDevice(string from, string to)
    {
        if (NearestExisting(from) is not { } a || NearestExisting(to) is not { } b) return null;
        if (string.Equals(a, b, PathComparison)) return true;
        var key = $"{a}|{b}";
        if (Probed.TryGetValue(key, out var known) && DateTime.UtcNow - known.At < ProbeTtl) return known.Same;
        var name = $".tf-device-probe-{Guid.NewGuid():N}";
        var source = Path.Combine(a, name);
        var target = Path.Combine(b, name);
        try { Directory.CreateDirectory(source); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException) { return null; }
        bool? same;
        try
        {
            NoCopyMove.Move(source, target);
            same = true;
        }
        catch (CrossDeviceMoveException) { same = false; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { same = null; }
        TryRemoveEmpty(same == true ? target : source);
        // A transfer's own stage folder is probed once, at its promotion; caching it would only grow the cache.
        if (same is { } answer && !IsStage(a) && !IsStage(b)) Probed[key] = (answer, DateTime.UtcNow);
        return same;
    }

    private static string? NearestExisting(string path)
    {
        for (var dir = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar); !string.IsNullOrEmpty(dir);
             dir = Path.GetDirectoryName(dir))
        {
            if (Directory.Exists(dir)) return dir;
            if (Path.GetPathRoot(dir) == dir) break;
        }
        return null;
    }

    private static void TryRemoveEmpty(string dir)
    {
        try { if (Directory.Exists(dir)) Directory.Delete(dir); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>Every <c>.staging</c> folder in use outside the download root, so the storage cap counts them once.</summary>
    public static IReadOnlyList<string> OutsideRoot(IEnumerable<string?> stagePaths, string? downloadRoot) =>
        stagePaths.OfType<string>().Select(p => Path.GetDirectoryName(Path.GetFullPath(p))).OfType<string>()
            .Where(r => downloadRoot is null || !FoldersController.IsWithin(r, Path.GetFullPath(downloadRoot)))
            .Distinct(PathComparer).ToList();

    /// <summary>Every <c>.staging</c> folder to look in: the download root's and the parents of the stage paths in use.</summary>
    public static IReadOnlyList<string> Roots(string? downloadRoot, IEnumerable<string?> stagePaths) =>
        (downloadRoot is null ? Array.Empty<string>() : [Path.Combine(Path.GetFullPath(downloadRoot), FolderName)])
            .Concat(stagePaths.OfType<string>().Where(IsStage).Select(p => Path.GetDirectoryName(Path.GetFullPath(p))!))
            .Distinct(PathComparer).ToList();

    /// <summary>The transfer folders in a <c>.staging</c> folder: the ones named by an info hash, nothing else.</summary>
    public static IReadOnlyList<string> Folders(string stagingRoot)
    {
        try
        {
            return Directory.Exists(stagingRoot)
                ? Directory.EnumerateDirectories(stagingRoot).Where(d => HashName().IsMatch(Path.GetFileName(d))).ToList()
                : [];
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return []; }
    }

    /// <summary>True for a transfer's own folder directly under a <c>.staging</c> folder.</summary>
    public static bool IsStage(string? path) =>
        !string.IsNullOrWhiteSpace(path) && Path.GetFileName(Path.GetDirectoryName(Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar)))
            is { } parent && string.Equals(parent, FolderName, PathComparison);

    /// <summary>
    /// Creates the hidden <c>.staging</c> folder with its empty <c>.ignore</c> and checks it can be written; the transfer's
    /// own folder is only made when the transfer starts (<see cref="Prepare"/>). Returns the owner-facing error, or null.
    /// </summary>
    public static string? PrepareRoot(string stagingRoot)
    {
        try
        {
            var dir = Directory.CreateDirectory(stagingRoot);
            if (!dir.Attributes.HasFlag(FileAttributes.Hidden)) dir.Attributes |= FileAttributes.Hidden;
            // Empty on purpose: Jellyfin 10.11 reads a .ignore with content as gitignore rules, and skips the whole folder
            // only for an empty one.
            var ignore = Path.Combine(stagingRoot, IgnoreFile);
            if (!File.Exists(ignore) || new FileInfo(ignore).Length > 0) File.WriteAllBytes(ignore, []);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
        {
            return "Cannot write to the download folder. Choose a writable folder or grant TorrentFlow write access to it.";
        }
        return DownloadDirectory.Prepare(stagingRoot);
    }

    /// <summary>Creates a transfer's stage folder when it starts (and its <c>.staging</c> folder). Returns the owner-facing error, or null.</summary>
    public static string? Prepare(string stagePath) =>
        PrepareRoot(Path.GetDirectoryName(Path.GetFullPath(stagePath))!) ?? DownloadDirectory.Prepare(stagePath);

    /// <summary>Deletes a transfer's stage folder and everything in it. Only ever a folder directly under <c>.staging</c>.</summary>
    public static async Task<bool> DeleteAsync(string? stagePath, int attempts = 12, int delayMs = 250)
    {
        if (!IsStage(stagePath)) return false;
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                var dir = new DirectoryInfo(Path.GetFullPath(stagePath!));
                if (!dir.Exists) return true;
                // A link swapped in for the stage folder is removed, never followed.
                if (dir.Attributes.HasFlag(FileAttributes.ReparsePoint)) dir.Delete();
                else dir.Delete(recursive: true);
                return true;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Windows keeps a handle for a moment after the client lets go.
                if (attempt + 1 >= attempts) return false;
                await Task.Delay(delayMs);
            }
        }
    }
}
