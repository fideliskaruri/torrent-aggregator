using TorrentFlow.Engine.Controllers;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Engine.Storage;

/// <summary>
/// The one path resolver for staged downloads (docs/english-gates-plan.md section 1). A transfer's payload is written to
/// <c>&lt;download root&gt;\.staging\&lt;hash&gt;</c>, on the same volume as its final path and outside every library
/// folder, so promotion is always a rename and Jellyfin never sees a file before the gate. When the final path is on
/// another volume, the stage is a <c>.staging</c> folder on that volume next to the library root that holds it. The
/// <c>.staging</c> folder is hidden and carries a <c>.ignore</c> file, so Jellyfin skips it even inside a library.
/// </summary>
internal static class StagePaths
{
    public const string FolderName = ".staging";
    private const string IgnoreFile = ".ignore";

    private static StringComparison PathComparison => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    /// <summary>The stage folder for a transfer whose files are promoted into <paramref name="finalPath"/>.</summary>
    public static string For(string finalPath, ClientConfig config, string hash) =>
        Path.Combine(StagingRoot(finalPath, config), hash.ToLowerInvariant());

    /// <summary>The <c>.staging</c> folder on <paramref name="finalPath"/>'s volume.</summary>
    public static string StagingRoot(string finalPath, ClientConfig config)
    {
        var final = Path.GetFullPath(finalPath);
        if (config.DownloadRoot is { } root && SameVolume(root, final)) return Path.Combine(Path.GetFullPath(root), FolderName);
        var library = FoldersController.LibraryRoots(config).Where(r => SameVolume(r, final) && FoldersController.IsWithin(final, r))
            .OrderByDescending(r => r.Length).FirstOrDefault();
        var anchor = library is null ? Path.GetPathRoot(final)! : Path.GetDirectoryName(library.TrimEnd(Path.DirectorySeparatorChar)) ?? library;
        return Path.Combine(anchor, FolderName);
    }

    /// <summary>Every <c>.staging</c> folder in use outside the download root, so the storage cap counts them once.</summary>
    public static IReadOnlyList<string> OutsideRoot(IEnumerable<string?> stagePaths, string? downloadRoot) =>
        stagePaths.OfType<string>().Select(p => Path.GetDirectoryName(Path.GetFullPath(p))).OfType<string>()
            .Where(r => downloadRoot is null || !FoldersController.IsWithin(r, Path.GetFullPath(downloadRoot)))
            .Distinct(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal).ToList();

    public static bool SameVolume(string a, string b) =>
        string.Equals(Path.GetPathRoot(Path.GetFullPath(a)), Path.GetPathRoot(Path.GetFullPath(b)), PathComparison);

    /// <summary>True for a transfer's own folder directly under a <c>.staging</c> folder.</summary>
    public static bool IsStage(string? path) =>
        !string.IsNullOrWhiteSpace(path) && Path.GetFileName(Path.GetDirectoryName(Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar)))
            is { } parent && string.Equals(parent, FolderName, PathComparison);

    /// <summary>
    /// Creates the stage folder (and the hidden <c>.staging</c> folder with its <c>.ignore</c>) and checks it can be written.
    /// Returns the owner-facing error, or null.
    /// </summary>
    public static string? Prepare(string stagePath)
    {
        try
        {
            var staging = Path.GetDirectoryName(Path.GetFullPath(stagePath))!;
            var dir = Directory.CreateDirectory(staging);
            if (!dir.Attributes.HasFlag(FileAttributes.Hidden)) dir.Attributes |= FileAttributes.Hidden;
            var ignore = Path.Combine(staging, IgnoreFile);
            if (!File.Exists(ignore))
                File.WriteAllText(ignore, "TorrentFlow keeps downloads here until they are checked and moved into your library.\n");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
        {
            return "Cannot write to the download folder. Choose a writable folder or grant TorrentFlow write access to it.";
        }
        return DownloadDirectory.Prepare(stagePath);
    }

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
