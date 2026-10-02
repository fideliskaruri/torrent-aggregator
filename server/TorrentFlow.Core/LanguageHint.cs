namespace TorrentFlow.Core;

/// <summary>
/// What an index tells about a release's files before anything downloads (docs/release-language.md, "Hints before
/// download"): AnimeTosho's per-file track lists, or a site's file list (apibay). A hint only orders releases and lets an
/// automatic pick skip one that clearly has no English; the files themselves decide once they are here.
/// </summary>
/// <param name="Source"><see cref="AnimeTosho"/> or <see cref="FileList"/>.</param>
public sealed record LanguageHint(string Source, IReadOnlyList<LanguageHintFile> Files)
{
    public const string AnimeTosho = "animetosho";
    public const string FileList = "filelist";

    /// <summary>The tracks the index listed for its file at <paramref name="index"/>, as the judge reads them
    /// (<see cref="TrackFact.Indexer"/>); null when it lists only names.</summary>
    public IEnumerable<TrackFact>? TracksOf(int index) =>
        index >= 0 && index < Files.Count && Files[index].Tracks is { } tracks ? tracks.Select(t => TrackFact.From(t, TrackFact.Indexer)) : null;
}

/// <param name="Path">The file's path inside the torrent, folders included.</param>
/// <param name="Tracks">The file's own audio and subtitle tracks as the index read them (<see cref="MediaTrack.Indexer"/>);
/// null when the index lists only names.</param>
public sealed record LanguageHintFile(string Path, long Size, IReadOnlyList<MediaTrack>? Tracks = null);
