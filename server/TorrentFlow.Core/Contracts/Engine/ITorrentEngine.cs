namespace TorrentFlow.Core.Contracts.Engine;

/// <summary>
/// The built-in torrent engine. Implemented by TorrentFlow.Engine; consumed by Library (grabs, automation)
/// and Media (streaming). All hashes are lowercase hex v1 info hashes.
/// </summary>
public interface ITorrentEngine
{
    /// <summary>
    /// Adds (or dedupes) a transfer. Kept downloads (<see cref="TorrentPurpose.Keep"/>) go through the
    /// chronological download queue unless <see cref="EngineAddRequest.Forced"/> is set; stream and prewarm
    /// adds always start immediately.
    /// </summary>
    Task<EngineAddResult> AddAsync(EngineAddRequest request, CancellationToken ct = default);

    Task<IReadOnlyList<EngineTorrentInfo>> ListAsync(CancellationToken ct = default);

    Task<EngineTorrentInfo?> GetAsync(string infoHash, CancellationToken ct = default);

    Task<EngineActionResult> PauseAsync(string infoHash, CancellationToken ct = default);

    Task<EngineActionResult> ResumeAsync(string infoHash, CancellationToken ct = default);

    Task<EngineActionResult> RemoveAsync(string infoHash, bool deleteFiles, CancellationToken ct = default);

    /// <summary>
    /// Removes several transfers as one delete, so a folder they share only with each other (a season) goes too.
    /// </summary>
    async Task<IReadOnlyList<(string Hash, EngineActionResult Result)>> RemoveManyAsync(
        IReadOnlyCollection<string> infoHashes, bool deleteFiles, CancellationToken ct = default)
    {
        var results = new List<(string, EngineActionResult)>();
        foreach (var hash in infoHashes) results.Add((hash, await RemoveAsync(hash, deleteFiles, ct)));
        return results;
    }

    /// <summary>Starts a queued (or paused) kept download now, past the active-download cap.</summary>
    Task<EngineActionResult> ForceAsync(string infoHash, CancellationToken ct = default);

    /// <summary>Selects which files transfer. Indices refer to <see cref="EngineTorrentInfo.Files"/>.</summary>
    Task<EngineActionResult> SelectFilesAsync(string infoHash, IReadOnlyCollection<int> fileIndices, CancellationToken ct = default);

    /// <summary>
    /// Opens a seekable read stream over one file of a transfer. While the transfer is live the pieces
    /// under the read position are prioritised and reads wait for them; a completed (parked) transfer is
    /// served straight from disk. <paramref name="fileIndexOrPath"/> is a file index ("0") or the
    /// file's torrent-relative path.
    /// </summary>
    Task<Stream> OpenFileStreamAsync(string infoHash, string fileIndexOrPath, CancellationToken ct = default);

    /// <summary>Bytes reserved by queued kept downloads that have not written anything yet.</summary>
    Task<long> QueuedReservedBytesAsync(CancellationToken ct = default);

    /// <summary>
    /// Hash-verified byte ranges of one file (file-relative, end exclusive), merged and ascending. Empty when the
    /// transfer is not live or has no metadata; a completed (parked) transfer reports the whole file.
    /// </summary>
    Task<IReadOnlyList<EngineByteRange>> GetDownloadedRangesAsync(string infoHash, int fileIndex, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<EngineByteRange>>([]);

    /// <summary>Raised once per transfer when it completes and its files are verified on disk.</summary>
    event EventHandler<EngineTorrentCompletedEventArgs>? TorrentCompleted;
}

public static class TorrentPurpose
{
    public const string Keep = "keep";
    public const string Stream = "stream";
    public const string Prewarm = "prewarm";
}

/// <summary>EngineTorrent.origin values.</summary>
public static class TorrentOrigin
{
    public const string User = "user";
    public const string Stream = "stream";
    public const string Prewarm = "prewarm";
    public const string Evicting = "evicting";

    public static string FromPurpose(string purpose) => purpose switch
    {
        TorrentPurpose.Stream => Stream,
        TorrentPurpose.Prewarm => Prewarm,
        _ => User,
    };

    /// <summary>Origins only promote (prewarm → stream → user); Play never demotes a kept download.</summary>
    public static int Rank(string? origin) => origin switch
    {
        User => 3,
        Stream => 2,
        Evicting => 1,
        _ => 0,
    };
}

/// <summary>EngineTorrent.status values written by the engine.</summary>
public static class EngineTorrentStatus
{
    public const string Downloading = "downloading";
    /// <summary>A kept download admitted but deliberately not loaded into the client (zero RAM).</summary>
    public const string Queued = "queued";
    public const string Paused = "paused";
    /// <summary>Completed, verified, and detached from the client while the files stay on disk.</summary>
    public const string Parked = "parked";
    public const string Error = "error";
    public const string Removed = "removed";
}

public sealed record EngineAddRequest
{
    public string? Magnet { get; init; }
    public string? TorrentUrl { get; init; }
    /// <summary>Raw .torrent bytes, when the caller already has them.</summary>
    public byte[]? TorrentBytes { get; init; }
    /// <summary>40-char hex or 32-char base32 info hash; turned into a magnet with public trackers.</summary>
    public string? InfoHash { get; init; }
    public string? Name { get; init; }
    public required string Purpose { get; init; }
    public string? Category { get; init; }
    public string? SavePath { get; init; }
    /// <summary>Smart-target hints (resolveSmartSendTarget) used when no SavePath is given.</summary>
    public string? SearchCategory { get; init; }
    public TorrentFlow.Core.Contracts.Metadata.MediaMetadata? Metadata { get; init; }
    public string? Source { get; init; }
    public IReadOnlyList<string>? Tags { get; init; }
    /// <summary>Trust <see cref="Category"/> as the owner's manual choice instead of the smart label.</summary>
    public bool CategoryManual { get; init; }
    /// <summary>Sortable episode position ("s00001e00002").</summary>
    public string? QueueKey { get; init; }
    public string? WorkId { get; init; }
    /// <summary>Known release size, reserved against the storage budget while queued.</summary>
    public long? ExpectedSizeBytes { get; init; }
    /// <summary>The owner pressed Download now: start past the cap. Never set by automation.</summary>
    public bool Forced { get; init; }
    /// <summary>The owner saw an overridable storage refusal (cap/reserve) and chose to proceed. Never bypasses wont-fit or setup.</summary>
    public bool OverrideStorageCap { get; init; }
}

public sealed record EngineAddResult(bool Ok, string Message, EngineAddDetails? Details = null, string? Hash = null)
{
    /// <summary>Set when a storage limit refused the add: setup | inventory | cap | reserve | wont-fit.</summary>
    public string? StorageLimit { get; init; }
}

/// <summary>Mirrors the TypeScript AddTorrentDetails "builtin-transfer" variant.</summary>
public sealed record EngineAddDetails(string Action, double Pct, int Peers, int? QueuePosition = null)
{
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1822:Mark members as static",
        Justification = "This instance property is part of the serialized HTTP contract.")]
    public string Type => "builtin-transfer";

    public const string Started = "started";
    public const string AlreadyDownloading = "already_downloading";
    public const string AlreadyComplete = "already_complete";
    public const string Queued = "queued";
}

public sealed record EngineActionResult(bool Ok, string Message);

/// <summary>A transfer as the UI sees it; serialises to the Next.js ClientTorrent shape.</summary>
public sealed record EngineTorrentInfo
{
    public required string Hash { get; init; }
    public required string Name { get; init; }
    /// <summary>0..1.</summary>
    public double Progress { get; init; }
    public long SizeBytes { get; init; }
    public long Dlspeed { get; init; }
    public long Upspeed { get; init; }
    /// <summary>downloaded | downloading | stalledDL | metaDL | checkingDL | paused | queued | error</summary>
    public required string State { get; init; }
    public long? Eta { get; init; }
    public int? Peers { get; init; }
    public string? Error { get; init; }
    public bool? Playable { get; init; }
    public string? Category { get; init; }
    public string? SavePath { get; init; }
    /// <summary>kept | stream | prewarm | unknown</summary>
    public string? RetentionState { get; init; }
    public int? QueuePosition { get; init; }
    public string? WorkId { get; init; }
    public string? QueueKey { get; init; }
    public IReadOnlyList<EngineFileInfo>? Files { get; init; }
    /// <summary>Shareable magnet built server-side: the transfer's own trackers plus the public list (never for private torrents).</summary>
    public string? Magnet { get; init; }
    /// <summary>Payload bytes received from peers this session (live transfers only). Not part of the UI shape.</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public long? BytesReceived { get; init; }
}

public sealed record EngineFileInfo(int Index, string Path, long Length, bool Selected, double Progress, string? FullPath = null);

/// <summary>A file-relative byte range; <see cref="End"/> is exclusive.</summary>
public sealed record EngineByteRange(long Start, long End);

public sealed class EngineTorrentCompletedEventArgs(string hash, string name, string? savePath, string origin) : EventArgs
{
    public string Hash { get; } = hash;
    public string Name { get; } = name;
    public string? SavePath { get; } = savePath;
    public string Origin { get; } = origin;
}
