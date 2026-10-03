using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public static class LibraryPaths
{
    public static readonly LibraryFolders DefaultFolders = new("Movies", "TV", "Anime Series", "Anime Movies");
    private static readonly TimeSpan Timeout = TimeSpan.FromMilliseconds(100);

    public static string SafeTitle(string title, string workId)
    {
        var clean = Regex.Replace(title, @"[<>:""/\\|?*\x00-\x1f]", " ", RegexOptions.None, Timeout);
        clean = Regex.Replace(clean, @"\s+", " ", RegexOptions.None, Timeout).Trim().TrimEnd('.', ' ');
        if (clean.Length > 120) clean = clean[..(char.IsHighSurrogate(clean[119]) ? 119 : 120)].Trim().TrimEnd('.', ' ');
        return Guard(clean.Length == 0 ? "work-" + ShortId(workId) : clean);
    }

    public static string SafeLeaf(string leaf)
    {
        var clean = Regex.Replace(leaf, @"[<>:""/\\|?*\x00-\x1f]", "", RegexOptions.None, Timeout).TrimEnd('.', ' ');
        return Guard(clean.Length == 0 ? "unnamed" : clean);
    }

    private static string Guard(string name) =>
        Regex.IsMatch(name, @"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, Timeout) ? "_" + name : name;

    private static string ShortId(string value) =>
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..12].ToLowerInvariant();

    public static string ItemFolder(string title, string workId, int? year, bool film)
    {
        var name = SafeTitle(title, workId);
        return film && year is >= 1870 and <= 2100 && !name.Contains($"({year})", StringComparison.Ordinal)
            ? $"{name} ({year})" : name;
    }

    public static string KindFolder(LibraryFolders folders, LibraryKind kind) => kind switch
    {
        LibraryKind.Movies => folders.Movies, LibraryKind.TV => folders.TV,
        LibraryKind.Anime => folders.Anime, _ => folders.AnimeMovies,
    };

    public static string PhysicalKey(string path) =>
        OperatingSystem.IsWindows() ? Path.GetFullPath(path).TrimEnd('\\').ToLowerInvariant() : Path.GetFullPath(path).TrimEnd('/');

    public static string Within(string root, string relative)
    {
        if (Path.IsPathRooted(relative) || relative.Split('/', '\\').Any(s => s is "." or ".."))
            throw new ArgumentException("Choose a relative folder without parent-directory segments.");
        if (relative.Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries).Any(s => SafeLeaf(s) != s))
            throw new ArgumentException("The path contains an illegal or reserved folder name.");
        var result = Path.GetFullPath(Path.Combine(root, relative));
        if (!IsInside(root, result)) throw new ArgumentException("The folder is outside its storage root.");
        NoLinks(result);
        if (result.Length > (OperatingSystem.IsWindows() ? 32700 : 4096) ||
            relative.Split('/', '\\').Any(s => s.Length > 240))
            throw new ArgumentException("The path is too long. Shorten the file or folder name.");
        return result;
    }

    public static bool IsInside(string root, string path)
    {
        var relative = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(path));
        return relative != "." && !Path.IsPathRooted(relative) && relative != ".." &&
            !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal);
    }

    public static void NoLinks(string path)
    {
        for (var current = new DirectoryInfo(Path.GetFullPath(path)); current is not null; current = current.Parent)
            if ((current.Exists || File.Exists(current.FullName)) &&
                (File.GetAttributes(current.FullName) & FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("Linked folders and files cannot be used as library paths.");
    }

    public static string Volume(string path)
    {
        var root = Path.GetPathRoot(Path.GetFullPath(path))!;
        if (OperatingSystem.IsWindows())
        {
            var volumePath = new StringBuilder(32768);
            if (!GetVolumePathName(Path.GetFullPath(path), volumePath, volumePath.Capacity) ||
                !GetVolumeInformation(volumePath.ToString(), null, 0, out var serial, out _, out _, null, 0))
                throw new IOException("The drive cannot be read.");
            return serial.ToString("x8", System.Globalization.CultureInfo.InvariantCulture);
        }
        var drive = new DriveInfo(root);
        return drive.Name + ":" + drive.DriveFormat;
    }

    public static long FreeBytes(string path)
    {
        if (!OperatingSystem.IsWindows()) return new DriveInfo(Path.GetPathRoot(Path.GetFullPath(path))!).AvailableFreeSpace;
        if (!GetDiskFreeSpaceEx(Path.GetFullPath(path), out var available, out _, out _) || available > long.MaxValue)
            throw new IOException("The drive's available space cannot be read.");
        return (long)available;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumePathName(string path, StringBuilder volumePath, int size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetDiskFreeSpaceEx(string path, out ulong available, out ulong total, out ulong free);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumeInformation(string root, StringBuilder? name, int nameSize,
        out uint serial, out uint maximumLength, out uint flags, StringBuilder? fileSystemName, int fileSystemNameSize);
}
