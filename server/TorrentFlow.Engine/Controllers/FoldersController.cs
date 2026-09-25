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
            path = path?.Trim();
            if (path is { Length: > 4096 }) return BadRequest(new { error = "path must be at most 4096 characters", field = "path" });
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
                    .EnumerateDirectories("*", new EnumerationOptions { IgnoreInaccessible = true, AttributesToSkip = 0 })
                    .OrderBy(d => d.Name, Comparer<string>.Create((a, b) => System.Globalization.CultureInfo.InvariantCulture.CompareInfo.Compare(
                        a, b, System.Globalization.CompareOptions.IgnoreCase | System.Globalization.CompareOptions.IgnoreNonSpace)))
                    .Select(d => (object)new { name = d.Name, path = d.FullName, isDirectory = true }).ToList();
            }
            catch (UnauthorizedAccessException) { return StatusCode(403, new { error = "Cannot read directory", path = full }); }
            return Ok(new Dictionary<string, object?> { ["path"] = full, ["parent"] = Directory.GetParent(full)?.FullName ?? (OperatingSystem.IsWindows() ? "" : null), ["entries"] = entries });
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
        foreach (var (field, max) in new[] { ("path", 4096), ("category", 100) })
        {
            if (!body.Has(field) || body.IsNull(field)) continue;
            if (body.Str(field) is not { } text) return BadRequest(new { error = $"{field} must be a string", field });
            if (text.Trim().Length > max) return BadRequest(new { error = $"{field} must be at most {max} characters", field });
        }
        if (body.Has("reveal") && body.Bool("reveal") is null) return BadRequest(new { error = "reveal must be a boolean", field = "reveal" });
        var reveal = body.Bool("reveal") != false && Environment.GetEnvironmentVariable("PLAYWRIGHT_NO_REVEAL") != "1";
        var target = body.Str("path")?.Trim() is { Length: > 0 } p ? p : ClientSettingsStore.ResolveDownloadTarget(config, body.Str("category"), null).SavePath;
        if (string.IsNullOrWhiteSpace(target)) return BadRequest(new { error = "No folder configured", message = "Set a default download folder or a per-category path in Settings." });
        if (target.Contains('\0') || !Path.IsPathFullyQualified(target)) return BadRequest(new { error = "Path must be absolute", message = $"Got: {target}" });
        var full = Path.GetFullPath(target);
        if (!LibraryRoots(config).Any(root => IsWithin(full, root)))
            return StatusCode(403, new
            {
                ok = false, error = "Path is outside your download folders", pathOnly = full,
                message = "TorrentFlow only opens folders inside your configured download locations. Add this location in Settings first.",
            });
        var folder = full;
        if (!Directory.Exists(full) && !System.IO.File.Exists(full))
        {
            var parent = Path.GetDirectoryName(full);
            if (parent is not null && Directory.Exists(parent) && LibraryRoots(config).Any(root => IsWithin(parent, root))) folder = parent;
            else return NotFound(new
            {
                ok = false, error = "Folder not found on this machine", path = full,
                message = "The path must exist on the server running TorrentFlow. If your torrent client is remote/Docker, open the folder on that host instead.",
                pathOnly = full,
            });
        }
        if (!reveal) return Ok(new { ok = true, path = full, message = $"Verified folder {full}", revealed = false });
        try
        {
            var psi = new ProcessStartInfo(OperatingSystem.IsWindows() ? "explorer.exe" : OperatingSystem.IsMacOS() ? "open" : "xdg-open");
            psi.ArgumentList.Add(folder);
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

        if (!body.Has("relativePath") || body.Str("relativePath")?.Trim() is "")
            return BadRequest(new { error = "relativePath is required", field = "relativePath" });
        if (body.Str("relativePath") is null)
            return BadRequest(new { error = "relativePath must be a string", field = "relativePath" });
        var rel = body.Str("relativePath")!.Trim();
        if (rel.Length > 4096)
            return BadRequest(new { error = "relativePath must be at most 4096 characters", field = "relativePath" });
        if (rel.Contains('\0') || Path.IsPathRooted(rel)) return Refuse(403, "outside-root", "That path is not inside the download folder.");
        var config = await store.GetConfigAsync(ct);
        if (config.DownloadRoot is not { } rootRaw) return BadRequest(new { ok = false, error = "No download folder configured" });
        var root = Path.GetFullPath(rootRaw);
        var full = Path.GetFullPath(Path.Combine(root, rel));
        if (!IsWithin(full, root) || full.TrimEnd(Path.DirectorySeparatorChar).Equals(root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            return Refuse(403, "outside-root", "That path is not inside the download folder.");
        // A junction or symlink between the root and the entry would point the delete at another folder entirely.
        if (HasLinkBetween(root, full)) return Refuse(403, "symlink", "Links and junctions are not followed.");
        if (Path.GetRelativePath(root, full).Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)[0].StartsWith('.'))
            return Refuse(403, "internal", "App bookkeeping files cannot be removed here.");
        var isDir = Directory.Exists(full);
        if (!isDir && !System.IO.File.Exists(full)) return Refuse(404, "missing", "That entry no longer exists.");
        var attrs = System.IO.File.GetAttributes(full);
        if (attrs.HasFlag(FileAttributes.ReparsePoint)) return Refuse(403, "symlink", "Links and junctions are not removed.");

        // Tracked = inside any live or recorded release. Refuse rather than orphan a transfer.
        var rows = await db.EngineTorrents.AsNoTracking().Where(r => r.UserId == LocalUser.Id && r.Status != "removed").ToListAsync(ct);
        foreach (var row in rows)
        {
            if (!string.IsNullOrWhiteSpace(row.SavePath) && !string.IsNullOrWhiteSpace(row.Name))
            {
                var claim = Path.GetFullPath(Path.Combine(row.SavePath, row.Name));
                if (IsWithin(full, claim)) return Refuse(409, "tracked", "That file belongs to a download.");
                if (isDir && IsWithin(claim, full)) return Refuse(409, "contains-tracked", "That folder contains a download's files.");
            }
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
            usage = SettingsDiskInventory.Usage(config, rows, ct),
        });
    }

    [HttpPost("api/settings/retention-sweep")]
    public async Task<IActionResult> Sweep(CancellationToken ct)
    {
        if (await JsonBody.ReadAsync(Request, ct) is not { } body) return JsonBody.InvalidJson();
        if (body.Has("mode") && body.Str("mode") is null) return BadRequest(new { error = "mode must be a string", field = "mode" });
        var mode = body.Str("mode")?.Trim() ?? "preview";
        if (mode is not ("preview" or "delete")) return BadRequest(new { error = "mode must be one of: preview, delete", field = "mode" });
        var budget = body.Num("budgetBytes");
        if (body.Has("budgetBytes") && !body.IsNull("budgetBytes") && budget is null)
            return BadRequest(new { error = "budgetBytes must be a finite number", field = "budgetBytes" });
        if (budget is { } b)
        {
            var error = b != Math.Floor(b) ? "budgetBytes must be an integer" : b < 1 ? "budgetBytes must be at least 1"
                : b > 9007199254740991 ? "budgetBytes must be at most 9007199254740991" : null;
            if (error is not null) return BadRequest(new { error, field = "budgetBytes" });
        }
        var config = await store.GetConfigAsync(ct);
        if (config.MaxStorageBytes is not { } cap)
            return StatusCode(409, new { error = "Storage setup required", message = StorageBudget.SetupRequiredMessage });
        try
        {
            var result = await sweeper.SweepAsync(mode, budget is { } bb ? (long)bb : Math.Min(cap, 20L * 1024 * 1024 * 1024), ct);
            storage.ResetDirectorySizeCache();
            var rows = await db.EngineTorrents.AsNoTracking().Where(r => r.UserId == LocalUser.Id).ToListAsync(ct);
            return Ok(new { ok = true, result, usage = SettingsDiskInventory.Usage(config, rows, ct) });
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
