using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data;
using TorrentFlow.Engine.Settings;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine.Controllers;

[ApiController]
public sealed class FoldersController(ClientSettingsStore store, TorrentFlowDbContext db, StorageBudget storage, RetentionSweeper sweeper) : ControllerBase
{
    [HttpGet("api/settings/browse-folders")]
    public IActionResult Browse([FromQuery] string? path)
    {
        try
        {
            if (path is { Length: > 4096 }) return BadRequest(new { error = "Invalid path" });
            if (string.IsNullOrWhiteSpace(path))
            {
                if (OperatingSystem.IsWindows())
                    return Ok(new
                    {
                        path = "",
                        parent = (string?)null,
                        entries = DriveInfo.GetDrives().Where(d => d.IsReady)
                            .Select(d => new { name = d.Name.TrimEnd('\\'), path = d.Name, isDirectory = true }).ToList(),
                    }.WithNullParent());
                path = "/";
            }
            if (path.Contains('\0')) return BadRequest(new { error = "Path contains an invalid null character", field = "path" });
            if (!Path.IsPathFullyQualified(path)) return BadRequest(new { error = "Path must be absolute" });
            var full = Path.GetFullPath(path);
            if (System.IO.File.Exists(full)) return BadRequest(new { error = "Path is not a directory", path = full });
            if (!Directory.Exists(full)) return NotFound(new { error = "Path not found", path = full });
            List<object> entries;
            try
            {
                entries = new DirectoryInfo(full)
                    .EnumerateDirectories("*", new EnumerationOptions { IgnoreInaccessible = true, AttributesToSkip = FileAttributes.System })
                    .OrderBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
                    .Select(d => (object)new { name = d.Name, path = d.FullName, isDirectory = true }).ToList();
            }
            catch (UnauthorizedAccessException) { return StatusCode(403, new { error = "Cannot read directory", path = full }); }
            return Ok(new Dictionary<string, object?> { ["path"] = full, ["parent"] = Directory.GetParent(full)?.FullName, ["entries"] = entries });
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or NotSupportedException)
        {
            return StatusCode(500, new { error = "Failed to browse folders", message = "The server could not inspect that location." });
        }
    }

    [HttpPost("api/settings/open-folder")]
    public async Task<IActionResult> Open(CancellationToken ct)
    {
        if (await JsonBody.ReadAsync(Request, ct) is not { } body) return JsonBody.InvalidJson();
        var config = await store.GetConfigAsync(ct);
        var reveal = body.Bool("reveal") ?? true;
        var target = body.Str("path") is { Length: > 0 } p ? p : ClientSettingsStore.ResolveDownloadTarget(config, body.Str("category"), null).SavePath;
        if (string.IsNullOrWhiteSpace(target)) return BadRequest(new { ok = false, error = "No download folder configured", message = "Choose a download folder in Settings first." });
        if (target.Contains('\0') || !Path.IsPathFullyQualified(target)) return BadRequest(new { ok = false, error = "Path must be absolute", message = "Path must be absolute." });
        var full = Path.GetFullPath(target);
        if (!LibraryRoots(config).Any(root => IsWithin(full, root)))
            return StatusCode(403, new
            {
                ok = false, error = "Path is outside your download folders", pathOnly = full,
                message = "TorrentFlow only opens folders inside your configured download locations. Add this location in Settings first.",
            });
        if (!Directory.Exists(full)) return NotFound(new { ok = false, path = full, error = "Folder not found", message = $"{full} does not exist yet." });
        if (!reveal) return Ok(new { ok = true, path = full, message = $"Verified folder {full}", revealed = false });
        try
        {
            var psi = OperatingSystem.IsWindows() ? new ProcessStartInfo("explorer.exe", $"\"{full}\"")
                : OperatingSystem.IsMacOS() ? new ProcessStartInfo("open", full) : new ProcessStartInfo("xdg-open", full);
            psi.UseShellExecute = false;
            using var _ = Process.Start(psi);
            return Ok(new { ok = true, path = full, message = $"Opened {full}", revealed = true });
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return StatusCode(500, new { ok = false, path = full, error = "Could not open folder", message = "The server could not launch its file manager.", pathOnly = full });
        }
    }

    internal static IEnumerable<string> LibraryRoots(ClientConfig c) =>
        new[] { c.BaseDownloadPath, c.SavePath }.Concat(c.PathRules.Values)
            .Where(p => !string.IsNullOrWhiteSpace(p) && Path.IsPathFullyQualified(p!)).Select(p => Path.GetFullPath(p!));

    internal static bool IsWithin(string path, string root)
    {
        var r = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var cmp = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        return path.Equals(r, cmp) || path.StartsWith(r + Path.DirectorySeparatorChar, cmp);
    }

    /// <summary>True when any existing directory strictly between <paramref name="root"/> and <paramref name="full"/> is a reparse point.</summary>
    internal static bool HasLinkBetween(string root, string full)
    {
        var r = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        for (var dir = Path.GetDirectoryName(full); dir is not null && dir.Length > r.Length; dir = Path.GetDirectoryName(dir))
        {
            try
            {
                var info = new DirectoryInfo(dir);
                if (info.Exists && info.Attributes.HasFlag(FileAttributes.ReparsePoint)) return true;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return true; }
        }
        return false;
    }

    [HttpPost("api/settings/untracked-files")]
    public async Task<IActionResult> DeleteUntracked(CancellationToken ct)
    {
        if (await JsonBody.ReadAsync(Request, ct) is not { } body) return JsonBody.InvalidJson();
        IActionResult Refuse(int status, string reason, string message) =>
            StatusCode(status, new { ok = false, error = "Refused to remove that entry", message, reason });

        var rel = body.Str("relativePath")?.Trim();
        if (string.IsNullOrEmpty(rel))
            return BadRequest(new { ok = false, error = "No entry named", message = "Name the untracked file or folder to remove.", reason = "empty-path" });
        if (rel.Length > 4096 || rel.Contains('\0') || Path.IsPathRooted(rel)) return Refuse(403, "outside-root", "That path is not inside the download folder.");
        var config = await store.GetConfigAsync(ct);
        if (config.DownloadRoot is not { } rootRaw) return BadRequest(new { ok = false, error = "No download folder configured" });
        var root = Path.GetFullPath(rootRaw);
        var full = Path.GetFullPath(Path.Combine(root, rel));
        if (!IsWithin(full, root) || full.TrimEnd(Path.DirectorySeparatorChar).Equals(root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            return Refuse(403, "outside-root", "That path is not inside the download folder.");
        // A junction or symlink between the root and the entry would point the delete at another folder entirely.
        if (HasLinkBetween(root, full)) return Refuse(403, "symlink", "Links and junctions are not followed.");
        if (Path.GetFileName(full).StartsWith('.')) return Refuse(403, "internal", "App bookkeeping files cannot be removed here.");
        var isDir = Directory.Exists(full);
        if (!isDir && !System.IO.File.Exists(full)) return Refuse(404, "missing", "That entry no longer exists.");
        var attrs = System.IO.File.GetAttributes(full);
        if (attrs.HasFlag(FileAttributes.ReparsePoint)) return Refuse(403, "symlink", "Links and junctions are not removed.");

        // Tracked = inside any live or recorded release. Refuse rather than orphan a transfer.
        var rows = await db.EngineTorrents.AsNoTracking().Where(r => r.UserId == LocalUser.Id).ToListAsync(ct);
        foreach (var row in rows)
        {
            var files = TorrentEngineService.VerifiedFiles(row).Select(f => f.FullPath).Where(p => p is not null).Select(p => Path.GetFullPath(p!)).ToList();
            if (files.Any(f => f.Equals(full, StringComparison.OrdinalIgnoreCase))) return Refuse(409, "tracked", "That file belongs to a download.");
            if (isDir && files.Any(f => IsWithin(f, full))) return Refuse(409, "contains-tracked", "That folder contains a download's files.");
            if (row.Status is not "parked" && !string.IsNullOrEmpty(row.SavePath) && isDir && IsWithin(Path.GetFullPath(row.SavePath), full))
                return Refuse(409, "incomplete", "A transfer is still writing into that folder.");
        }

        long bytes = 0; var count = 0;
        try
        {
            if (isDir)
            {
                foreach (var f in new DirectoryInfo(full).EnumerateFiles("*", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint }))
                { bytes += f.Length; count++; }
                Directory.Delete(full, recursive: true);
            }
            else
            {
                bytes = new FileInfo(full).Length; count = 1;
                System.IO.File.Delete(full);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return StatusCode(500, new { ok = false, error = "Could not remove that entry", message = "The server could not remove that entry.", reason = "delete-failed" });
        }
        storage.ResetDirectorySizeCache();
        return Ok(new
        {
            ok = true,
            deleted = new { relativePath = rel, kind = isDir ? "directory" : "file", bytes, fileCount = count },
            usage = new { diskBytes = storage.DirectorySize(root).Bytes },
        });
    }

    [HttpPost("api/settings/retention-sweep")]
    public async Task<IActionResult> Sweep(CancellationToken ct)
    {
        if (await JsonBody.ReadAsync(Request, ct) is not { } body) return JsonBody.InvalidJson();
        var mode = body.Str("mode");
        if (mode is not ("preview" or "delete")) return BadRequest(new { error = "mode must be preview or delete" });
        var budget = body.Num("budgetBytes");
        if (budget is { } b && (b < 1 || b > 9007199254740991 || b != Math.Floor(b))) return BadRequest(new { error = "budgetBytes must be a positive integer" });
        var config = await store.GetConfigAsync(ct);
        if (config.MaxStorageBytes is not { } cap)
            return StatusCode(409, new { error = "Storage setup required", message = StorageBudget.SetupRequiredMessage });
        try
        {
            var result = await sweeper.SweepAsync(mode, budget is { } bb ? (long)bb : cap / 4, ct);
            storage.ResetDirectorySizeCache();
            var disk = config.DownloadRoot is { } root ? storage.DirectorySize(root).Bytes : (long?)null;
            return Ok(new { ok = true, result, usage = new { diskBytes = disk, maxStorageBytes = cap } });
        }
        catch (Exception ex) when (ex is IOException or DbUpdateException)
        {
            return StatusCode(500, new { error = "Failed to run retention sweep", message = "The retention sweep failed. Check the server logs for details." });
        }
    }
}

internal static class AnonymousExtensions
{
    /// <summary>The Next.js route returns an explicit <c>parent: null</c> for the drive list.</summary>
    public static Dictionary<string, object?> WithNullParent<T>(this T value) where T : class
    {
        var dict = typeof(T).GetProperties().ToDictionary(p => p.Name, p => p.GetValue(value));
        dict["parent"] = null;
        return dict;
    }
}
