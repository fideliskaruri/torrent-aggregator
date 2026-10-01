using System.Text.RegularExpressions;

namespace TorrentFlow.Core;

/// <summary>Why a release's files cannot be a video download.</summary>
public enum MediaFileProblem
{
    /// <summary>A program or script anywhere in the release (exe, scr, lnk, or a double extension such as .mkv.exe).</summary>
    Dangerous,
    /// <summary>Only archives or disc images, and no video.</summary>
    ArchiveOnly,
    /// <summary>No video file at all.</summary>
    NoVideo,
}

/// <summary>
/// The one file-name rule set for what a download may hold (docs/api-open-file.md, "Checking downloads"). It runs on a
/// release's file list as soon as that list is known, before anything downloads, and again on the finished files,
/// which then also get their content checked. Search filters and the season pack mapping use the same lists.
/// </summary>
public static class MediaFileRules
{
    public const string DangerousMessage = "This release has a program file in it, so TorrentFlow didn't download it.";
    public const string NoVideoMessage = "This release has no video file in it, so TorrentFlow didn't download it.";

    private const RegexOptions Options = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;

    private static readonly Regex VideoName = new(@"\.(?:mkv|mp4|avi|m4v|mov|wmv|flv|webm|ts|m2ts|mpg|mpeg|vob)$", Options);

    // Only the last extension counts, so movie.mkv.exe is a program.
    private static readonly Regex ProgramName = new(
        @"\.(?:exe|msi|msp|bat|cmd|com|scr|pif|lnk|vbs|vbe|js|jse|wsf|wsh|ps1|psm1|hta|cpl|jar|apk|dll|sys|reg)$", Options);

    private static readonly Regex ArchiveName = new(@"\.(?:rar|r\d{2}|zip|7z|\d{3}|tar|gz|tgz|bz2|xz|iso|img)$", Options);

    /// <summary>A file name the app treats as video.</summary>
    public static bool IsVideo(string path) => VideoName.IsMatch(path.Replace('\\', '/'));

    /// <summary>
    /// A program or script. Trailing dots and spaces are ignored because Windows drops them when it writes the file,
    /// so <c>setup.exe.</c> lands on disk as <c>setup.exe</c>.
    /// </summary>
    public static bool IsDangerous(string path) => ProgramName.IsMatch(path.TrimEnd('.', ' '));

    /// <summary>An archive, a split archive part or a disc image.</summary>
    public static bool IsArchive(string path) => ArchiveName.IsMatch(path.TrimEnd('.', ' '));

    /// <summary>
    /// The file-list rules. Every file of the release is checked for programs; the video rules look only at the files
    /// that will be kept (<paramref name="kept"/>, or every file when null), so a season pack's skipped files never
    /// count. Null when the list is fine.
    /// </summary>
    public static MediaFileProblem? Check(IEnumerable<string> all, IEnumerable<string>? kept = null)
    {
        var files = all.ToList();
        if (files.Any(IsDangerous)) return MediaFileProblem.Dangerous;
        var keep = kept?.ToList() ?? files;
        if (keep.Any(IsVideo)) return null;
        return keep.Any(IsArchive) ? MediaFileProblem.ArchiveOnly : MediaFileProblem.NoVideo;
    }

    /// <summary>What the owner reads when a release is refused by its file list.</summary>
    public static string Message(MediaFileProblem problem) => problem == MediaFileProblem.Dangerous ? DangerousMessage : NoVideoMessage;

    /// <summary>The add-result code: dangerous | no_video.</summary>
    public static string Code(MediaFileProblem problem) => problem == MediaFileProblem.Dangerous ? "dangerous" : "no_video";
}
