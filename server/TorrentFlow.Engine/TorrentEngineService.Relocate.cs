using System.Text.Json;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Layout;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Engine;

internal sealed partial class TorrentEngineService
{
    private static readonly System.Text.RegularExpressions.Regex SeasonFolder = new(@"^Season \d+$",
        System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>
    /// Moves a parked transfer's files to the folder <paramref name="placement"/> gives now, the same folder a new send
    /// of the work would use (<see cref="SmartSendTargets.ForWork"/>). Only a show or season folder change inside one
    /// library under the download root moves, on one volume, one rename per file, never over an existing file; any
    /// failure puts back what moved. The row's save path and verified files follow, empty old folders go.
    /// </summary>
    public async Task<EngineRelocation> RelocateAsync(string infoHash, WorkPlacement placement, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        if (categorizer is null) return new(false, EngineRelocation.NotSupported, null, null);
        var config = await settings.GetConfigAsync(ct);
        var target = SmartSendTargets.ForWork(config, categorizer, placement).SavePath;
        using (await LockHashAsync(hash, ct))
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var row = await FindAsync(db, hash, ct);
            if (row is null || row.Status == EngineTorrentStatus.Removed) return new(false, EngineRelocation.NotFound, null, null);
            if (target is null || string.IsNullOrWhiteSpace(row.SavePath)) return new(false, EngineRelocation.OutsideLibrary, row.SavePath, target);
            var from = Path.TrimEndingDirectorySeparator(Path.GetFullPath(row.SavePath));
            var to = Path.TrimEndingDirectorySeparator(Path.GetFullPath(target));
            if (Same(from, to)) return new(false, null, from, to);
            var root = config.DownloadRoot is { } configured ? Path.TrimEndingDirectorySeparator(Path.GetFullPath(configured)) : null;
            var fromLibrary = Path.GetDirectoryName(Path.GetDirectoryName(from));
            var toLibrary = Path.GetDirectoryName(Path.GetDirectoryName(to));
            if (root is null || fromLibrary is null || toLibrary is null || !Same(fromLibrary, toLibrary) ||
                !SeasonFolder.IsMatch(Path.GetFileName(from)) || !SeasonFolder.IsMatch(Path.GetFileName(to)) ||
                !ContentLayoutPolicy.IsInside(root, fromLibrary) ||
                !string.Equals(Path.GetPathRoot(from), Path.GetPathRoot(to), StringComparison.OrdinalIgnoreCase))
                return new(false, EngineRelocation.OutsideLibrary, from, to);
            if (row.Status != EngineTorrentStatus.Parked || !IsDownloaded(row) || backend.Get(hash) is not null)
                return new(false, EngineRelocation.NotParked, from, to);
            var files = VerifiedFiles(row);
            var moves = new List<(string From, string To)>();
            foreach (var file in files)
            {
                if (file.FullPath is not { } path) continue;
                var full = Path.GetFullPath(path);
                if (!ContentLayoutPolicy.IsInside(from, full)) return new(false, EngineRelocation.OutsideLibrary, from, to) { Detail = full };
                moves.Add((full, Path.Combine(to, Path.GetRelativePath(from, full))));
            }
            if (moves.Count == 0) return new(false, EngineRelocation.NotFound, from, to);
            if (moves.FirstOrDefault(m => File.Exists(m.To) || Directory.Exists(m.To)) is { To: { } clash })
                return new(false, EngineRelocation.Clash, from, to) { Detail = clash };
            if (moves.FirstOrDefault(m => !File.Exists(m.From)) is { From: { } gone })
                return new(false, EngineRelocation.NotFound, from, to) { Detail = gone };
            var indexed = _layoutManifest.IndexedPaths(hash, row.SavePath);
            var done = new List<(string From, string To)>();
            try
            {
                foreach (var move in moves)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(move.To)!);
                    File.Move(move.From, move.To, overwrite: false);
                    done.Add(move);
                }
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                foreach (var move in Enumerable.Reverse(done))
                {
                    try { File.Move(move.To, move.From, overwrite: false); }
                    catch (Exception undo) when (undo is IOException or UnauthorizedAccessException)
                    {
                        logger.LogError(undo, "Could not put {File} back after a failed move of {Hash}", move.From, hash);
                    }
                }
                RemoveEmptyFolders(done.Select(m => m.To), toLibrary);
                return new(false, EngineRelocation.MoveFailed, from, to) { Detail = error.Message };
            }
            string? Moved(string? path) => path is null ? null : moves.FirstOrDefault(m => Same(m.From, Path.GetFullPath(path))) is { To: { } now } ? now : path;
            row.SavePath = target;
            row.VerifiedFilesJson = JsonSerializer.Serialize(files.Select(f => f with { FullPath = Moved(f.FullPath) }).ToList(), JsonOptions);
            row.UpdatedAt = Now;
            await db.SaveChangesAsync(CancellationToken.None);
            _layoutManifest.Forget(hash, from);
            if (indexed is not null) _layoutManifest.Remember(hash, target, indexed.Select(Moved).ToList());
            RemoveEmptyFolders(moves.Select(m => m.From), fromLibrary);
            // The caller logs the one line per move the owner reads.
            logger.LogDebug("Moved {Count} files of {Hash} from {From} to {To}", moves.Count, hash, from, to);
            return new(true, null, from, to);
        }
    }

    private static bool Same(string a, string b) => string.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(a)),
        Path.TrimEndingDirectorySeparator(Path.GetFullPath(b)), OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    /// <summary>Deletes the now-empty folders the files left, up to (not including) <paramref name="stop"/>.</summary>
    private static void RemoveEmptyFolders(IEnumerable<string> files, string stop)
    {
        var dirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in files)
        {
            var dir = Path.GetDirectoryName(file);
            while (dir is not null && ContentLayoutPolicy.IsInside(stop, dir) && !Same(stop, dir)) { dirs.Add(dir); dir = Path.GetDirectoryName(dir); }
        }
        foreach (var dir in dirs.OrderByDescending(d => d.Length))
        {
            try { if (Directory.Exists(dir) && !Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
