using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using ManifestFile = TorrentFlow.Engine.TorrentEngineService.ManifestFile;

namespace TorrentFlow.Engine.Layout;

internal enum LayoutOutcome
{
    /// <summary>Nothing moved: already laid out, nothing to drop, or a collision kept the release folder.</summary>
    Unchanged,
    /// <summary>Files moved to their final paths and the manifest now records them.</summary>
    LaidOut,
    /// <summary>ffprobe found no playable video; the row is now an error so another release can be chosen.</summary>
    Invalid,
}

/// <summary>
/// Finishes a completed download once nothing holds its files: optional ffprobe validation, then the content layout.
/// The TypeScript engine rewrote paths before the store opened; MonoTorrent downloads a multi-file torrent into its
/// release folder (so two releases never write over each other mid-download) and the same planner decisions are applied
/// here, after the client has let go of the files, with the manifest in <c>verifiedFilesJson</c> updated so later
/// streams and deletes find the files where they now are.
/// </summary>
internal sealed class CompletedLayoutFinalizer(CompletedMediaValidator validator, TimeProvider time, ILogger<CompletedLayoutFinalizer> logger)
{
    private const string StageSuffix = ".tflayout";
    private const string BackupSuffix = ".tflayout-old";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>Tracker spam: never content, so it never blocks a layout and a duplicate copy is discarded, not moved.</summary>
    private static readonly Regex Junk = new(@"^(?:torrent[\s._-]*downloaded[\s._-]*from(?![a-z]).*|rarbg(?:\.com)?)\.txt$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static readonly Regex WindowsReservedName = new(@"^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static bool IsJunk(string relativePath) =>
        ContentLayoutPolicy.Segments(relativePath) is { Count: > 0 } s && Junk.IsMatch(s[^1]);

    /// <summary>
    /// False for a path Windows cannot hold as written: a reserved device name (<c>CON</c>, <c>nul.txt</c>), a segment
    /// ending in a dot or space (silently stripped, so the file would land somewhere the manifest does not say), or an
    /// invalid character.
    /// </summary>
    public static bool IsValidWindowsPath(string relativePath) =>
        relativePath.Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries).All(seg =>
            !WindowsReservedName.IsMatch(seg) && !seg.EndsWith('.') && !seg.EndsWith(' ')
            && seg.IndexOfAny(['<', '>', ':', '"', '/', '\\', '|', '?', '*']) < 0 && !seg.Any(char.IsControl));

    /// <summary>Validates and lays out one parked row. The caller holds the transfer's lock and has detached it.</summary>
    public async Task<LayoutOutcome> FinalizeAsync(TorrentFlowDbContext db, EngineTorrent row, CancellationToken ct)
    {
        var manifest = TorrentEngineService.VerifiedFiles(row);
        if (manifest.Count == 0 || manifest.Any(f => f.FullPath is null) || string.IsNullOrWhiteSpace(row.SavePath))
            return LayoutOutcome.Unchanged;

        if (await validator.ValidateAsync(manifest.Select(f => f.FullPath!).ToList(), ct) == MediaVerdict.Invalid)
        {
            await MarkInvalidAsync(db, row, ct);
            logger.LogWarning("[builtin-engine] rejected completed non-media payload {Hash}", row.Hash);
            return LayoutOutcome.Invalid;
        }

        var dest = Path.GetFullPath(row.SavePath);
        var rel = manifest.Select(f => RelativeTo(dest, f.FullPath!)).ToList();
        if (rel.Any(r => r is null) || !IsNativeLayout(manifest, rel!)) return LayoutOutcome.Unchanged;

        var files = rel.Select((r, i) => new LayoutFile(r!, manifest[i].Size)).ToList();
        var owners = await OwnersAsync(db, row, manifest, ct);
        var windows = OperatingSystem.IsWindows();

        var plan = ContentLayoutPlanner.Apply(files, dest, row.Hash, p => ProbeExisting(dest, p, owners), claim: null, logger,
            skipCollision: IsJunk);
        if (plan is null) return LayoutOutcome.Unchanged;

        if (windows && plan.Paths.FirstOrDefault(p => !IsValidWindowsPath(p)) is { } bad)
        {
            logger.LogWarning("[content-layout] keeping the release folder — \"{Path}\" is not a valid Windows path", bad);
            return LayoutOutcome.Unchanged;
        }

        var self = row.Hash.ToLowerInvariant();
        var moves = new List<Move>();
        for (var i = 0; i < manifest.Count; i++)
        {
            var src = manifest[i].FullPath!;
            var dst = Path.Combine(dest, plan.Paths[i].Replace('/', Path.DirectorySeparatorChar));
            var existing = ProbeExisting(dest, plan.Paths[i], owners);
            var occupied = existing is not null && existing.Owner != self;
            moves.Add(new Move(src, dst, Discard: occupied && IsJunk(plan.Paths[i]), Replace: occupied && !IsJunk(plan.Paths[i])));
        }

        // Claim before moving: the manifest is the ownership record the next torrent's collision check reads.
        var before = row.VerifiedFilesJson;
        var after = manifest.Select((f, i) => f with { FullPath = moves[i].Discard ? null : moves[i].Dst }).ToList();
        row.VerifiedFilesJson = JsonSerializer.Serialize(after, JsonOptions);
        row.UpdatedAt = time.GetUtcNow().UtcDateTime;
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            row.VerifiedFilesJson = before;
            logger.LogWarning("[content-layout] keeping the release folder — ownership could not be recorded");
            return LayoutOutcome.Unchanged;
        }

        try
        {
            Execute(moves);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // A layout tweak must never lose a download: every rename was undone, so point the manifest back.
            logger.LogWarning("[content-layout] rewrite failed {Message}", ex.Message);
            row.VerifiedFilesJson = before;
            await db.SaveChangesAsync(CancellationToken.None);
            return LayoutOutcome.Unchanged;
        }

        RemoveEmptyParents(moves.Select(m => m.Src), dest);
        foreach (var junk in moves.Where(m => m.Discard))
            logger.LogInformation("[content-layout] dropped duplicate junk \"{Path}\"", Path.GetRelativePath(dest, junk.Dst));
        logger.LogInformation("[content-layout] {Name} → {Dest}: {What}", string.IsNullOrWhiteSpace(row.Name) ? "torrent" : row.Name, dest, plan.Describe());
        return LayoutOutcome.LaidOut;
    }

    private sealed record Move(string Src, string Dst, bool Discard, bool Replace);

    /// <summary>
    /// All-or-nothing. Every source is first renamed aside, so a plan that moves one of our files onto another's old
    /// location cannot overwrite it; then each lands at its target. Any failure undoes every rename in reverse.
    /// </summary>
    private static void Execute(List<Move> moves)
    {
        var done = new Stack<(string From, string To)>();
        var backups = new List<string>();
        try
        {
            var staged = new List<(Move Move, string Stage)>();
            foreach (var m in moves)
            {
                if (PathsEqual(m.Src, m.Dst)) continue;
                var stage = m.Src + StageSuffix;
                File.Move(m.Src, stage);
                done.Push((m.Src, stage));
                staged.Add((m, stage));
            }
            foreach (var (m, stage) in staged)
            {
                if (m.Discard) continue;
                Directory.CreateDirectory(Path.GetDirectoryName(m.Dst)!);
                if (m.Replace && File.Exists(m.Dst))
                {
                    // An unclaimed file of the same size: a download of ours from before the manifest existed. The staged
                    // copy is the verified one; the old one is kept aside until every move has landed.
                    var backup = m.Dst + BackupSuffix;
                    File.Move(m.Dst, backup);
                    done.Push((m.Dst, backup));
                    backups.Add(backup);
                }
                File.Move(stage, m.Dst);
                done.Push((stage, m.Dst));
            }
        }
        catch
        {
            while (done.TryPop(out var op))
            {
                try { File.Move(op.To, op.From); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            throw;
        }
        foreach (var backup in backups) TryDelete(backup);
        foreach (var m in moves.Where(m => m.Discard && !PathsEqual(m.Src, m.Dst))) TryDelete(m.Src + StageSuffix);
    }

    /// <summary>
    /// True when the files are still where MonoTorrent put them: a single file directly in the save path, or every file
    /// under one release folder at its torrent path. Anything else was already laid out (or moved by hand) and is left.
    /// </summary>
    internal static bool IsNativeLayout(IReadOnlyList<ManifestFile> manifest, IReadOnlyList<string> rel)
    {
        string Norm(string p) => string.Join('/', ContentLayoutPolicy.Segments(p));
        if (manifest.Count == 1) return Norm(rel[0]) == Norm(manifest[0].Path);

        string? container = null;
        for (var i = 0; i < manifest.Count; i++)
        {
            var segs = ContentLayoutPolicy.Segments(rel[i]);
            if (segs.Count < 2 || string.Join('/', segs.Skip(1)) != Norm(manifest[i].Path)) return false;
            if (container is null) container = segs[0];
            else if (segs[0] != container) return false;
        }
        return true;
    }

    private static string? RelativeTo(string dest, string full)
    {
        var abs = Path.GetFullPath(full);
        if (!ContentLayoutPolicy.IsInside(dest, abs)) return null;
        var rel = Path.GetRelativePath(dest, abs);
        return rel == "." ? null : rel.Replace('\\', '/');
    }

    /// <summary>Who owns each recorded file: the manifests of every other transfer, and our own current locations.</summary>
    private static async Task<Dictionary<string, string>> OwnersAsync(TorrentFlowDbContext db, EngineTorrent row,
        IReadOnlyList<ManifestFile> own, CancellationToken ct)
    {
        var owners = new Dictionary<string, string>(StringComparer.Ordinal);
        var others = await db.EngineTorrents.AsNoTracking()
            .Where(r => r.Hash != row.Hash && r.VerifiedFilesJson != null)
            .Select(r => new { r.Hash, r.VerifiedFilesJson })
            .ToListAsync(ct);
        foreach (var other in others)
        {
            List<ManifestFile>? files;
            try { files = JsonSerializer.Deserialize<List<ManifestFile>>(other.VerifiedFilesJson!, JsonOptions); }
            catch (JsonException) { continue; }
            foreach (var f in files ?? [])
            {
                // The TypeScript manifest recorded absolute paths in `path` and had no `fullPath`.
                var full = f.FullPath ?? (f.Path is { } p && Path.IsPathRooted(p) ? p : null);
                if (full is not null) owners.TryAdd(Key(full), other.Hash.ToLowerInvariant());
            }
        }
        foreach (var f in own)
            if (f.FullPath is { } full) owners[Key(full)] = row.Hash.ToLowerInvariant();
        return owners;
    }

    private static string Key(string fullPath) => ContentLayoutPolicy.PhysicalKey(Path.GetFullPath(fullPath));

    /// <summary>
    /// What is already sitting at a path we intend to write to. Walks every ancestor as well as the leaf: a file named
    /// <c>Subs</c> where we want <c>Subs/en.srt</c>, or a junction anywhere along the way, must block the rewrite.
    /// </summary>
    internal static ExistingFile? ProbeExisting(string dest, string rel, IReadOnlyDictionary<string, string> owners)
    {
        var parts = ContentLayoutPolicy.Segments(rel);
        var current = dest;
        for (var i = 0; i < parts.Count; i++)
        {
            current = Path.Combine(current, parts[i]);
            FileAttributes attrs;
            try
            {
                if (!File.Exists(current) && !Directory.Exists(current)) return null;
                attrs = File.GetAttributes(current);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
            {
                return new ExistingFile(-1, null, IsDirectory: true);
            }

            if (attrs.HasFlag(FileAttributes.ReparsePoint)) return new ExistingFile(-1, null, IsDirectory: true);

            var isDirectory = attrs.HasFlag(FileAttributes.Directory);
            if (i < parts.Count - 1)
            {
                // A parent that is not a directory blocks the whole path.
                if (!isDirectory) return new ExistingFile(-1, null, IsDirectory: true);
                continue;
            }
            if (isDirectory) return new ExistingFile(-1, null, IsDirectory: true);
            return new ExistingFile(new FileInfo(current).Length, owners.GetValueOrDefault(Key(current)));
        }
        return null;
    }

    private async Task MarkInvalidAsync(TorrentFlowDbContext db, EngineTorrent row, CancellationToken ct)
    {
        var now = time.GetUtcNow().UtcDateTime;
        row.Status = EngineTorrentStatus.Error;
        row.Error = CompletedMediaValidator.InvalidCompletedMediaMessage;
        row.Progress = 1;
        // No longer "downloaded": nothing may play it or treat it as complete. The manifest stays so a delete finds the files.
        row.VerifiedAt = null;
        row.VerifiedBitfield = null;
        row.ForcedAt = null;
        row.UpdatedAt = now;
        var hash = row.Hash.ToLowerInvariant();
        var upper = row.Hash.ToUpperInvariant();
        var targets = await db.AcquisitionTargets.Where(t => t.InfoHash == hash || t.InfoHash == upper).ToListAsync(ct);
        foreach (var t in targets)
        {
            t.Progress = 0;
            t.Status = "failed";
            t.Error = CompletedMediaValidator.InvalidCompletedMediaMessage;
            t.UpdatedAt = now;
        }
        await db.SaveChangesAsync(ct);
    }

    private static void RemoveEmptyParents(IEnumerable<string> files, string dest)
    {
        var root = dest.TrimEnd(Path.DirectorySeparatorChar);
        var dirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in files)
        {
            var dir = Path.GetDirectoryName(Path.GetFullPath(file));
            while (dir is not null && dir.Length > root.Length && ContentLayoutPolicy.IsInside(root, dir)) { dirs.Add(dir); dir = Path.GetDirectoryName(dir); }
        }
        foreach (var dir in dirs.OrderByDescending(d => d.Length))
        {
            try { if (Directory.Exists(dir) && !Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static bool PathsEqual(string a, string b) =>
        string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
