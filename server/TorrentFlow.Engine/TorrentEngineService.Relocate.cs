using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
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
    /// failure puts back what moved. The row's save path and verified files follow, empty old folders go. The move is
    /// saved on the row before the first file moves (<see cref="RelocationJournal"/>), so one a crash cuts short is
    /// finished or undone at the next start (<see cref="RecoverRelocationsAsync"/>).
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
            // A move a failed save or a failed undo left half done is settled first, the same way the start does.
            if (row.RelocationJson is not null && backend.Get(hash) is null) await SettleRelocationAsync(db, row);
            if (target is null || string.IsNullOrWhiteSpace(row.SavePath)) return new(false, EngineRelocation.OutsideLibrary, row.SavePath, target);
            var from = Path.TrimEndingDirectorySeparator(Path.GetFullPath(row.SavePath));
            var to = Path.TrimEndingDirectorySeparator(Path.GetFullPath(target));
            if (Same(from, to)) return new(false, null, from, to);
            var root = config.DownloadRoot is { } configured ? Path.TrimEndingDirectorySeparator(Path.GetFullPath(configured)) : null;
            var fromLibrary = LibraryOf(from);
            var toLibrary = LibraryOf(to);
            if (root is null || fromLibrary is null || toLibrary is null || !Same(fromLibrary, toLibrary) ||
                !SeasonFolder.IsMatch(Path.GetFileName(from)) || !SeasonFolder.IsMatch(Path.GetFileName(to)) ||
                !ContentLayoutPolicy.IsInside(root, fromLibrary) ||
                !string.Equals(Path.GetPathRoot(from), Path.GetPathRoot(to), StringComparison.OrdinalIgnoreCase))
                return new(false, EngineRelocation.OutsideLibrary, from, to);
            if (row.Status != EngineTorrentStatus.Parked || !IsDownloaded(row) || backend.Get(hash) is not null || row.RelocationJson is not null)
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
            var journal = new RelocationJournal(from, to, target, moves.Select(m => new RelocationJournal.FileMove(m.From, m.To)).ToList(), Now);
            row.RelocationJson = journal.Write();
            await db.SaveChangesAsync(ct);
            try
            {
                foreach (var move in moves)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(move.To)!);
                    File.Move(move.From, move.To, overwrite: false);
                }
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                // A file that could not go back keeps the journal, so the next start puts it back.
                if (RollBackRelocation(hash, journal))
                {
                    row.RelocationJson = null;
                    await db.SaveChangesAsync(CancellationToken.None);
                }
                return new(false, EngineRelocation.MoveFailed, from, to) { Detail = error.Message };
            }
            await FinishRelocationAsync(db, row, journal);
            // The caller logs the one line per move the owner reads.
            logger.LogDebug("Moved {Count} files of {Hash} from {From} to {To}", moves.Count, hash, from, to);
            return new(true, null, from, to);
        }
    }

    /// <summary>
    /// Whether a transfer's files are gone, read fresh under its lock: true when the row is gone, false while a move of
    /// its files is under way or waits to be settled, else true only when every file it kept is confirmed missing.
    /// </summary>
    public async Task<bool> FilesMissingAsync(string infoHash, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        using (await LockHashAsync(hash, ct))
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var row = await FindAsync(db, hash, ct);
            if (row is null || row.Status == EngineTorrentStatus.Removed) return true;
            return row.RelocationJson is null && TorrentFlow.Core.Contracts.Engine.VerifiedFiles.AllMissing(row.VerifiedFilesJson);
        }
    }

    /// <summary>
    /// Startup, before anything can load or start a transfer (<see cref="RehydrateAsync"/>): settles every move a crash
    /// or a failed save left half done (<see cref="SettleRelocationAsync"/>). A row that cannot be settled is logged and
    /// left for the next start; nothing here stops the start.
    /// </summary>
    internal async Task RecoverRelocationsAsync(CancellationToken ct)
    {
        List<string> hashes;
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            hashes = await db.EngineTorrents.AsNoTracking().Where(r => r.UserId == LocalUser.Id && r.RelocationJson != null)
                .Select(r => r.Hash).ToListAsync(ct);
        }
        catch (Exception error) when (!ct.IsCancellationRequested)
        {
            logger.LogError(error, "Could not look for interrupted moves");
            return;
        }
        foreach (var hash in hashes)
        {
            try
            {
                using (await LockHashAsync(hash, ct))
                {
                    await using var db = await dbFactory.CreateDbContextAsync(ct);
                    if (await FindAsync(db, hash, ct) is { RelocationJson: not null } row && backend.Get(hash) is null)
                        await SettleRelocationAsync(db, row);
                }
            }
            catch (Exception error) when (!ct.IsCancellationRequested)
            {
                logger.LogError(error, "Could not settle the interrupted move of {Hash}", hash);
            }
        }
    }

    /// <summary>
    /// Settles a move a crash, a failed save or a failed undo left half done; the caller holds the hash lock and nothing
    /// holds the files. Finished when every file is in the new folder and none is left in the old one, else undone. The
    /// journal goes once the row and the files agree; a file that cannot go back keeps it, for the next start.
    /// </summary>
    private async Task SettleRelocationAsync(TorrentFlowDbContext db, EngineTorrent row)
    {
        if (RelocationJournal.Read(row.RelocationJson) is not { } journal)
        {
            logger.LogWarning("Could not read the interrupted move of {Hash}; forgetting it", row.Hash);
            row.RelocationJson = null;
            await db.SaveChangesAsync(CancellationToken.None);
            return;
        }
        if (journal.Files.All(m => File.Exists(m.To) && !File.Exists(m.From)))
        {
            await FinishRelocationAsync(db, row, journal);
            logger.LogInformation("Finished an interrupted move of {Hash} to {To}", row.Hash, journal.To);
            return;
        }
        if (!RollBackRelocation(row.Hash, journal))
        {
            logger.LogWarning("Could not roll back all of the interrupted move of {Hash} to {From}; trying again later", row.Hash, journal.From);
            return;
        }
        row.RelocationJson = null;
        await db.SaveChangesAsync(CancellationToken.None);
        logger.LogInformation("Rolled back an interrupted move of {Hash} to {From}", row.Hash, journal.From);
    }

    /// <summary>
    /// Records a move whose files all reached the new folder: the row takes the new save path and verified files and drops
    /// the journal in one save, with the wanted items it fills pointing at their files' new paths, so neither a crash nor a
    /// startup recovery leaves one at the old folder. Then the layout manifest follows the files and the emptied old folders go.
    /// </summary>
    private async Task FinishRelocationAsync(TorrentFlowDbContext db, EngineTorrent row, RelocationJournal journal)
    {
        var indexed = _layoutManifest.IndexedPaths(row.Hash, row.SavePath, journal.Moved);
        row.SavePath = journal.SavePath;
        row.VerifiedFilesJson = JsonSerializer.Serialize(VerifiedFiles(row).Select(f => f with { FullPath = journal.Moved(f.FullPath) }).ToList(), JsonOptions);
        row.RelocationJson = null;
        row.UpdatedAt = Now;
        var (lower, upper) = (row.Hash.ToLowerInvariant(), row.Hash.ToUpperInvariant());
        foreach (var target in await db.AcquisitionTargets.Where(t => t.UserId == row.UserId && (t.InfoHash == lower || t.InfoHash == upper) &&
                     t.FilePath != null).ToListAsync(CancellationToken.None))
            if (journal.Moved(target.FilePath) is { } moved && !Same(moved, target.FilePath!))
            {
                target.FilePath = moved;
                target.UpdatedAt = Now;
            }
        await db.SaveChangesAsync(CancellationToken.None);
        _layoutManifest.Forget(row.Hash, journal.From);
        if (indexed is not null) _layoutManifest.Remember(row.Hash, journal.SavePath, indexed.Select(journal.Moved).ToList());
        if (LibraryOf(journal.From) is { } library) RemoveEmptyFolders(journal.Files.Select(m => m.From), library);
    }

    /// <summary>
    /// Puts back the files of a move that did not finish: each file found only in the new folder goes back to the old one,
    /// never over a file; a file in neither is logged and left. The emptied new folders go. False when a file could not
    /// go back.
    /// </summary>
    private bool RollBackRelocation(string hash, RelocationJournal journal)
    {
        var undone = true;
        foreach (var move in journal.Files)
        {
            var back = File.Exists(move.From);
            if (!back && File.Exists(move.To))
            {
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(move.From)!);
                    File.Move(move.To, move.From, overwrite: false);
                }
                catch (Exception undo) when (undo is IOException or UnauthorizedAccessException)
                {
                    undone = false;
                    logger.LogError(undo, "Could not put {File} back after a failed move of {Hash}", move.From, hash);
                }
            }
            else if (!back) logger.LogWarning("{File} of {Hash} is in neither the old nor the new folder; left as it is", move.From, hash);
        }
        if (LibraryOf(journal.To) is { } library) RemoveEmptyFolders(journal.Files.Select(m => m.To), library);
        return undone;
    }

    /// <summary>
    /// A move of a transfer's files under way, kept on its row (<see cref="EngineTorrent.RelocationJson"/>) from before the
    /// first file moves until the save that records the new folder.
    /// </summary>
    /// <param name="From">The old folder, a full path.</param>
    /// <param name="To">The new folder, a full path.</param>
    /// <param name="SavePath">The save path the row takes once the move is done.</param>
    /// <param name="Files">Each file's full path in the old folder and in the new one.</param>
    /// <param name="At">When the move started (UTC).</param>
    private sealed record RelocationJournal(string From, string To, string SavePath, IReadOnlyList<RelocationJournal.FileMove> Files, DateTime At)
    {
        public sealed record FileMove(string From, string To);

        public string Write() => JsonSerializer.Serialize(this, JsonOptions);

        /// <summary>The journal, or null when the JSON is not a whole one.</summary>
        public static RelocationJournal? Read(string? json)
        {
            if (string.IsNullOrWhiteSpace(json)) return null;
            try
            {
                return JsonSerializer.Deserialize<RelocationJournal>(json, JsonOptions) is { From.Length: > 0, To.Length: > 0, SavePath.Length: > 0, Files.Count: > 0 } journal
                    && journal.Files.All(f => f is { From.Length: > 0, To.Length: > 0 }) ? journal : null;
            }
            catch (JsonException) { return null; }
        }

        /// <summary>Where a file of the old folder is once moved; any other path stays as it is.</summary>
        public string? Moved(string? path) =>
            path is null ? null : Files.FirstOrDefault(m => Same(m.From, Path.GetFullPath(path)))?.To ?? path;
    }

    /// <summary>The library folder a season folder sits in (<c>&lt;library&gt;\&lt;show&gt;\Season NN</c>).</summary>
    private static string? LibraryOf(string seasonFolder) => Path.GetDirectoryName(Path.GetDirectoryName(seasonFolder));

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
