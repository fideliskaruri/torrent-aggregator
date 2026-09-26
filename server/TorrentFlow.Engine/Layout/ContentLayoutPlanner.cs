using Microsoft.Extensions.Logging;

namespace TorrentFlow.Engine.Layout;

/// <summary>A torrent file as the planner sees it: its torrent-relative path and its length.</summary>
internal sealed record LayoutFile(string Path, long Length);

/// <summary>What a file is to the layout: the content, a subtitle for it, or anything else the release carries.</summary>
internal enum LayoutRole { Video, Subtitle, Extra }

/// <summary>The layout a torrent's files get inside the save path.</summary>
/// <param name="Roots">Folders dropped, outermost first.</param>
/// <param name="Renamed">Release folders renamed to <c>Season NN</c>, as <c>from → to</c>.</param>
/// <param name="Paths">Final path for each file, in the same order as the input. A file that stays put keeps its input path.</param>
internal sealed record LayoutPlan(IReadOnlyList<string> Roots, IReadOnlyList<string> Renamed, IReadOnlyList<string> Paths)
{
    /// <summary>Episode folders inside a pack whose contents were lifted into the season folder.</summary>
    public int Flattened { get; init; }

    /// <summary>Subtitles moved next to (and named after) the video they belong to.</summary>
    public int SubtitlesAttached { get; init; }

    /// <summary>Extras moved to a per-release name because the plain one was taken, as <c>from → to</c>.</summary>
    public IReadOnlyList<string> Relocated { get; init; } = [];

    /// <summary>Files that could not move and stay in their release folder.</summary>
    public IReadOnlyList<string> Kept { get; init; } = [];

    /// <summary>How many of <see cref="Kept"/> are videos: only a real video collision leaves one nested.</summary>
    public int KeptVideos { get; init; }

    /// <summary>The <c>removed N wrapper folders; renamed a → b</c> summary the TypeScript engine logged, plus the per-file work.</summary>
    public string Describe()
    {
        static string N(int n, string one, string many) => $"{n} {(n == 1 ? one : many)}";
        var what = new List<string>();
        if (Roots.Count > 0) what.Add($"removed {N(Roots.Count, "wrapper folder", "wrapper folders")}");
        if (Renamed.Count > 0) what.Add($"renamed {string.Join(", ", Renamed)}");
        if (Flattened > 0) what.Add($"flattened {N(Flattened, "episode folder", "episode folders")}");
        if (SubtitlesAttached > 0) what.Add($"moved {N(SubtitlesAttached, "subtitle", "subtitles")} next to the video");
        if (Relocated.Count > 0) what.Add($"moved {N(Relocated.Count, "colliding extra", "colliding extras")} aside");
        if (KeptVideos > 0) what.Add($"kept {N(KeptVideos, "video", "videos")} in the release folder");
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
/// <para>
/// Decisions are per file. Every video goes straight into the season folder, with its subtitles beside it; a pack's
/// per-episode folders are flattened; an extra whose plain name is taken (every episode release ships a
/// <c>Sample/sample.mkv</c>) moves to a per-release name. Only a video that would land on another file stays in its
/// release folder, and only that video. Nothing is ever written over a file that is not ours.
/// </para>
/// </summary>
internal static class ContentLayoutPlanner
{
    private const string SameNameInTorrent = "another file in this torrent has the same name";

    /// <summary>
    /// Works out where every file goes, without looking at the disk. Null leaves the layout untouched: nothing would
    /// move, or the result is not provably safe.
    /// </summary>
    /// <param name="files">the torrent's files, in torrent order</param>
    /// <param name="destPath">where the torrent is saved; used to spot a folder that merely repeats a destination component</param>
    /// <param name="windows">filesystem semantics for the collapse check; defaults to the current OS</param>
    /// <param name="pinned">files that are not where the torrent put them (already laid out): they stay where they are
    /// (null = no longer on disk) and their paths are taken</param>
    public static LayoutPlan? Plan(IReadOnlyList<LayoutFile> files, string? destPath, bool? windows = null,
        IReadOnlyDictionary<int, string?>? pinned = null) =>
        Build(files, destPath, windows, pinned, probe: null, logger: null);

    /// <summary>
    /// <see cref="Plan"/> checked against what is already on disk. A path another torrent owns, a file of a different
    /// size, or a directory in the way is never written: an extra then moves to a per-release name, a video stays in its
    /// release folder. Returns the plan, or null when nothing changes.
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
        bool? windows = null,
        IReadOnlyDictionary<int, string?>? pinned = null)
    {
        var self = infoHash?.ToLowerInvariant();

        string? Probe(int i, string path)
        {
            if (existingAt is null || skipCollision?.Invoke(path) == true) return null;
            var found = existingAt(path);
            if (found is null) return null;
            // Ours by record: resume data, whatever its size.
            if (self is not null && found.Owner == self) return null;
            return found.IsDirectory ? "a directory is in the way"
                : found.Owner is not null ? $"it belongs to torrent {found.Owner[..Math.Min(8, found.Owner.Length)]}"
                : found.Size != files[i].Length ? "a file of a different size is already there"
                // Unclaimed and the right size: a download of ours from before the manifest existed.
                : null;
        }

        var plan = Build(files, destPath, windows, pinned, Probe, logger);
        if (plan is null) return null;

        // Claim before writing. Without a durable record the next torrent cannot tell these files from its own, so
        // decline to flatten rather than write files we cannot account for.
        if (claim is not null && !claim(plan.Paths))
        {
            logger.LogWarning("[content-layout] keeping the release folder — ownership could not be recorded");
            return null;
        }
        return plan;
    }

    private static LayoutPlan? Build(IReadOnlyList<LayoutFile> files, string? destPath, bool? windows,
        IReadOnlyDictionary<int, string?>? pinned, Func<int, string, string?>? probe, ILogger? logger)
    {
        if (files.Count == 0) return null;
        var n = files.Count;

        var split = files.Select(f => ContentLayoutPolicy.Segments(f.Path)).ToList();

        // Reject traversal in the input rather than the output: stripping consumes leading segments, so a `..` would be
        // eaten before any output check saw it.
        if (split.Any(s => s.Count == 0 || s.Any(seg => seg is ".." or "."))) return null;
        var native = split.Select(s => string.Join('/', s)).ToList();
        bool IsPinned(int i) => pinned?.ContainsKey(i) == true;

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

        var roles = split.Select(ContentLayoutPolicy.Role).ToList();
        var origin = Enumerable.Repeat(roots.Count > 0 ? roots[^1] : null, n).ToList();

        // A pack that gives each episode its own folder: the folder names exactly one episode and directly holds that
        // episode's video. Everything in it moves up a level, remembering where it came from.
        var episodeFolders = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < n; i++)
        {
            var s = split[i];
            if (roles[i] != LayoutRole.Video || s.Count < 2) continue;
            var folder = s[^2];
            if (ContentLayoutPolicy.IsStructural(folder) || s.Take(s.Count - 1).Any(ContentLayoutPolicy.IsProtected)) continue;
            var key = ContentLayoutPolicy.EpisodeKey(Path.GetFileNameWithoutExtension(s[^1]));
            if (key is not null && ContentLayoutPolicy.EpisodeKey(folder) == key) episodeFolders.Add(string.Join('/', s.Take(s.Count - 1)));
        }
        if (episodeFolders.Count > 0)
        {
            for (var i = 0; i < n; i++)
            {
                var s = split[i];
                var kept = new List<string>();
                for (var k = 0; k < s.Count - 1; k++)
                {
                    if (episodeFolders.Contains(string.Join('/', s.Take(k + 1)))) origin[i] = s[k];
                    else kept.Add(s[k]);
                }
                kept.Add(s[^1]);
                split[i] = kept;
            }
        }

        // Subtitles follow their video: one named after it, one in <video>/Subs/<video>/, or any in the Subs folder of a
        // release that holds exactly one video. Named `<video>.<name>` so a player pairs them.
        string Stem(int v) => Path.GetFileNameWithoutExtension(split[v][^1]);
        var videosByOrigin = Enumerable.Range(0, n).Where(i => roles[i] == LayoutRole.Video)
            .GroupBy(i => origin[i] ?? "", StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
        var attach = new (int Video, string Name)?[n];
        for (var i = 0; i < n; i++)
        {
            if (roles[i] != LayoutRole.Subtitle || !videosByOrigin.TryGetValue(origin[i] ?? "", out var videos)) continue;
            var s = split[i];
            var name = s[^1];
            var stem = Path.GetFileNameWithoutExtension(name);
            var named = videos.Where(v => stem.Equals(Stem(v), StringComparison.OrdinalIgnoreCase)
                || name.StartsWith(Stem(v) + ".", StringComparison.OrdinalIgnoreCase)).ToList();
            if (named.Count > 0)
            {
                attach[i] = (named.MaxBy(v => Stem(v).Length), name);
                continue;
            }
            var subsAt = s.Count < 2 ? -1 : s.FindLastIndex(s.Count - 2, s.Count - 1, ContentLayoutPolicy.IsSubsFolder);
            if (subsAt < 0) continue;
            var inner = subsAt < s.Count - 2 ? s[subsAt + 1] : null;
            var byFolder = inner is null ? [] : videos.Where(v => Stem(v).Equals(inner, StringComparison.OrdinalIgnoreCase)).ToList();
            var video = byFolder.Count == 1 ? byFolder[0] : videos.Count == 1 ? videos[0] : -1;
            if (video >= 0) attach[i] = (video, $"{Stem(video)}.{name}");
        }

        string Key(string p) => ContentLayoutPolicy.PhysicalKey(p, windows);
        var final = new string?[n];
        var used = new HashSet<string>(StringComparer.Ordinal);
        var relocated = new List<string>();
        var keptFiles = new List<string>();
        var keptVideos = 0;
        var attached = 0;
        var nested = new bool[n];

        foreach (var (i, p) in pinned ?? new Dictionary<int, string?>())
        {
            if (i < 0 || i >= n) return null;
            final[i] = p;
            if (p is not null) used.Add(Key(p));
        }

        bool TryTake(int i, string path, out string? reason)
        {
            reason = used.Contains(Key(path)) ? SameNameInTorrent : probe?.Invoke(i, path);
            if (reason is not null) return false;
            used.Add(Key(path));
            final[i] = path;
            return true;
        }

        void StayNested(int i, string wanted, string reason)
        {
            final[i] = native[i];
            used.Add(Key(native[i]));
            nested[i] = true;
            keptFiles.Add(native[i]);
            if (roles[i] == LayoutRole.Video) keptVideos++;
            logger?.LogWarning("[content-layout] keeping \"{Path}\" in its release folder — {Reason}", wanted, reason);
        }

        void PlaceExtra(int i)
        {
            var target = string.Join('/', split[i]);
            if (target == native[i]) { final[i] = native[i]; used.Add(Key(native[i])); return; }
            if (TryTake(i, target, out var reason)) return;
            if (Relocate(split[i], origin[i]) is { } alt && TryTake(i, alt, out _))
            {
                relocated.Add($"{target} → {alt}");
                logger?.LogInformation("[content-layout] \"{Path}\" would collide ({Reason}); moved it to \"{Alt}\"", target, reason, alt);
                return;
            }
            StayNested(i, target, reason!);
        }

        // Videos first: the content claims its place before any extra can take it.
        for (var i = 0; i < n; i++)
        {
            if (IsPinned(i) || roles[i] != LayoutRole.Video) continue;
            var target = string.Join('/', split[i]);
            if (target == native[i]) { final[i] = native[i]; used.Add(Key(native[i])); continue; }
            if (!TryTake(i, target, out var reason)) StayNested(i, target, reason!);
        }
        for (var i = 0; i < n; i++)
        {
            if (IsPinned(i) || roles[i] != LayoutRole.Subtitle) continue;
            if (attach[i] is { } a)
            {
                var videoAt = final[a.Video];
                // The video had to stay in its release folder: its subtitles stay with it.
                if (videoAt is null || nested[a.Video]) { PlaceExtraOrStay(i, videoAt is null); continue; }
                var slash = videoAt.LastIndexOf('/');
                var target = slash < 0 ? a.Name : videoAt[..(slash + 1)] + a.Name;
                if (target == native[i]) { final[i] = native[i]; used.Add(Key(native[i])); continue; }
                if (TryTake(i, target, out _)) { attached++; continue; }
            }
            PlaceExtra(i);
        }
        for (var i = 0; i < n; i++)
            if (!IsPinned(i) && roles[i] == LayoutRole.Extra) PlaceExtra(i);

        void PlaceExtraOrStay(int i, bool videoGone)
        {
            if (videoGone) { PlaceExtra(i); return; }
            final[i] = native[i];
            used.Add(Key(native[i]));
        }

        // Every file has exactly one place, no two collapse onto one path, and no file sits where another needs a folder.
        var paths = final.Select((p, i) => p ?? native[i]).ToList();
        if (paths.Any(p => p.Length == 0)) return null;
        var live = Enumerable.Range(0, n).Where(i => final[i] is not null).Select(i => Key(paths[i])).ToList();
        if (live.Distinct(StringComparer.Ordinal).Count() != live.Count) return null;
        var folders = live.SelectMany(k =>
        {
            var parts = k.Split('/');
            return Enumerable.Range(1, parts.Length - 1).Select(c => string.Join('/', parts.Take(c)));
        }).ToHashSet(StringComparer.Ordinal);
        if (live.Any(folders.Contains)) return null;

        if (!Enumerable.Range(0, n).Any(i => !IsPinned(i) && paths[i] != native[i])) return null;

        return new LayoutPlan(roots, renamed, paths)
        {
            Flattened = episodeFolders.Count,
            SubtitlesAttached = attached,
            Relocated = relocated,
            Kept = keptFiles,
            KeptVideos = keptVideos,
        };
    }

    /// <summary>
    /// A per-release name for an extra whose plain one is taken: <c>Sample/&lt;release&gt;/sample.mkv</c>, or
    /// <c>&lt;release&gt;.info.nfo</c> for a file that sits in the season folder itself.
    /// </summary>
    private static string? Relocate(IReadOnlyList<string> segments, string? origin)
    {
        if (string.IsNullOrWhiteSpace(origin)) return null;
        var parent = segments.Take(segments.Count - 1).ToList();
        if (parent.Count > 0 && !ContentLayoutPolicy.IsSeasonFolder(parent[^1])) return string.Join('/', [.. parent, origin, segments[^1]]);
        return string.Join('/', [.. parent, $"{origin}.{segments[^1]}"]);
    }
}
