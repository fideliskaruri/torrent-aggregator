using System.Collections.Immutable;
using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public sealed partial class LocalFiles(ILibraryRepository repository) : ILocalFiles
{
    [GeneratedRegex("^(?:builtin:)?([0-9a-f]{40})(?::(.+))?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex BuiltinId();

    public LocalFileResult Browse(string? path)
    {
        try
        {
            path = path?.Trim();
            if (path is { Length: > 4096 }) return new(new { error = "path must be at most 4096 characters", field = "path" }, LocalFileError.Invalid);
            if (string.IsNullOrWhiteSpace(path))
            {
                if (OperatingSystem.IsWindows())
                    return new(new Dictionary<string, object?> {
                        ["path"] = "", ["parent"] = null,
                        ["entries"] = DriveInfo.GetDrives().Where(d => d.IsReady)
                            .Select(d => new { name = d.Name.TrimEnd('\\'), path = d.Name, isDirectory = true }).ToArray() });
                path = "/";
            }
            if (path.Contains('\0')) return new(new { error = "Path contains an invalid null character", field = "path" }, LocalFileError.Invalid);
            if (!Path.IsPathFullyQualified(path)) return new(new { error = "Path must be absolute" }, LocalFileError.Invalid);
            var full = Path.GetFullPath(path);
            if (File.Exists(full)) return new(new { error = "Path is not a directory", path = full }, LocalFileError.Invalid);
            if (!Directory.Exists(full)) return new(new { error = "Path not found", path = full }, LocalFileError.Missing);
            var entries = new DirectoryInfo(full)
                .EnumerateDirectories("*", new EnumerationOptions { IgnoreInaccessible = true, AttributesToSkip = 0 })
                .OrderBy(d => d.Name, Comparer<string>.Create((a, b) => CultureInfo.InvariantCulture.CompareInfo.Compare(
                    a, b, CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace)))
                .Select(d => new { name = d.Name, path = d.FullName, isDirectory = true }).ToArray();
            return new(new Dictionary<string, object?> { ["path"] = full,
                ["parent"] = Directory.GetParent(full)?.FullName ?? (OperatingSystem.IsWindows() ? "" : null), ["entries"] = entries });
        }
        catch (UnauthorizedAccessException)
        { return new(new { error = "Cannot read directory", path }, LocalFileError.Forbidden); }
        catch (Exception ex) when (ex is IOException or ArgumentException or NotSupportedException)
        { return new(new { error = "Failed to browse folders", message = "The server could not inspect that location." }, LocalFileError.Failed); }
    }

    public async Task<LocalFileResult> OpenFolderAsync(string? path, string? category, bool reveal, CancellationToken ct)
    {
        var roots = await repository.RootsAsync(ct);
        LibraryKind? kind = category?.Trim().ToLowerInvariant() switch
        {
            "movies" => LibraryKind.Movies, "tv" => LibraryKind.TV,
            "anime" or "anime series" => LibraryKind.Anime, "anime movies" => LibraryKind.AnimeMovies,
            _ => null,
        };
        var root = roots.Where(r => r.Enabled && (kind is null || r.Kinds.Contains(kind.Value)))
            .OrderBy(r => r.Priority).FirstOrDefault();
        var target = path?.Trim();
        if (string.IsNullOrWhiteSpace(target) && root is not null)
        {
            var folder = kind is { } selected ? LibraryPaths.KindFolder(root.LibraryFolders, selected) : "";
            target = Path.Combine(root.Path, folder);
        }
        if (string.IsNullOrWhiteSpace(target))
            return new(new { error = "No folder configured", message = "Set a default download folder or a per-category path in Settings." }, LocalFileError.Invalid);
        if (target.Contains('\0') || !Path.IsPathFullyQualified(target))
            return new(new { error = "Path must be absolute", message = $"Got: {target}" }, LocalFileError.Invalid);
        string full;
        try { full = Path.GetFullPath(target); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        { return new(new { error = "Path must be absolute", message = $"Got: {target}" }, LocalFileError.Invalid); }
        if (!roots.Any(r => Within(full, r.Path)))
            return new(new { ok = false, error = "Path is outside your download folders", pathOnly = full,
                message = "TorrentFlow only opens folders inside your configured download locations. Add this location in Settings first." }, LocalFileError.Forbidden);
        var folderPath = full;
        if (!Directory.Exists(full) && !File.Exists(full))
        {
            var parent = Path.GetDirectoryName(full);
            if (parent is not null && Directory.Exists(parent) && roots.Any(r => Within(parent, r.Path))) folderPath = parent;
            else return new(new { ok = false, error = "Folder not found on this machine", path = full, pathOnly = full,
                message = "The path must exist on the server running TorrentFlow. If your torrent client is remote/Docker, open the folder on that host instead." }, LocalFileError.Missing);
        }
        // A configured lexical path must not launch a folder outside the root through a junction.
        if (HasLink(folderPath))
            return new(new { ok = false, error = "Links and junctions are not followed.", pathOnly = full }, LocalFileError.Forbidden);
        reveal &= Environment.GetEnvironmentVariable("PLAYWRIGHT_NO_REVEAL") != "1";
        // Old server (FoldersController.Open): missing child under an in-root parent opens the parent
        // but still answers 200 with path/message naming the requested path. Web Open folder on
        // not-yet-created category folders (Downloads/Settings) depends on that ok:true success.
        if (!reveal) return new(new { ok = true, path = full, message = $"Verified folder {full}", revealed = false });
        try
        {
            var info = new ProcessStartInfo(OperatingSystem.IsWindows() ? "explorer.exe" : OperatingSystem.IsMacOS() ? "open" : "xdg-open")
            { UseShellExecute = false };
            info.ArgumentList.Add(folderPath);
            using var process = Process.Start(info);
            return new(new { ok = true, path = full, message = $"Opened {full}", revealed = true });
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or PlatformNotSupportedException)
        { return new(new { ok = false, path = full, error = "Could not open folder",
            message = "The server could not launch its file manager.", pathOnly = full }, LocalFileError.Failed); }
    }

    public async Task<LocalFileResult> OpenDownloadAsync(string id, string mode, CancellationToken ct)
    {
        id = id.Trim();
        if (id.StartsWith("qbittorrent:", StringComparison.OrdinalIgnoreCase) || id.StartsWith("transmission:", StringComparison.OrdinalIgnoreCase))
            return Refuse(LocalFileError.Conflict, "other-client", "This download belongs to another torrent app.", "Open it from that app instead.");
        var match = BuiltinId().Match(id);
        if (!match.Success) return Refuse(LocalFileError.Invalid, "invalid-id", "That is not a download id.", "Reload the page and try again.");
        var hash = match.Groups[1].Value.ToLowerInvariant();
        var download = await repository.DownloadAsync(hash, ct);
        if (download is null) return Refuse(LocalFileError.Missing, "not-found", "That download is no longer in TorrentFlow.", "Reload the page.");
        if (download.FinishedAt is null)
            return Refuse(LocalFileError.Conflict, "not-finished", "This download hasn't finished yet.", "Wait until it finishes, then try again.");
        var bindings = await repository.BindingsAsync(ct);
        var media = await repository.MediaAsync(null, ct);
        var targetId = match.Groups[2].Success ? match.Groups[2].Value : null;
        string? full;
        if (targetId is null)
        {
            var video = bindings.Where(f => f.DownloadId == download.Id && f.Filed && f.Role == FileRole.Video)
                .Join(media.Where(m => m.Role == FileRole.Video), f => f.MediaFileId, m => m.Id, (_, m) => m)
                .OrderByDescending(m => m.Bytes).ThenBy(m => m.Id, StringComparer.Ordinal).FirstOrDefault();
            full = video?.Path;
        }
        else
        {
            var boundVideo = bindings.Where(f => f.DownloadId == download.Id && f.TargetId == targetId &&
                    f.Filed && f.Role == FileRole.Video)
                .OrderByDescending(f => f.ExpectedBytes).ThenBy(f => f.FileIndex).FirstOrDefault();
            full = boundVideo?.MediaFileId is { } mediaId
                ? media.FirstOrDefault(m => m.Id == mediaId && m.Role == FileRole.Video)?.Path ?? boundVideo.FinalPath
                : boundVideo?.FinalPath;
        }
        if (full is null) return Refuse(LocalFileError.Conflict, "no-video", "This download has no video file to open.", "Show it in its folder instead.");
        var roots = await repository.RootsAsync(ct);
        var verified = VerifyVideo(full, roots);
        if (verified is not null) return verified;
        full = Path.GetFullPath(full);
        var launched = Environment.GetEnvironmentVariable("PLAYWRIGHT_NO_REVEAL") != "1";
        if (launched)
        {
            if (VerifyVideo(full, roots) is { } changed) return changed;
            try { using var process = Process.Start(StartInfo(full, mode)); }
            catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or PlatformNotSupportedException)
            { return Refuse(LocalFileError.Failed, "launch-failed", mode == "reveal" ? "The file manager could not be started." : "No app could open this file.",
                mode == "reveal" ? "Copy the path and open it yourself." : "Install a video player, or show the file in its folder."); }
        }
        return new(new { ok = true, mode, fileName = Path.GetFileName(full), path = full, launched });
    }

    private static LocalFileResult? VerifyVideo(string path, ImmutableArray<StorageRootRow> roots)
    {
        if (path.Contains('\0') || !Path.IsPathFullyQualified(path)) return Outside();
        string full;
        try { full = Path.GetFullPath(path); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { return Outside(); }
        var containing = roots.Where(r => Within(full, r.Path)).ToArray();
        if (containing.Length == 0 || containing.Any(r => Path.GetFullPath(r.Path).TrimEnd(Path.DirectorySeparatorChar)
            .Equals(full, StringComparison.OrdinalIgnoreCase))) return Outside();
        if (HasLink(full)) return Refuse(LocalFileError.Forbidden, "link",
            "This file is behind a link or shortcut folder, so TorrentFlow won't open it.", "Open it from its real folder yourself.");
        if (!File.Exists(full)) return Refuse(LocalFileError.Gone, "files-missing", "This file isn't on disk any more.",
            "It was deleted or moved outside TorrentFlow. Delete the download, or download it again.");
        return null;
    }

    private static bool Within(string path, string root)
    {
        return LibraryPaths.PhysicalKey(path) == LibraryPaths.PhysicalKey(root) || LibraryPaths.IsInside(root, path);
    }

    private static bool HasLink(string full)
    {
        try
        {
            LibraryPaths.NoLinks(full);
            return false;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { return true; }
    }

    private static LocalFileResult Outside() => Refuse(LocalFileError.Forbidden, "outside-folders",
        "This file is outside your download folders.", "TorrentFlow only opens files inside the download folders in Settings.");
    private static LocalFileResult Refuse(LocalFileError errorKind, string reason, string error, string message) =>
        new(new { ok = false, reason, error, message }, errorKind);

    private static ProcessStartInfo StartInfo(string full, string mode)
    {
        if (OperatingSystem.IsWindows()) return mode == "reveal"
            ? new ProcessStartInfo("explorer.exe", $"/select,\"{full}\"") { UseShellExecute = false }
            : new ProcessStartInfo(full) { UseShellExecute = true };
        var info = new ProcessStartInfo(OperatingSystem.IsMacOS() ? "open" : "xdg-open") { UseShellExecute = false };
        if (OperatingSystem.IsMacOS() && mode == "reveal") info.ArgumentList.Add("-R");
        info.ArgumentList.Add(!OperatingSystem.IsMacOS() && mode == "reveal" ? Path.GetDirectoryName(full)! : full);
        return info;
    }
}
