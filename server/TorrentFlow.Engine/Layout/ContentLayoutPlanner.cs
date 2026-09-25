using Microsoft.Extensions.Logging;

namespace TorrentFlow.Engine.Layout;

/// <summary>A torrent file as the planner sees it: its torrent-relative path and its length.</summary>
internal sealed record LayoutFile(string Path, long Length);

/// <summary>The layout a torrent's files get inside the save path.</summary>
/// <param name="Roots">Folders dropped, outermost first.</param>
/// <param name="Renamed">Release folders renamed to <c>Season NN</c>, as <c>from → to</c>.</param>
/// <param name="Paths">New path for each file, in the same order as the input.</param>
internal sealed record LayoutPlan(IReadOnlyList<string> Roots, IReadOnlyList<string> Renamed, IReadOnlyList<string> Paths)
{
    /// <summary>The <c>removed N wrapper folders; renamed a → b</c> summary the TypeScript engine logged.</summary>
    public string Describe()
    {
        var what = new List<string>();
        if (Roots.Count > 0) what.Add($"removed {Roots.Count} wrapper folder{(Roots.Count == 1 ? "" : "s")}");
        if (Renamed.Count > 0) what.Add($"renamed {string.Join(", ", Renamed)}");
        return string.Join("; ", what);
    }
}

/// <summary>What the caller found at a path the layout would write to.</summary>
/// <param name="Size">Size on disk.</param>
/// <param name="Owner">Info hash that claimed it, if any.</param>
/// <param name="IsDirectory">True when a directory (or anything that is not a plain file) sits where a file should go.</param>
internal sealed record ExistingFile(long Size, string? Owner, bool IsDirectory = false);

/// <summary>
/// Port of content-layout.ts. A multi-file torrent states its paths relative to a folder named after the release, and
/// since the save path is already ours (<c>Anime/Solo Leveling/Season 01</c>) that container is redundant. Some packs
/// wrap twice, so one level is not always enough — but "this folder is the only child" is NOT evidence that it is
/// redundant; every rule about what a folder means lives in <see cref="ContentLayoutPolicy"/>.
/// </summary>
internal static class ContentLayoutPlanner
{
    /// <summary>
    /// Works out which container folders to drop. Null leaves the layout untouched — every ambiguity resolves that way,
    /// because a wrong rewrite puts real bytes in the wrong place.
    /// </summary>
    /// <param name="files">the torrent's files, in torrent order</param>
    /// <param name="destPath">where the torrent is saved; used to spot a folder that merely repeats a destination component</param>
    /// <param name="windows">filesystem semantics for the collapse check; defaults to the current OS</param>
    public static LayoutPlan? Plan(IReadOnlyList<LayoutFile> files, string? destPath, bool? windows = null)
    {
        if (files.Count == 0) return null;

        var split = files.Select(f => ContentLayoutPolicy.Segments(f.Path)).ToList();

        // Reject traversal in the input rather than the output: stripping consumes leading segments, so a `..` would be
        // eaten before any output check saw it.
        if (split.Any(s => s.Any(seg => seg is ".." or "."))) return null;

        var destKeys = ContentLayoutPolicy.DestinationKeys(destPath);
        var roots = new List<string>();

        // Bounded purely as a loop guard; two is the deepest wrap seen in practice.
        for (var depth = 0; depth < 8; depth++)
        {
            // A file at the top level means we have reached the content.
            if (split.Any(s => s.Count < 2)) break;

            var root = split[0][0];
            if (!split.All(s => s[0] == root)) break;
            if (!ContentLayoutPolicy.MayDropFolder(root, depth, destKeys, roots)) break;

            split = split.Select(s => s.Skip(1).ToList()).ToList();
            roots.Add(root);
        }

        // A multi-season pack keeps its season folders — dropping them would merge two S01E01s — but they arrive named
        // after the release, not the season. Skipped when the destination already names a season: `Season 01/Season 02`
        // is not an improvement on leaving it alone.
        var renamed = new List<string>();
        if (!ContentLayoutPolicy.DestinationNamesSeason(destPath))
        {
            var renameOf = new Dictionary<string, string?>(StringComparer.Ordinal);
            split = split.Select(s =>
            {
                if (s.Count < 2) return s;
                var from = s[0];
                if (!renameOf.TryGetValue(from, out var to))
                {
                    to = ContentLayoutPolicy.SeasonFolderRename(from);
                    renameOf[from] = to;
                    if (to is not null) renamed.Add($"{from} → {to}");
                }
                return to is not null ? [to, .. s.Skip(1)] : s;
            }).ToList();
        }

        if (roots.Count == 0 && renamed.Count == 0) return null;

        var paths = split.Select(s => string.Join('/', s)).ToList();
        if (paths.Any(p => p.Length == 0)) return null;

        // Two files must never collapse onto one path — compared the way the filesystem sees them.
        var keys = paths.Select(p => ContentLayoutPolicy.PhysicalKey(p, windows)).ToHashSet(StringComparer.Ordinal);
        if (keys.Count != paths.Count) return null;

        return new LayoutPlan(roots, renamed, paths);
    }

    /// <summary>
    /// Applies <see cref="Plan"/> to <paramref name="files"/>, vetoing a rewrite that would land on a file another
    /// torrent owns (flattening several episode releases into one season folder can otherwise point two releases at the
    /// same <c>sample.mkv</c>). Returns the applied plan, or null when nothing changes.
    /// </summary>
    /// <param name="existingAt">what is already at a destination-relative path, or null when nothing is</param>
    /// <param name="claim">records ownership of the new paths; false when that could not be made durable</param>
    /// <param name="skipCollision">paths whose collisions never block (tracker spam the caller discards instead)</param>
    public static LayoutPlan? Apply(
        IReadOnlyList<LayoutFile> files,
        string? destPath,
        string? infoHash,
        Func<string, ExistingFile?>? existingAt,
        Func<IReadOnlyList<string>, bool>? claim,
        ILogger logger,
        Func<string, bool>? skipCollision = null,
        bool? windows = null)
    {
        var plan = Plan(files, destPath, windows);
        if (plan is null) return null;

        if (existingAt is not null)
        {
            var self = infoHash?.ToLowerInvariant();
            for (var i = 0; i < plan.Paths.Count; i++)
            {
                if (skipCollision?.Invoke(plan.Paths[i]) == true) continue;
                var found = existingAt(plan.Paths[i]);
                if (found is null) continue;

                // Ours by record: resume data, whatever its size.
                if (self is not null && found.Owner == self) continue;

                var reason = found.IsDirectory ? "a directory is in the way"
                    : found.Owner is not null ? $"it belongs to torrent {found.Owner[..Math.Min(8, found.Owner.Length)]}"
                    : found.Size != files[i].Length ? "a file of a different size is already there"
                    : null;

                if (reason is not null)
                {
                    logger.LogWarning("[content-layout] keeping the release folder — \"{Path}\" would collide: {Reason}", plan.Paths[i], reason);
                    return null;
                }
                // Unclaimed and the right size: a download of ours from before the manifest existed. Claimed below.
            }
        }

        // Claim before writing. Without a durable record the next torrent cannot tell these files from its own, so
        // decline to flatten rather than write files we cannot account for.
        if (claim is not null && !claim(plan.Paths))
        {
            logger.LogWarning("[content-layout] keeping the release folder — ownership could not be recorded");
            return null;
        }
        return plan;
    }
}
