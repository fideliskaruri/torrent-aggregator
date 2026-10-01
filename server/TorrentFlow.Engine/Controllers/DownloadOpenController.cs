using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Engine.Controllers;

/// <summary>
/// Opens a finished built-in download's video in the owner's own player, or shows it in the file manager
/// (docs/api-open-file.md). Owner only, on the computer running TorrentFlow; the file is taken from the download's own
/// recorded file list, never from the request.
/// </summary>
[ApiController]
public sealed partial class DownloadOpenController(ClientSettingsStore store, TorrentFlowDbContext db, ILogger<DownloadOpenController> logger)
    : ControllerBase
{
    [GeneratedRegex("^(?:builtin:)?([0-9a-f]{40})$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex BuiltinId();

    [HttpPost("api/downloads/{transferId}/open")]
    public async Task<IActionResult> Open(string transferId, CancellationToken ct)
    {
        // Claims set by the remote access middleware (Api); read by name because this module cannot reference it.
        if (User.FindFirst("tf:role")?.Value == "requester")
            return StatusCode(403, new { ok = false, reason = "requester", code = "requester_forbidden",
                error = "This part of TorrentFlow is only available to its owner.", message = "This part of TorrentFlow is only available to its owner." });
        if (User.FindFirst("tf:via")?.Value == "tunnel")
            return Refuse(409, "remote", "Files can't be opened through remote access.",
                "Open the file on the computer running TorrentFlow, or copy its path.", openFolderDisabled: true);
        if (store.RunningInContainer)
            return Refuse(409, "container", "Files can't be opened while TorrentFlow runs in a container.",
                "Open the mapped media folder on your computer instead.", openFolderDisabled: true);

        var mode = "open";
        if (Request.ContentLength != 0)
        {
            if (await JsonBody.ReadAsync(Request, ct) is not { } body) return JsonBody.InvalidJson();
            if (body.Has("mode") && !body.IsNull("mode"))
            {
                if (body.Str("mode")?.Trim().ToLowerInvariant() is not ({ } m and ("open" or "reveal")))
                    return BadRequest(new { ok = false, reason = "invalid-mode", field = "mode",
                        error = "mode must be \"open\" or \"reveal\"", message = "Choose open or show in folder." });
                mode = m;
            }
        }

        var id = (transferId ?? "").Trim();
        if (id.StartsWith("qbittorrent:", StringComparison.OrdinalIgnoreCase) || id.StartsWith("transmission:", StringComparison.OrdinalIgnoreCase))
            return Refuse(409, "other-client", "This download belongs to another torrent app.", "Open it from that app instead.");
        if (BuiltinId().Match(id) is not { Success: true } match)
            return BadRequest(new { ok = false, reason = "invalid-id", error = "That is not a download id.", message = "Reload the page and try again." });
        var hash = match.Groups[1].Value.ToLowerInvariant();

        var row = await db.EngineTorrents.AsNoTracking()
            .FirstOrDefaultAsync(r => r.UserId == LocalUser.Id && r.Hash == hash && r.Status != EngineTorrentStatus.Removed, ct);
        if (row is null) return Refuse(404, "not-found", "That download is no longer in TorrentFlow.", "Reload the page.");
        // A failed row's own error already says why and what to do (delete it, or press Retry to check it again).
        if (string.Equals(row.Status, EngineTorrentStatus.Error, StringComparison.OrdinalIgnoreCase))
            return Refuse(409, "not-finished", "This download failed, so there's nothing to open.",
                string.IsNullOrWhiteSpace(row.Error) ? "Delete it, or find another source." : row.Error);
        if (!TorrentEngineService.IsDownloaded(row))
            return Refuse(409, "not-finished", "This download hasn't finished yet.", "Wait until it finishes, then try again.");

        var video = TorrentEngineService.VerifiedFiles(row)
            .Where(f => f.FullPath is { Length: > 0 } p && MediaFileRules.IsVideo(p))
            .OrderByDescending(f => f.Size).FirstOrDefault();
        if (video is null) return Refuse(409, "no-video", "This download has no video file to open.", "Show it in its folder instead.");

        var config = await store.GetConfigAsync(ct);
        var roots = FoldersController.LibraryRoots(config).ToList();
        string full;
        try
        {
            if (!Path.IsPathFullyQualified(video.FullPath!) || video.FullPath!.Contains('\0')) return OutsideFolders();
            full = Path.GetFullPath(video.FullPath!);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return OutsideFolders();
        }
        if (Verify(full, roots) is { } refused) return refused;

        var launched = Environment.GetEnvironmentVariable("PLAYWRIGHT_NO_REVEAL") != "1";
        if (launched)
        {
            // The file could have been swapped for a link since the first check; look once more right before starting.
            if (Verify(full, roots) is { } changed) return changed;
            try
            {
                using var process = Process.Start(StartInfo(full, mode));
            }
            catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or PlatformNotSupportedException)
            {
                logger.LogWarning(ex, "Could not {Mode} {Path}", mode, full);
                return Refuse(500, "launch-failed", mode == "reveal" ? "The file manager could not be started." : "No app could open this file.",
                    mode == "reveal" ? "Copy the path and open it yourself." : "Install a video player, or show the file in its folder.");
            }
        }
        logger.LogInformation("[downloads] {Mode} {Path} (launched: {Launched})", mode, full, launched);
        return Ok(new { ok = true, mode, fileName = Path.GetFileName(full), path = full, launched });
    }

    /// <summary>
    /// The file must be inside a download folder from Settings, with no link on the way and not be a link itself, and
    /// still be on disk. Null when it may be opened.
    /// </summary>
    private IActionResult? Verify(string full, IReadOnlyList<string> roots)
    {
        var containing = roots.Where(root => FoldersController.IsWithin(full, root)).ToList();
        if (containing.Count == 0 || containing.Any(root => string.Equals(root.TrimEnd(Path.DirectorySeparatorChar), full, StringComparison.OrdinalIgnoreCase)))
            return OutsideFolders();
        try
        {
            if (containing.Any(root => FoldersController.HasLinkBetween(root, full))) return Link();
            var info = new FileInfo(full);
            if (info.Exists && (info.Attributes.HasFlag(FileAttributes.ReparsePoint) || info.LinkTarget is not null)) return Link();
            if (!info.Exists) return Refuse(410, "files-missing", "This file isn't on disk any more.",
                "It was deleted or moved outside TorrentFlow. Delete the download, or download it again.");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Link();
        }
        return null;
    }

    private ObjectResult OutsideFolders() => Refuse(403, "outside-folders", "This file is outside your download folders.",
        "TorrentFlow only opens files inside the download folders in Settings.");

    private ObjectResult Link() => Refuse(403, "link", "This file is behind a link or shortcut folder, so TorrentFlow won't open it.",
        "Open it from its real folder yourself.");

    private ObjectResult Refuse(int status, string reason, string error, string message, bool openFolderDisabled = false) =>
        StatusCode(status, openFolderDisabled
            ? new { ok = false, reason, error, message, openFolderDisabled = true }
            : (object)new { ok = false, reason, error, message });

    /// <summary>No shell parses the path: it is passed as one argument (open) or a quoted select (Windows reveal).</summary>
    private static ProcessStartInfo StartInfo(string full, string mode)
    {
        if (OperatingSystem.IsWindows())
            // Windows paths cannot contain quotes, so the quoted path is one argument to Explorer.
            return mode == "reveal"
                ? new ProcessStartInfo("explorer.exe", $"/select,\"{full}\"") { UseShellExecute = false }
                : new ProcessStartInfo(full) { UseShellExecute = true };
        var psi = new ProcessStartInfo(OperatingSystem.IsMacOS() ? "open" : "xdg-open") { UseShellExecute = false };
        if (OperatingSystem.IsMacOS())
        {
            if (mode == "reveal") psi.ArgumentList.Add("-R");
            psi.ArgumentList.Add(full);
        }
        else psi.ArgumentList.Add(mode == "reveal" ? Path.GetDirectoryName(full)! : full);
        return psi;
    }
}
